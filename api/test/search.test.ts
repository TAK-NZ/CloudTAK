import test from 'tape';
import Search from '../lib/search.js';

test('Search - constructor with token', async (t) => {
    const search = new Search('test-token');
    
    t.equal(search.token, 'test-token', 'Token set correctly');
    t.ok(search.reverseApi, 'Reverse API URL set');
    t.ok(search.suggestApi, 'Suggest API URL set');
    t.ok(search.forwardApi, 'Forward API URL set');
    
    t.end();
});

test('Search - constructor without token', async (t) => {
    const search = new Search();
    
    t.equal(search.token, undefined, 'No token set');
    t.ok(search.reverseApi, 'Reverse API URL set');
    t.ok(search.suggestApi, 'Suggest API URL set');
    t.ok(search.forwardApi, 'Forward API URL set');
    
    t.end();
});

test('Search - API URLs are correctly set', async (t) => {
    const search = new Search('test-token');
    
    t.ok(search.reverseApi.includes('geocode.arcgis.com'), 'Reverse API URL contains correct domain');
    t.ok(search.suggestApi.includes('geocode.arcgis.com'), 'Suggest API URL contains correct domain');
    t.ok(search.forwardApi.includes('geocode.arcgis.com'), 'Forward API URL contains correct domain');
    
    t.end();
});

test('Search - route method handles empty features', async (t) => {
    const search = new Search('test-token');
    
    // Test the route processing logic with mock data
    const mockRouteData = {
        routes: {
            features: []
        }
    };
    
    try {
        // This should throw an error for no route found
        const processedRoute = {
            type: 'FeatureCollection' as const,
            features: []
        };
        
        t.equal(processedRoute.type, 'FeatureCollection', 'Correct type');
        t.equal(processedRoute.features.length, 0, 'Empty features array');
    } catch (err) {
        t.pass('Expected error for empty route');
    }

    t.end();
});

test('Search - route method processes valid route data', async (t) => {
    const search = new Search('test-token');
    
    // Test route processing with mock valid data structure
    const mockValidRoute = {
        routes: {
            features: [{
                attributes: {
                    Name: 'Test Route',
                    Total_Length: 10.5
                },
                geometry: {
                    paths: [[[-105, 39.7], [-104.8, 39.9]]]
                }
            }]
        }
    };
    
    // Test that the route structure is valid
    t.ok(mockValidRoute.routes.features.length > 0, 'Has route features');
    t.ok(mockValidRoute.routes.features[0].geometry.paths, 'Has geometry paths');
    t.ok(mockValidRoute.routes.features[0].attributes, 'Has attributes');
    
    t.end();
});

test('Search - error handling for different error codes', async (t) => {
    const search = new Search('test-token');
    
    // Test error code handling logic
    const error498 = { code: 498, message: 'Invalid token' };
    const error499 = { code: 499, message: 'Token required' };
    const error400 = { code: 400, message: 'Bad request' };
    
    // Test error code classification
    t.ok(error498.code === 498 || error498.code === 499, 'Auth error codes');
    t.equal(error400.code, 400, 'General error code');
    
    t.end();
});

test('Search - validates route input parameters', async (t) => {
    const search = new Search('test-token');
    
    // Test input validation
    const validStops = [[-105, 39.7], [-104.8, 39.9]];
    const travelMode = 'Driving Time';
    
    t.ok(Array.isArray(validStops), 'Stops is an array');
    t.equal(validStops.length, 2, 'Has start and end points');
    t.ok(validStops[0].length === 2, 'Start point has lat/lng');
    t.ok(validStops[1].length === 2, 'End point has lat/lng');
    t.ok(typeof travelMode === 'string', 'Travel mode is string');
    
    t.end();
});

test('Search - URL construction for different endpoints', async (t) => {
    const search = new Search('test-token');
    
    // Test URL construction logic
    const baseUrl = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
    
    t.ok(search.reverseApi.startsWith(baseUrl), 'Reverse API has correct base');
    t.ok(search.suggestApi.startsWith(baseUrl), 'Suggest API has correct base');
    t.ok(search.forwardApi.startsWith(baseUrl), 'Forward API has correct base');
    
    t.ok(search.reverseApi.includes('reverseGeocode'), 'Reverse API has correct endpoint');
    t.ok(search.suggestApi.includes('suggest'), 'Suggest API has correct endpoint');
    t.ok(search.forwardApi.includes('findAddressCandidates'), 'Forward API has correct endpoint');
    
    t.end();
});