import fetch from './fetch.js';
import { randomUUID } from 'node:crypto';
import { Static, Type } from "@sinclair/typebox";
import { EsriExtent, EsriSpatialReference } from './esri/types.js';
import { Feature } from '@tak-ps/node-cot';
import { CoTParser } from '@tak-ps/node-cot';

export const FetchReverse = Type.Object({
    LongLabel: Type.String(),
    ShortLabel: Type.String(),
    Addr_type: Type.String(),
});

const ReverseContainer = Type.Object({
    address: FetchReverse
});

export const RouteContainer = Type.Object({
    checksum: Type.Optional(Type.String()),
    requestID: Type.Optional(Type.String()),
    error: Type.Optional(Type.Object({
        code: Type.Number(),
        message: Type.String()
    })),
    routes: Type.Optional(Type.Object({
        fieldAliases: Type.Optional(Type.Object({})),
        geometryType: Type.Optional(Type.String()),
        spatialReference: Type.Optional(EsriSpatialReference),
        fields: Type.Optional(Type.Array(Type.Object({
            name: Type.String(),
            type: Type.String(),
            alias: Type.String(),
            length: Type.Optional(Type.Integer())
        }))),
        features: Type.Optional(Type.Array(Type.Object({
            attributes: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
            geometry: Type.Optional(Type.Object({
                paths: Type.Optional(Type.Array(Type.Array(Type.Array(Type.Number()))))
            }))
        }))),
    })),
    directions: Type.Optional(Type.Array(Type.Object({
        routeId: Type.Optional(Type.Integer()),
        routeName: Type.Optional(Type.String()),
        summary: Type.Optional(Type.Object({
            totalLength: Type.Optional(Type.Number()),
            totalTime: Type.Optional(Type.Number()),
            totalDriveTime: Type.Optional(Type.Number()),
            envelope: Type.Optional(EsriExtent)
        })),
        features: Type.Optional(Type.Array(Type.Object({
            attributes: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
            compressedGeometry: Type.Optional(Type.String()),
            strings: Type.Optional(Type.Array(Type.Object({
                string: Type.String(),
                stringType: Type.String()
            })))
        })))
    })))
});

export const FetchSuggest = Type.Object({
    text: Type.String(),
    magicKey: Type.String(),
    isCollection: Type.Boolean()
});

export const SuggestContainer = Type.Object({
    suggestions: Type.Optional(Type.Array(FetchSuggest)),
    error: Type.Optional(Type.Object({
        code: Type.Number(),
        message: Type.String()
    }))
});

export const FetchForward = Type.Object({
    address: Type.String(),
    location: Type.Object({
        x: Type.Number(),
        y: Type.Number(),
    }),
    score: Type.Number(),
    attributes: Type.Object({
        LongLabel: Type.Optional(Type.String()),
        ShortLabel: Type.Optional(Type.String()),
    }),
    extent: EsriExtent
});

export const ForwardContainer = Type.Object({
    candidates: Type.Array(FetchForward)
});

export default class Geocode {
    reverseApi: string;
    suggestApi: string;
    forwardApi: string;
    token?: string;

    constructor(token?: string) {
        this.reverseApi = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode';
        this.suggestApi = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest';
        this.forwardApi = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
        this.token = token;
    }

    async reverse(lon: number, lat: number): Promise<Static<typeof FetchReverse>> {
        const url = new URL(this.reverseApi)
        url.searchParams.append('location', `${lon},${lat}`);
        url.searchParams.append('f', 'json');
        if (this.token) url.searchParams.append('apikey', this.token);

        const res = await fetch(url);

        const body = await res.typed(ReverseContainer)

        return body.address;
    }

    async route(
        stops: Array<[number, number]>,
        travelMode?: string
    ): Promise<Static<typeof Feature.FeatureCollection>> {
        const url = new URL('https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve');
        
        const formData = new URLSearchParams();
        formData.append('f', 'json');
        formData.append('stops', stops.map(stop => stop.join(',')).join(';'));
        if (travelMode && travelMode.trim()) formData.append('travelMode', travelMode);
        if (this.token) formData.append('token', this.token);

        const res = await fetch(url, {
            method: 'POST',
            body: formData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const body = await res.typed(RouteContainer)

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

        const processed: Static<typeof Feature.FeatureCollection> = {
            type: 'FeatureCollection',
            features: []
        }

        if (body.routes?.features) {
            for (const feat of body.routes.features) {
                if (!feat.geometry?.paths?.[0] || !feat.attributes) continue;
                const norm = await CoTParser.normalize_geojson({
                    id: String(randomUUID()),
                    type: 'Feature',
                    properties: {
                        metadata: {
                            ...feat.attributes,
                        }
                    },
                    geometry: {
                        type: 'LineString',
                        coordinates: feat.geometry.paths[0]
                    }
                });

                norm.properties.type = 'b-m-r';
                norm.properties.how = 'm-g';
                norm.properties.callsign = String(feat.attributes.Name);
                norm.properties.archived = true;

                processed.features.push(norm);
            }
        }

        return processed;
    }

    async forward(query: string, magicKey: string, limit?: number): Promise<Array<Static<typeof FetchForward>>> {
        const url = new URL(this.forwardApi)
        url.searchParams.append('magicKey', magicKey);
        url.searchParams.append('singleLine', query);
        if (limit) url.searchParams.append('maxLocations', String(limit));
        if (this.token) url.searchParams.append('apikey', this.token);
        url.searchParams.append('f', 'json');

        const res = await fetch(url);

        const body = await res.typed(ForwardContainer)

        return body.candidates;
    }

    async suggest(query: string, limit?: number, location?: [number, number]): Promise<Array<Static<typeof FetchSuggest>>> {
        const url = new URL(this.suggestApi)
        url.searchParams.append('text', query);
        url.searchParams.append('f', 'json');
        if (limit) url.searchParams.append('maxSuggestions', String(limit));
        if (location) url.searchParams.append('location', `${location[0]},${location[1]}`);
        if (this.token) url.searchParams.append('apikey', this.token);

        const res = await fetch(url);

        const body = await res.typed(SuggestContainer)

        if (body.error) {
            throw new Error(`ArcGIS API Error: ${body.error.message}`);
        }

        return body.suggestions || [];
    }
}
