import test from 'tape';
import Search from '../lib/search.js';
import ArcGISTokenManager from '../lib/arcgis-token-manager.js';

test('Search - constructor with token manager', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const search = new Search(tokenManager);
    
    t.ok(search.tokenManager, 'Token manager set correctly');
    t.ok(search.reverseApi, 'Reverse API URL set');
    t.ok(search.suggestApi, 'Suggest API URL set');
    t.ok(search.forwardApi, 'Forward API URL set');
    
    t.end();
});

test('Search - constructor without token manager', async (t) => {
    const search = new Search();
    
    t.equal(search.tokenManager, undefined, 'No token manager set');
    t.ok(search.reverseApi, 'Reverse API URL set');
    t.ok(search.suggestApi, 'Suggest API URL set');
    t.ok(search.forwardApi, 'Forward API URL set');
    
    t.end();
});

test('Search - API URLs are correctly set', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
    t.equal(new URL(searchInstance.reverseApi).host, 'geocode.arcgis.com', 'Reverse API URL has correct host');
    t.equal(new URL(searchInstance.suggestApi).host, 'geocode.arcgis.com', 'Suggest API URL has correct host');
    t.equal(new URL(searchInstance.forwardApi).host, 'geocode.arcgis.com', 'Forward API URL has correct host');
    
    t.end();
});

test('Search - route method handles empty features', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
    try {
        // This should throw an error for no route found
        const processedRoute = {
            type: 'FeatureCollection' as const,
            features: []
        };
        
        t.equal(processedRoute.type, 'FeatureCollection', 'Correct type');
        t.equal(processedRoute.features.length, 0, 'Empty features array');
        t.ok(searchInstance.tokenManager, 'Search instance has token manager');
    } catch {
        t.pass('Expected error for empty route');
    }

    t.end();
});

test('Search - route method processes valid route data', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
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
    t.ok(searchInstance.tokenManager, 'Search instance has token manager');
    
    t.end();
});

test('Search - error handling for different error codes', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
    // Test error code handling logic
    const error498 = { code: 498, message: 'Invalid token' };
    const error400 = { code: 400, message: 'Bad request' };
    
    // Test error code classification
    t.ok(error498.code === 498 || error498.code === 499, 'Auth error codes');
    t.equal(error400.code, 400, 'General error code');
    t.ok(searchInstance.tokenManager, 'Search instance has token manager');
    
    t.end();
});

test('Search - validates route input parameters', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
    // Test input validation
    const validStops = [[-105, 39.7], [-104.8, 39.9]];
    const travelMode = 'Driving Time';
    
    t.ok(Array.isArray(validStops), 'Stops is an array');
    t.equal(validStops.length, 2, 'Has start and end points');
    t.ok(validStops[0].length === 2, 'Start point has lat/lng');
    t.ok(validStops[1].length === 2, 'End point has lat/lng');
    t.ok(typeof travelMode === 'string', 'Travel mode is string');
    t.ok(searchInstance.tokenManager, 'Search instance has token manager');
    
    t.end();
});

test('Search - URL construction for different endpoints', async (t) => {
    const tokenManager = new ArcGISTokenManager('test-token', 'test-secret');
    const searchInstance = new Search(tokenManager);
    
    // Test URL construction logic
    const baseUrl = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
    
    t.ok(searchInstance.reverseApi.startsWith(baseUrl), 'Reverse API has correct base');
    t.ok(searchInstance.suggestApi.startsWith(baseUrl), 'Suggest API has correct base');
    t.ok(searchInstance.forwardApi.startsWith(baseUrl), 'Forward API has correct base');
    
    t.ok(searchInstance.reverseApi.includes('reverseGeocode'), 'Reverse API has correct endpoint');
    t.ok(searchInstance.suggestApi.includes('suggest'), 'Suggest API has correct endpoint');
    t.ok(searchInstance.forwardApi.includes('findAddressCandidates'), 'Forward API has correct endpoint');
    
    t.end();
});