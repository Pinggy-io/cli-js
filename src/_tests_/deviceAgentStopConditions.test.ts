import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

import { runDeviceAgent } from '../devices/deviceAgent.js';
import { ReconnectPolicy } from '../devices/reconnect.js';
import {
    disconnectFrame,
    helloErrorFrame,
    plain,
    redirectConfigHome,
    startFakeDashboard,
    startRefusingDashboard,
    welcomeFrame,
} from './helpers/fakeDashboard.js';

/**
 * Which failures stop the agent and which redial.
 *
 * Getting this wrong is expensive in both directions. Retrying a revoked credential is an
 * authentication failure every few seconds forever; stopping on an ordinary network blip strands a
 * machine until somebody notices and restarts it by hand. See docs/pinggy-devices/cli.md.
 *
 * Every case is observed the same way: the loop only returns on a terminal outcome, so a resolved
 * runDeviceAgent plus a connection count of 1 is what "stopped" looks like.
 */

/** No sleeping between dials, so a retry case is not an exercise in waiting. */
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

describe('stop conditions', () => {
    let printed: string[];
    let errorSpy: ReturnType<typeof jest.spyOn>;
    let warnSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        printed = [];
        const capture = (...args: unknown[]) => { printed.push(plain(args.map(String).join(' '))); };
        errorSpy = jest.spyOn(console, 'error').mockImplementation(capture);
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(capture);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
    });

    /**
     * The credential is wrong or gone. Retrying cannot fix it, and a fleet that retries a dead
     * token is a fleet authenticating against the dashboard forever.
     */
    test('HTTP 401 on the upgrade stops the loop and says how to re-enrol', async () => {
        const dashboard = await startRefusingDashboard(401);

        await runDeviceAgent('bad-token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.attempts()).toBe(1);
        expect(printed.join(' ')).toContain('Re-enrol');
        dashboard.close();
    }, 15000);

    /** Anything else about the upgrade could be a proxy hiccup or a node still booting. */
    test('a non-401 upgrade refusal retries until it is let in', async () => {
        const dashboard = await startRefusingDashboard(502, {
            refuseFirst: 2,
            onHello: (connection) => {
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('revoked'));
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.attempts()).toBe(3);
        expect(dashboard.connections()).toBe(1);
        dashboard.close();
    }, 15000);

    test('close 4001 stops the loop', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                connection.close(4001, 'revoked');
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(1);
        dashboard.close();
    }, 15000);

    test('system/disconnect names the reason it stopped for', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('deleted'));
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(1);
        expect(printed.join(' ')).toContain('deleted');
        dashboard.close();
    }, 15000);

    /**
     * The 1 reason that is not terminal. A draining node is not a revoked credential, and an agent
     * that gave up on every rolling deploy would need a manual restart across the fleet.
     */
    test('reason "shutdown" redials instead of stopping', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                if (connection.index === 1) {
                    connection.send(disconnectFrame('shutdown'));
                    connection.close(1000, 'draining');
                } else {
                    // Terminal, so the loop ends and this test does too.
                    connection.send(disconnectFrame('revoked'));
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(2);
        dashboard.close();
    }, 15000);

    /**
     * A live node elsewhere already holds this device. The credential is fine, so stopping would
     * strand a machine that only has to wait for the other socket to drop.
     */
    test('a handshake refused with already_connected redials', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                if (connection.index === 1) {
                    connection.send(helloErrorFrame('already_connected', 'held elsewhere'));
                    connection.close(4002, 'already connected');
                } else {
                    connection.send(welcomeFrame());
                    connection.send(disconnectFrame('revoked'));
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(2);
        dashboard.close();
    }, 15000);

    /** Any other handshake refusal is the credential's fault, so it stops. */
    test('a handshake refused for any other reason stops the loop', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(helloErrorFrame('device_not_found', 'no such device'));
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: instantRetries() });

        expect(dashboard.connections()).toBe(1);
        expect(printed.join(' ')).toContain('no such device');
        dashboard.close();
    }, 15000);

    /**
     * The window the pong watchdog cannot cover, since the watchdog only starts once welcome names
     * the interval. Without this timer the agent waits forever on an accepted socket.
     */
    test('an upgrade that is never answered is dropped and redialled', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                // Connection 1 is answered with silence, which is the whole test.
                if (connection.index === 2) {
                    connection.send(welcomeFrame());
                    connection.send(disconnectFrame('revoked'));
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, {
            reconnectPolicy: instantRetries(),
            handshakeTimeoutMillis: 300,
        });

        expect(dashboard.connections()).toBe(2);
        dashboard.close();
    }, 15000);
});
