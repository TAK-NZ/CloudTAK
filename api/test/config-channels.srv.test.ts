// Must be set before the server config is built in flight.takeoff()
process.env.CHANNEL_FOLDER_SEPARATOR = '" / "';

import test from 'node:test';
import assert from 'node:assert';
import Flight from './flight.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user({ admin: false });

test('GET api/config/channels - uses CHANNEL_FOLDER_SEPARATOR with its quotes stripped', async () => {
    try {
        const res = await flight.fetch('/api/config/channels', {
            method: 'GET',
            auth: {
                bearer: flight.token.user,
            },
        }, true);

        assert.deepEqual(res.body, { separator: ' / ' });
    } catch (err) {
        assert.ifError(err);
    }
});

flight.landing();
