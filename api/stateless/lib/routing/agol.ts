import { fetch } from '@tak-ps/node-safeurl';
import Err from '@openaddresses/batch-error';
import Config from '../../../common/config.js';
import { EsriSpatialReference, EsriExtent } from '../esri/types.js';
import { randomUUID } from 'node:crypto';
import { Static, Type } from '@sinclair/typebox';
import { Feature } from '@tak-ps/node-cot';
import { CoTParser } from '@tak-ps/node-cot';
import ArcGISTokenManager from '../search/arcgis-token-manager.js';
import arcgisSettings from '../search/arcgis-settings.js';
import { RouteInterface, RouteOptions } from '../interface-route.js';
import { RouteConfig } from './types.js';
import {
    fetchNZTAEvents,
    inNewZealand,
    planClosures,
    describeOutcome,
} from './nzta-events.js';
import type { ClosureBarriers, DetourState, NZTAEvent } from './nzta-events.js';

export const AGOLRouteContainer = Type.Object({
    checksum: Type.Optional(Type.String()),
    requestID: Type.Optional(Type.String()),
    error: Type.Optional(Type.Object({
        code: Type.Number(),
        message: Type.String(),
    })),
    routes: Type.Optional(Type.Object({
        fieldAliases: Type.Optional(Type.Object({})),
        geometryType: Type.Optional(Type.String()),
        spatialReference: Type.Optional(EsriSpatialReference),
        fields: Type.Optional(Type.Array(Type.Object({
            name: Type.String(),
            type: Type.String(),
            alias: Type.String(),
            length: Type.Optional(Type.Integer()),
        }))),
        features: Type.Optional(Type.Array(Type.Object({
            attributes: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
            geometry: Type.Optional(Type.Object({
                paths: Type.Optional(Type.Array(Type.Array(Type.Array(Type.Number())))),
            })),
        }))),
    })),
    directions: Type.Optional(Type.Array(Type.Object({
        routeId: Type.Optional(Type.Integer()),
        routeName: Type.Optional(Type.String()),
        summary: Type.Optional(Type.Object({
            totalLength: Type.Optional(Type.Number()),
            totalTime: Type.Optional(Type.Number()),
            totalDriveTime: Type.Optional(Type.Number()),
            envelope: Type.Optional(EsriExtent),
        })),
        features: Type.Optional(Type.Array(Type.Object({
            attributes: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
            compressedGeometry: Type.Optional(Type.String()),
            strings: Type.Optional(Type.Array(Type.Object({
                string: Type.String(),
                stringType: Type.String(),
            }))),
        }))),
    }))),
});

const AGOLAttributeParameterValue = Type.Object({
    attributeName: Type.String(),
    parameterName: Type.String(),
    value: Type.Union([
        Type.String(),
        Type.Number(),
    ]),
});

const AGOLSupportedTravelMode = Type.Object({
    attributeParameterValues: Type.Array(AGOLAttributeParameterValue),
    description: Type.String(),
    distanceAttributeName: Type.String(),
    id: Type.String(),
    impedanceAttributeName: Type.String(),
    name: Type.String(),
    restrictionAttributeNames: Type.Array(Type.String()),
    simplificationTolerance: Type.Number(),
    simplificationToleranceUnits: Type.Literal('esriMeters'),
    timeAttributeName: Type.String(),
    type: Type.Enum({
        AUTOMOBILE: 'AUTOMOBILE',
        TRUCK: 'TRUCK',
        WALK: 'WALK',
    }),
    useHierarchy: Type.Boolean(),
    uturnAtJunctions: Type.Enum({
        esriNFSBAtDeadEndsAndIntersections: 'esriNFSBAtDeadEndsAndIntersections',
        esriNFSBNoBacktrack: 'esriNFSBNoBacktrack',
        esriNFSBAllowBacktrack: 'esriNFSBAllowBacktrack',
    }),
});

export default class AGOLRoute implements RouteInterface {
    _id: string;
    _name: string;
    _config: Config;

    routingApi: string;
    routingApiModes: string;

    // Store ID => Travel Mode Object
    routeModes: Map<string, Static<typeof AGOLSupportedTravelMode>>;

    tokenManager?: ArcGISTokenManager;

    constructor(
        config: Config,
        tokenManager?: ArcGISTokenManager,
    ) {
        this._id = 'agol';
        this._name = 'ArcGIS Online';
        this._config = config;

        this.routeModes = new Map();

        this.routingApi = 'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve';
        this.routingApiModes = 'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/retrieveTravelModes';

        this.tokenManager = tokenManager;
    }

    static async init(config: Config): Promise<AGOLRoute | null> {
        const settings = await arcgisSettings(config, 'routing');

        if (!settings) return null;

        const agol = new AGOLRoute(config, new ArcGISTokenManager(settings));

        await agol.setRouteModes();

        return agol;
    }

    config(): Promise<Static<typeof RouteConfig>> {
        return Promise.resolve({
            id: this._id,
            name: this._name,
            modes: Array.from(this.routeModes.values()).map(mode => ({
                id: mode.id,
                name: mode.name,
            })),
        });
    }

    async setRouteModes(): Promise<void> {
        const url = new URL(this.routingApiModes);
        url.searchParams.append('f', 'json');

        if (this.tokenManager) {
            const token = await this.tokenManager.getValidToken();
            if (token) url.searchParams.append('token', token);
        }

        const res = await fetch(url);

        const body = await res.typed(Type.Union([
            Type.Object({
                error: Type.Object({
                    code: Type.Number(),
                    message: Type.String(),
                }),
            }),
            Type.Object({
                currentVersion: Type.Number(),
                defaultTravelMode: Type.String(),
                supportedTravelModes: Type.Array(AGOLSupportedTravelMode),
            }),
        ]));

        if ('error' in body) {
            if (body.error.code === 498 || body.error.code === 499) {
                throw new Error('API not authorized');
            }

            throw new Error(`ArcGIS Routing Error: ${body.error.message}`);
        }

        for (const mode of body.supportedTravelModes) {
            this.routeModes.set(mode.id, mode);
        }
    }

    /**
     * Solve a route. With barriers the request is a POST, as polyline barriers can be too long for a query string.
     * Rejects with 'No Route Found' when ArcGIS finds none.
     */
    async solve(
        stops: Array<[number, number]>,
        travelMode?: string,
        barriers?: ClosureBarriers,
    ): Promise<Static<typeof AGOLRouteContainer>> {
        const params = new URLSearchParams();
        params.append('stops', stops.map(stop => stop.join(',')).join(';'));
        params.append('f', 'json');

        if (travelMode) {
            const mode = this.routeModes.get(travelMode);

            if (!mode) throw new Err(400, null, `Travel Mode not found`);

            params.append('travelMode', JSON.stringify(mode));
        }

        if (barriers?.points.length) {
            params.append('barriers', barriers.points.map(point => point.join(',')).join(';'));
        }

        if (barriers?.lines.length) {
            params.append('polylineBarriers', JSON.stringify({
                spatialReference: { wkid: 4326 },
                features: barriers.lines.map(line => ({
                    geometry: { paths: [line], spatialReference: { wkid: 4326 } },
                })),
            }));
        }

        if (this.tokenManager) {
            const token = await this.tokenManager.getValidToken();
            if (token) params.append('token', token);
        }

        let res;
        if (barriers) {
            res = await fetch(this.routingApi, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
            });
        } else {
            const url = new URL(this.routingApi);
            url.search = params.toString();
            res = await fetch(url);
        }

        const body = await res.typed(AGOLRouteContainer);

        // Check for API errors first
        if (body.error) {
            if (body.error.code === 498 || body.error.code === 499) {
                throw new Error('API not authorized');
            }
            throw new Error(`ArcGIS Routing Error: ${body.error.message}`);
        }

        // Check for routing errors
        if (!body.routes || !body.routes.features || body.routes.features.length === 0) {
            throw new Error('No Route Found');
        }

        return body;
    }

    /** Does the travel mode drive on roads? NZTA closures are meaningless to a pedestrian route. */
    private isDrivingMode(travelMode?: string): boolean {
        if (!travelMode) return true;
        const type = this.routeModes.get(travelMode)?.type;
        return type === 'AUTOMOBILE' || type === 'TRUCK';
    }

    async route(
        stops: Array<[number, number]>,
        travelMode?: string,
        opts: RouteOptions = {},
    ): Promise<Static<typeof Feature.FeatureCollection>> {
        const useNZTA = !!opts.nzta && inNewZealand(stops) && this.isDrivingMode(travelMode);

        // Fetched while ArcGIS solves. A failure must never stop the route being returned.
        const eventsRequest: Promise<NZTAEvent[] | null> | undefined = useNZTA
            ? fetchNZTAEvents().catch((err: unknown) => {
                    console.error('NZTA events unavailable:', err instanceof Error ? err.message : err);
                    return null;
                })
            : undefined;

        const direct = await this.solve(stops, travelMode);
        let body = direct;
        let nzta = '';

        if (eventsRequest) {
            const events = await eventsRequest;
            const directFeature = direct.routes?.features?.[0];
            const directPath = directFeature?.geometry?.paths?.[0];

            if (directFeature && directPath) {
                const directSummary = {
                    km: Number(directFeature.attributes?.Total_Kilometers) || 0,
                    minutes: Number(directFeature.attributes?.Total_TravelTime) || 0,
                };

                const now = new Date();
                const window = { start: now, end: new Date(now.getTime() + directSummary.minutes * 60_000) };

                let detour: DetourState = 'found';
                let finalFeature = directFeature;
                const plan = events ? planClosures(events, directPath, window) : null;

                if (plan) {
                    try {
                        body = await this.solve(stops, travelMode, plan.barriers);
                        finalFeature = body.routes?.features?.[0] ?? directFeature;
                    } catch (err) {
                        if (err instanceof Error && err.message === 'API not authorized') throw err;

                        // Either there is no way round, or ArcGIS refused the barriers. The direct route is still returned.
                        console.error('NZTA closure detour failed:', err instanceof Error ? err.message : err);
                        detour = err instanceof Error && err.message === 'No Route Found' ? 'none' : 'failed';
                    }
                }

                nzta = describeOutcome({
                    events,
                    window,
                    direct: directSummary,
                    final: {
                        km: Number(finalFeature.attributes?.Total_Kilometers) || 0,
                        minutes: Number(finalFeature.attributes?.Total_TravelTime) || 0,
                    },
                    finalPath: finalFeature.geometry?.paths?.[0] ?? null,
                    blocking: plan?.blocking ?? [],
                    detour,
                });
            }
        }

        const processed: Static<typeof Feature.FeatureCollection> = {
            type: 'FeatureCollection',
            features: [],
        };

        if (body.routes?.features) {
            for (const feat of body.routes.features) {
                if (!feat.geometry?.paths?.[0] || !feat.attributes) continue;

                const norm = await CoTParser.normalize_geojson({
                    id: String(randomUUID()),
                    type: 'Feature',
                    properties: {
                        metadata: {
                            ...feat.attributes,
                        },
                    },
                    geometry: {
                        type: 'LineString',
                        coordinates: feat.geometry.paths[0],
                    },
                });

                norm.properties.type = 'b-m-r';
                norm.properties.how = 'm-g';
                norm.properties.callsign = String(feat.attributes.Name);
                norm.properties.archived = true;

                // Add directions as remarks if available
                const directions = body.directions?.[0]?.features?.map(dir => dir.attributes?.text).filter(Boolean).join('\n');
                const remarks = [nzta, directions].filter(Boolean).join('\n\n');
                if (remarks) norm.properties.remarks = remarks;

                processed.features.push(norm);
            }
        }

        return processed;
    }
}
