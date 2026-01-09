import { ForceDelete } from '@tak-ps/node-cot';
import type Config from './config.js';

/**
 * Reaper Service - Automatically cleans up stale polygons and lines
 * 
 * TAK clients automatically remove stale Point features, but Polygons and LineStrings
 * are treated as "static data" and remain visible indefinitely. This service monitors
 * the connection_features table and sends ForceDelete messages when polygons/lines
 * become stale.
 * 
 * This is an interim solution with no schema changes. Retries are handled via
 * setTimeout and will be lost on restart (acceptable trade-off for simplicity).
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
        
        console.log(`ok - Reaper service started (interval: ${interval}ms)`);
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
                    AND (properties->>'stale')::timestamptz < NOW() - INTERVAL ${bufferSeconds} seconds
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
            
            const deleteMsg = new ForceDelete(uid);
            
            console.log(`Reaper: Force-deleting stale feature ${uid} from connection ${connection}`);
            
            pooledClient.tak.write([deleteMsg]);
            await this.config.conns.cots(pooledClient.config, [deleteMsg]);
            
            // Schedule retries for offline clients (T+5m, T+15m)
            // Note: These are lost on restart, but acceptable for interim solution
            setTimeout(async () => {
                try {
                    const client = await this.config.conns.get(connection);
                    if (client?.config.enabled) {
                        client.tak.write([new ForceDelete(uid)]);
                    }
                } catch (err) {
                    console.error(`Reaper retry (T+5m) failed for ${uid}:`, err);
                }
            }, 5 * 60 * 1000);
            
            setTimeout(async () => {
                try {
                    const client = await this.config.conns.get(connection);
                    if (client?.config.enabled) {
                        client.tak.write([new ForceDelete(uid)]);
                    }
                } catch (err) {
                    console.error(`Reaper retry (T+15m) failed for ${uid}:`, err);
                }
            }, 15 * 60 * 1000);
        } catch (err) {
            console.error(`Reaper: Failed to send ForceDelete for ${uid}:`, err);
        }
    }
    
    async close(): Promise<void> {
        clearInterval(this.sweepInterval);
        console.log('ok - Reaper service stopped');
    }
}
