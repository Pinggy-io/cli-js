import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';

import { runDeviceAgent } from '../devices/deviceAgent.js';
import { ReconnectPolicy, STABLE_CONNECTION_MILLIS } from '../devices/reconnect.js';
import {
    disconnectFrame,
    redirectConfigHome,
    startFakeDashboard,
    welcomeFrame,
} from './helpers/fakeDashboard.js';

/**
 * That the connection loop actually consumes the backoff schedule.
 *
 * deviceReconnect.test.ts pins the schedule itself. This pins the wiring, which is the half that
 * would silently regress: someone reinstates a fixed sleep and every schedule test still passes.
 */

let configHome: { cleanup: () => void };

beforeAll(() => {
    configHome = redirectConfigHome();
});

afterAll(() => {
    configHome.cleanup();
});

/** Records what the loop asked for, while still returning the real schedule. */
function recordingPolicy(random: () => number, clock?: () => number) {
    const policy = new ReconnectPolicy({ random, now: clock });
    const delays: number[] = [];
    const realNextDelay = policy.nextDelayMillis.bind(policy);

    jest.spyOn(policy, 'nextDelayMillis').mockImplementation(() => {
        const delay = realNextDelay();
        delays.push(delay);
        return delay;
    });

    return { policy, delays };
}

describe('the loop and the schedule', () => {
    /**
     * A ceiling that doubles, drawn at the midpoint so the numbers are exact. A fixed sleep would
     * give [5000, 5000] here, and no assertion in the schedule suite would notice.
     */
    test('each retry takes the next delay from the policy, not a fixed sleep', async () => {
        const { policy, delays } = recordingPolicy(() => 0.5);

        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                if (connection.index < 3) {
                    connection.drop();
                    return;
                }
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('revoked'));
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: policy });

        expect(dashboard.connections()).toBe(3);
        expect(delays).toEqual([500, 1000]);
    }, 20000);

    test('the loop really waits the delay it was given', async () => {
        const { policy } = recordingPolicy(() => 0.5);

        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                if (connection.index === 1) {
                    connection.drop();
                    return;
                }
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('revoked'));
            },
        });

        const startedAt = Date.now();
        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: policy });

        // 500 ms is half of the first ceiling. Asserted as a floor, since the socket work around it
        // takes its own time.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
        expect(dashboard.connections()).toBe(2);
        dashboard.close();
    }, 20000);

    /**
     * A connection that held long enough resets the schedule, so the dial after it starts from 1 s
     * again rather than continuing to climb.
     */
    test('a connection that held long enough sends the next delay back to the first ceiling', async () => {
        // A clock the connection can be told it survived, without the test waiting 60 s for it.
        let clockOffsetMillis = 0;
        const { policy, delays } = recordingPolicy(() => 0.5, () => Date.now() + clockOffsetMillis);

        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                if (connection.index <= 2) {
                    connection.drop();
                    return;
                }
                if (connection.index === 3) {
                    connection.send(welcomeFrame());
                    // The drop has to wait for the agent to actually handle welcome. terminate()
                    // discards anything still in flight, and a welcome the agent never saw means no
                    // markConnected, so the policy would have nothing to measure.
                    setTimeout(() => {
                        // Held, as far as the policy's clock knows, for the full stable window.
                        clockOffsetMillis += STABLE_CONNECTION_MILLIS;
                        connection.drop();
                    }, 150);
                    return;
                }
                connection.send(welcomeFrame());
                connection.send(disconnectFrame('revoked'));
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: policy });

        expect(dashboard.connections()).toBe(4);
        // Climbing, then back to the first ceiling because connection 3 counted as stable.
        expect(delays).toEqual([500, 1000, 500]);
        dashboard.close();
    }, 20000);
});
