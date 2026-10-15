import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';

import {
    DeviceAgentHost, DeviceAgentHostDependencies, NOT_ENROLLED_MESSAGE, writeIdentityWhileOwned,
} from '../daemon/deviceAgentHost.js';
import { DeviceAgentEnd, DeviceAgentRun } from '../devices/deviceAgent.js';
import { DeviceAgentReporter } from '../devices/deviceAgentReporter.js';
import { DeviceIdentity, readDeviceIdentity, writeDeviceIdentity } from '../devices/deviceIdentity.js';
import { DeviceAgentState } from '../daemon/ipc/ipcRoutes.js';
import { ErrorCode, isErrorResponse } from '../types.js';
import { WelcomeSchema } from '../devices/device_schema.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * The device agent a daemon runs for `pinggy devices connect -b`. At most 1 run, started from what
 * device.json holds, and a status that never carries the token.
 */

const TOKEN_A = 'pga_token_of_device_a';
const TOKEN_B = 'pga_token_of_device_b';
const SERVER = 'dashboard.pinggy.io';
const NOW = new Date('2026-10-15T10:00:00.000Z');

function identity(token: string, deviceAgentId = 'device-a'): DeviceIdentity {
    return { device_agent_id: deviceAgentId, token, server: SERVER, enrolled_at: '2026-10-01T00:00:00.000Z' };
}

const WELCOME = WelcomeSchema.parse({
    device_agent_id: 'device-a',
    accepted_proto: 1,
    heartbeat_interval_seconds: 30,
    stats_interval_seconds: 60,
    server_time: 1750000001,
    max_frame_bytes: 32768,
    email: 'owner@example.com',
    device_url: 'https://dashboard.pinggy.io/pinggy-devices/device-a',
});

/** A run that ends when stopped, or when the test ends it. */
function fakeRun(events: string[], token: string) {
    let end!: (value: DeviceAgentEnd) => void;
    const done = new Promise<DeviceAgentEnd>((resolve) => { end = resolve; });
    const run: DeviceAgentRun = {
        done,
        stop: () => {
            events.push(`stop ${token}`);
            end({ error: null, welcomed: true });
            return done;
        },
    };
    return { run, end };
}

function harness(stored: DeviceIdentity | null) {
    const device = { identity: stored };
    const events: string[] = [];
    const runs: Array<ReturnType<typeof fakeRun>> = [];
    const reporters: DeviceAgentReporter[] = [];
    const dependencies: DeviceAgentHostDependencies = {
        readIdentity: () => device.identity,
        startRun: (runIdentity, reporter) => {
            events.push(`start ${runIdentity.token}`);
            const created = fakeRun(events, runIdentity.token);
            runs.push(created);
            reporters.push(reporter);
            return created.run;
        },
        recordRunning: (startedBy) => { events.push(`record running ${startedBy}`); },
        recordStopped: () => { events.push('record stopped'); },
        now: () => NOW,
    };
    return { host: new DeviceAgentHost(dependencies), device, events, runs, reporters };
}

/** `.then` callbacks run on a later turn. */
function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('starting', () => {
    test('without device.json answers device_not_enrolled and starts nothing', async () => {
        const { host, events } = harness(null);

        const result = await host.start('cli');

        expect(isErrorResponse(result) && result.code).toBe(ErrorCode.DeviceNotEnrolled);
        expect(isErrorResponse(result) && result.message).toBe(NOT_ENROLLED_MESSAGE);
        expect(events).toEqual([]);
    });

    test('starts 1 run on device.json, records it, and reports it as connecting', async () => {
        const { host, events } = harness(identity(TOKEN_A));

        const result = await host.start('cli');

        expect(events).toEqual([`start ${TOKEN_A}`, 'record running cli']);
        expect(result).toMatchObject({
            state: DeviceAgentState.Connecting, deviceAgentId: 'device-a', server: SERVER,
            startedAt: NOW.toISOString(), startedBy: 'cli', lastError: null,
        });
    });

    test('twice on the same token and server keeps the 1 run', async () => {
        const { host, runs } = harness(identity(TOKEN_A));

        await host.start('cli');
        await host.start('app');

        expect(runs).toHaveLength(1);
        expect(host.status().startedBy).toBe('cli');
    });

    // 2 runs on 1 credential refuse each other with already_connected. The old run must be gone first.
    test('after device.json changed, stops the old run before the new one starts', async () => {
        const { host, device, events } = harness(identity(TOKEN_A));

        await host.start('cli');
        device.identity = identity(TOKEN_B, 'device-b');
        await host.start('cli');

        expect(events).toEqual([
            `start ${TOKEN_A}`, 'record running cli',
            'record stopped', `stop ${TOKEN_A}`,
            `start ${TOKEN_B}`, 'record running cli',
        ]);
        expect(host.status().deviceAgentId).toBe('device-b');
    });
});

describe('stopping', () => {
    test('stops the run, records it, and reports stopped', async () => {
        const { host, events } = harness(identity(TOKEN_A));
        await host.start('cli');

        const status = await host.stop();

        expect(events.slice(2)).toEqual(['record stopped', `stop ${TOKEN_A}`]);
        expect(status.state).toBe(DeviceAgentState.Stopped);
        expect(status.lastError).toBeNull();
    });

    test('with no run does nothing', async () => {
        const { host, events } = harness(identity(TOKEN_A));

        expect((await host.stop()).state).toBe(DeviceAgentState.Stopped);
        expect(events).toEqual([]);
    });

    // The shutdown deletes daemon-state.json. A write after it would bring the file back, and the next
    // daemon would start an agent nobody asked for.
    test('close stops the run, records nothing, and lets nothing start after it', async () => {
        const { host, events } = harness(identity(TOKEN_A));
        await host.start('cli');

        await host.close();
        await host.start('cli');

        expect(events).toEqual([`start ${TOKEN_A}`, 'record running cli', `stop ${TOKEN_A}`]);
        expect(host.status().state).toBe(DeviceAgentState.Stopped);
    });
});

describe('a run that ends on its own', () => {
    test('keeps why in lastError, reports stopped, and is removed from the state file', async () => {
        const { host, events, runs } = harness(identity(TOKEN_A));
        await host.start('cli');

        runs[0].end({ error: { code: 'revoked', message: 'Credential revoked.' }, welcomed: true });
        await nextTurn();

        expect(host.status()).toMatchObject({
            state: DeviceAgentState.Stopped, lastError: { code: 'revoked', message: 'Credential revoked.' },
        });
        expect(events.at(-1)).toBe('record stopped');
    });
});

describe('the status', () => {
    test('follows the run: connected with the email and the device page, then reconnecting', async () => {
        const { host, reporters } = harness(identity(TOKEN_A));
        await host.start('cli');

        reporters[0].connected(WELCOME);
        expect(host.status()).toMatchObject({
            state: DeviceAgentState.Connected,
            email: 'owner@example.com',
            deviceUrl: 'https://dashboard.pinggy.io/pinggy-devices/device-a',
            connectedAt: NOW.toISOString(),
        });

        reporters[0].reconnecting(1000, 1);
        expect(host.status()).toMatchObject({ state: DeviceAgentState.Reconnecting, connectedAt: null });

        reporters[0].connecting(SERVER);
        expect(host.status().state).toBe(DeviceAgentState.Reconnecting);
    });

    test('ignores a run that was replaced', async () => {
        const { host, device, reporters } = harness(identity(TOKEN_A));
        await host.start('cli');
        device.identity = identity(TOKEN_B, 'device-b');
        await host.start('cli');

        reporters[0].connected(WELCOME);

        expect(host.status()).toMatchObject({ state: DeviceAgentState.Connecting, deviceAgentId: 'device-b' });
    });

    // Any local user can reach the IPC port.
    test('never carries the token', async () => {
        const { host, reporters } = harness(identity(TOKEN_A));
        await host.start('cli');
        reporters[0].connected(WELCOME);

        expect(JSON.stringify(host.status())).not.toContain(TOKEN_A);
    });
});

describe('writeIdentityWhileOwned', () => {
    let configHome: { cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    // `connect -b` wrote a new credential. An old run that reconnects before the daemon switches must not
    // write the old one back.
    test('leaves a device.json that holds another token', () => {
        writeDeviceIdentity(identity(TOKEN_B, 'device-b'));
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        writeIdentityWhileOwned(identity(TOKEN_A));

        logSpy.mockRestore();
        expect(readDeviceIdentity()?.token).toBe(TOKEN_B);
    });

    test('rewrites a device.json that holds its own token', () => {
        writeDeviceIdentity(identity(TOKEN_A, 'old-id'));

        writeIdentityWhileOwned(identity(TOKEN_A, 'new-id'));

        expect(readDeviceIdentity()?.device_agent_id).toBe('new-id');
    });
});
