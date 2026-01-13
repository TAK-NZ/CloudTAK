import CoT from '@tak-ps/node-cot';
import type Config from './config.js';

/**
 * Reaper Service - Automatically cleans up stale polygons and lines
 * 
 * TAK clients automatically remove stale Point features, but Polygons and LineStrings
 * are treated as "static data" and remain visible indefinitely. This service monitors
 * the connection_features table and sends ForceDelete messages when polygons/lines
 * become stale.
 * 
 * The t-x-d-d messages are sent with a configurable stale time (default 30 days)
 * so TAK Server persists them and delivers to offline clients when they reconnect.
 */
export default class Reaper {
    config: Config;
    sweepInterval: ReturnType<typeof setInterval>;
    
    constructor(config: Config) {
        this.config = config;
        
        const interval = parseInt(process.env.REAPER_INTERVAL || '60') * 1000;
        
        this.sweepInterval = setInterval(() => {
            this.sweep().catch(err => console.error('Reaper sweep error:', err));
        }, interval);
        
        console.error(`ok - Reaper service started (interval: ${interval}ms)`);
    }
    
    async sweep(): Promise<void> {
        const batchSize = parseInt(process.env.REAPER_BATCH_SIZE || '100');
        const bufferSeconds = parseInt(process.env.REAPER_BUFFER || '30');
        
        try {
            // @ts-expect-error session.client not in types but exists
            const client = this.config.pg.session.client;
            
            const result = await client`
                SELECT 
                    connection,
                    id
                FROM connection_features
                WHERE 
                    properties->>'stale' IS NOT NULL
                    AND (properties->>'stale')::timestamptz < NOW() - (${bufferSeconds}::text || ' seconds')::interval
                    AND ST_GeometryType(geometry) IN (
                        'ST_Polygon', 
                        'ST_LineString', 
                        'ST_MultiPolygon', 
                        'ST_MultiLineString'
                    )
                LIMIT ${batchSize}
            `;
            
            if (result.length > 0) {
                console.log(`Reaper: Found ${result.length} stale features to clean up`);
            }
            
            for (const feat of result) {
                await this.sendForceDelete(feat.connection, feat.id);
                
                await client`
                    DELETE FROM connection_features 
                    WHERE connection = ${feat.connection} AND id = ${feat.id}
                `;
            }
        } catch (err) {
            console.error('Reaper sweep failed:', err);
        }
    }
    
    async sendForceDelete(connection: number, uid: string): Promise<void> {
        try {
            const pooledClient = await this.config.conns.get(connection);
            if (!pooledClient?.config.enabled) return;
            
            const staleDays = parseInt(process.env.REAPER_STALE_DAYS || '30');
            const now = new Date();
            const staleDate = new Date(now.getTime() + staleDays * 24 * 60 * 60 * 1000);
            
            const deleteMsg = new CoT({
                event: {
                    _attributes: {
                        version: '2.0',
                        uid: uid,
                        type: 't-x-d-d',
                        how: 'm-g',
                        time: now.toISOString(),
                        start: now.toISOString(),
                        stale: staleDate.toISOString()
                    },
                    point: {
                        _attributes: {
                            lat: '0.0',
                            lon: '0.0',
                            hae: '0.0',
                            ce: '9999999',
                            le: '9999999'
                        }
                    },
                    detail: {
                        link: {
                            _attributes: {
                                uid: uid,
                                type: 'none',
                                relation: 'none'
                            }
                        },
                        __forcedelete: {}
                    }
                }
            });
            
            console.log(`Reaper: Force-deleting stale feature ${uid} from connection ${connection} (stale=${staleDays}d)`);
            
            pooledClient.tak.write([deleteMsg]);
            await this.config.conns.cots(pooledClient.config, [deleteMsg]);
        } catch (err) {
            console.error(`Reaper: Failed to send ForceDelete for ${uid}:`, err);
        }
    }
    
    async close(): Promise<void> {
        clearInterval(this.sweepInterval);
        console.log('ok - Reaper service stopped');
    }
}
