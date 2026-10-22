import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { runDeviceAgent } from '../devices/deviceAgent.js';
import { ReconnectPolicy } from '../devices/reconnect.js';
import {
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    disconnectFrame,
    redirectConfigHome,
    startFakeDashboard,
    welcomeFrame,
} from './helpers/fakeDashboard.js';

/**
 * The pong watchdog, against a real socket.
 *
 * The silent case runs with autoPong off, so the dashboard accepts the connection, completes the
 * handshake, and then goes quiet in exactly the way a half-dead link does: the socket stays open,
 * readyState stays OPEN, and no close event ever fires. Nothing but the watchdog notices.
 */

const WATCHDOG_GRACE_MILLIS = DEFAULT_HEARTBEAT_INTERVAL_SECONDS * 2 * 1000;

/** No sleeping between dials, so the elapsed time measures the watchdog and nothing else. */
function instantRetries(): ReconnectPolicy {
    return new ReconnectPolicy({ random: () => 0 });
}

let configHome: { cleanup: () => void };

beforeAll(() => {
    configHome = redirectConfigHome();
});

afterAll(() => {
    configHome.cleanup();
});

describe('pong watchdog', () => {
    /**
     * Connection 1 goes silent and can only be abandoned by the watchdog, since nothing else is
     * watching. Connection 2 is told the credential is revoked, which is what lets the loop exit
     * instead of running forever.
     */
    test('a socket that stops answering pings is dropped and redialled', async () => {
        let pingsOnFirstConnection = 0;

        const dashboard = await startFakeDashboard({
            autoPong: false,
            onHello: (connection) => {
                connection.send(welcomeFrame());
                if (connection.index === 2) {
                    connection.send(disconnectFrame('revoked'));
                } else {
                    connection.socket.on('ping', () => { pingsOnFirstConnection += 1; });
                }
            },
        });

        const startedAt = Date.now();
        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });
        const elapsed = Date.now() - startedAt;

        expect(dashboard.connections()).toBe(2);
        // The first socket never closed on its own, so the redial can only have come from the
        // watchdog. It cannot fire before its grace window either.
        expect(elapsed).toBeGreaterThanOrEqual(WATCHDOG_GRACE_MILLIS);
        expect(pingsOnFirstConnection).toBeGreaterThanOrEqual(1);
        dashboard.close();
    }, 20000);

    /**
     * The other half, and the more dangerous failure. A watchdog that never re-arms kills every
     * connection on a fixed timer, which is worse than having none: the agent would reconnect
     * forever against a dashboard answering perfectly.
     */
    test('a socket that answers pings survives well past the grace window', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                // Held open past 2 grace windows, then ended so the loop exits.
                setTimeout(() => connection.send(disconnectFrame('revoked')), WATCHDOG_GRACE_MILLIS * 2);
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(1);
        dashboard.close();
    }, 20000);
});
