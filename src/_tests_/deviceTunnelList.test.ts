import { describe, test, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
    DaemonReading, MAX_TUNNELS, REASON_IPC_VERSION_MISMATCH, buildTunnelList, changeKey,
    collectTunnelList, machineTunnelListSource, sanitizeErrorMessage, startTunnelReporting, toForwarding,
} from '../devices/tunnels/tunnelList.js';
import { DeviceTunnelList } from '../devices/device_schema.js';
import { runDeviceAgent } from '../devices/deviceAgent.js';
import { ReconnectPolicy } from '../devices/reconnect.js';
import { SavedTunnelConfig } from '../cli/configStore.js';
import { IPC_VERSION } from '../daemon/ipc/ipcRoutes.js';
import { getDaemonInfoPath, getTunnelConfigDir } from '../utils/configDir.js';
import { disconnectFrame, redirectConfigHome, startFakeDashboard, welcomeFrame } from './helpers/fakeDashboard.js';

/**
 * `device/tunnels`, slice 09.
 *
 * The daemon answer below carries real-looking credentials on purpose. The whitelist is asserted on
 * the serialised JSON, the form that reaches Redis and the browser, not on the object's keys.
 *
 * See docs/pinggy-devices/slices/09-device-tunnels.md in the pinggy_backend repo.
 */

const TUNNEL_TOKEN = 'tkn_9f8e7d6c5b4a';
const BASIC_AUTH_PASSWORD = 'hunter2-password';
const BEARER_TOKEN = 'bearer-abc-123';
const HEADER_VALUE = 'X-Secret-Header-Value';
const COLLECTED_AT = 1758690105;

function daemonTunnel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tunnelid: '8f1c',
        remoteurls: ['https://abc.a.pinggy.link'],
        mode: 'detached',
        greetmsg: 'welcome',
        tunnelconfig: {
            version: '1', name: 'api', configId: 'c2d4', force: false, webDebugger: 'localhost:4300',
            serverAddress: 'a.pinggy.io',
            token: TUNNEL_TOKEN,
            forwarding: [{ type: 'http', address: 'localhost:3000', listenAddress: 'abc.a.pinggy.link' }],
            basicAuth: [{ username: 'admin', password: BASIC_AUTH_PASSWORD }],
            bearerTokenAuth: [BEARER_TOKEN],
            headerModification: [{ key: 'X-Api', value: [HEADER_VALUE], type: 'add' }],
            ipWhitelist: ['10.0.0.0/8'],
            optional: { additionalArguments: `-t ${TUNNEL_TOKEN}` },
        },
        status: {
            state: 'live', errorcode: '', errormsg: '', warnings: [],
            createdtimestamp: '2025-09-24T05:00:00.000Z', starttimestamp: '2025-09-24T05:00:02.000Z',
            endtimestamp: '',
        },
        stats: { numLiveConnections: 3, numTotalReqBytes: 100 },
        ...overrides,
    };
}

function savedConfig(name: string, configId: string, createdAt: string): SavedTunnelConfig {
    return {
        name, configId, autoStart: false, createdAt, updatedAt: createdAt,
        tunnelConfig: { token: TUNNEL_TOKEN } as SavedTunnelConfig['tunnelConfig'],
    };
}

const running = (tunnels: unknown[]): DaemonReading => ({ running: true, tunnels });

describe('the whitelist', () => {
    test('a daemon answer with a token, basic auth, a bearer token and headers produces a row with none', () => {
        const list = buildTunnelList(running([daemonTunnel()]), [savedConfig('api', 'c2d4', '2025-09-24T00:00:00Z')],
                                     COLLECTED_AT);
        const serialised = JSON.stringify(list);

        for (const secret of [TUNNEL_TOKEN, BASIC_AUTH_PASSWORD, BEARER_TOKEN, HEADER_VALUE]) {
            expect(serialised).not.toContain(secret);
        }
        expect(serialised).not.toContain('token');
        expect(serialised).not.toContain('10.0.0.0');
        expect(serialised).not.toContain('a.pinggy.io"');
        expect(serialised).not.toContain('numLiveConnections');
    });

    test('keeps the fields the page shows', () => {
        const list = buildTunnelList(running([daemonTunnel()]), [], COLLECTED_AT);

        expect(list.tunnels).toEqual([{
            tunnel_id: '8f1c', config_id: 'c2d4', name: 'api', state: 'live', error_message: null,
            remote_urls: ['https://abc.a.pinggy.link'],
            forwarding: [{ type: 'http', local_address: 'localhost:3000' }],
            mode: 'detached', created_at: 1758690000, started_at: 1758690002,
        }]);
        expect(list.daemon_running).toBe(true);
        expect(list.collected_at).toBe(COLLECTED_AT);
    });

    test('a string forwarding becomes 1 entry', () => {
        expect(toForwarding('https://localhost:5555')).toEqual([{ type: 'http', local_address: 'localhost:5555' }]);
        expect(toForwarding('tcp://localhost:22')).toEqual([{ type: 'tcp', local_address: 'localhost:22' }]);
        expect(toForwarding('localhost:8080')).toEqual([{ type: 'http', local_address: 'localhost:8080' }]);
        expect(toForwarding('')).toEqual([]);
    });

    test('an array keeps type and local address only', () => {
        expect(toForwarding([
            { type: 'tcp', address: 'localhost:22', listenAddress: 'x' },
            { address: 'localhost:80' },
            { type: 'http' },
        ])).toEqual([
            { type: 'tcp', local_address: 'localhost:22' },
            { type: 'http', local_address: 'localhost:80' },
        ]);
    });

    test('an error message loses control characters and is cut to 256', () => {
        expect(sanitizeErrorMessage('bad\u001b[31m thing\n')).toBe('bad[31m thing');
        expect(sanitizeErrorMessage('x'.repeat(300))).toHaveLength(256);
        expect(sanitizeErrorMessage('')).toBeNull();
    });

    test('a saved config is running only while a tunnel with its id is not stopped', () => {
        const list = buildTunnelList(
            running([
                daemonTunnel(),
                daemonTunnel({ tunnelid: 'dead', tunnelconfig: { name: 'web', configId: 'w1' },
                               status: { state: 'exited' } }),
            ]),
            [savedConfig('api', 'c2d4', '2025-09-24T00:00:00Z'), savedConfig('web', 'w1', '2025-09-23T00:00:00Z'),
             savedConfig('db', 'd9', '2025-09-25T00:00:00Z')],
            COLLECTED_AT);

        expect(list.saved_configs).toEqual([
            { config_id: 'd9', name: 'db', running: false },
            { config_id: 'c2d4', name: 'api', running: true },
            { config_id: 'w1', name: 'web', running: false },
        ]);
    });

    test('60 tunnels send 50 and truncated', () => {
        const tunnels = Array.from({ length: 60 }, (_, i) => daemonTunnel({
            tunnelid: `t${i}`,
            status: { state: 'live', createdtimestamp: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString() },
        }));

        const list = buildTunnelList(running(tunnels), [], COLLECTED_AT);

        expect(list.tunnels).toHaveLength(MAX_TUNNELS);
        expect(list.truncated).toBe(true);
        // Newest first: the last one created leads.
        expect(list.tunnels[0].tunnel_id).toBe('t59');
    });

    test('a list under both limits is not truncated', () => {
        expect(buildTunnelList(running([daemonTunnel()]), [], COLLECTED_AT).truncated).toBe(false);
    });
});

describe('change detection', () => {
    test('a stats change alone changes nothing', () => {
        const before = buildTunnelList(running([daemonTunnel()]), [], COLLECTED_AT);
        const after = buildTunnelList(running([daemonTunnel({ stats: { numLiveConnections: 9 } })]), [],
                                      COLLECTED_AT + 5);

        expect(changeKey(after)).toBe(changeKey(before));
    });

    test('a state change changes the key', () => {
        const before = buildTunnelList(running([daemonTunnel()]), [], COLLECTED_AT);
        const after = buildTunnelList(
            running([daemonTunnel({ status: { state: 'exited', createdtimestamp: '2025-09-24T05:00:00.000Z' } })]),
            [], COLLECTED_AT);

        expect(changeKey(after)).not.toBe(changeKey(before));
    });
});

describe('reporting', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    function listWith(state: string, collectedAt: number): DeviceTunnelList {
        return buildTunnelList(running([daemonTunnel({ status: { state } })]), [], collectedAt);
    }

    /** Resolves every queued promise, so a poll started by a fake timer finishes before the assert. */
    async function flush(): Promise<void> {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }

    test('sends at once, then only when the list changed', async () => {
        jest.useFakeTimers();
        const states = ['live', 'live', 'live', 'exited'];
        let reads = 0;
        const sent: DeviceTunnelList[] = [];

        const stop = startTunnelReporting(async () => listWith(states[Math.min(reads, 3)], 1000 + reads++),
                                          (list) => sent.push(list), 5000);
        await flush();
        expect(sent).toHaveLength(1);

        jest.advanceTimersByTime(5000);
        await flush();
        jest.advanceTimersByTime(5000);
        await flush();
        expect(sent).toHaveLength(1);

        jest.advanceTimersByTime(5000);
        await flush();
        expect(sent).toHaveLength(2);
        expect(sent[1].tunnels[0].state).toBe('exited');
        stop();
    });

    test('nothing is sent after stop, and a list still being read is dropped', async () => {
        jest.useFakeTimers();
        let release: (list: DeviceTunnelList) => void = () => undefined;
        const sent: DeviceTunnelList[] = [];

        const stop = startTunnelReporting(() => new Promise((resolve) => { release = resolve; }),
                                          (list) => sent.push(list), 5000);
        stop();
        release(listWith('live', 1));
        await flush();
        jest.advanceTimersByTime(20000);
        await flush();

        expect(sent).toHaveLength(0);
    });

    /** Slice 10: after a tunnel action, the page sees its effect without waiting out the interval. */
    test('pollNow reads at once, outside the interval', async () => {
        jest.useFakeTimers();
        let state = 'live';
        const sent: DeviceTunnelList[] = [];

        const reporting = startTunnelReporting(async () => listWith(state, 1), (list) => sent.push(list), 5000);
        await flush();
        state = 'exited';
        reporting.pollNow();
        await flush();

        expect(sent.map((list) => list.tunnels[0].state)).toEqual(['live', 'exited']);
        reporting();
    });

    /** A read that started before the action may miss it, so pollNow during a read reads again after it. */
    test('pollNow during a read in flight reads again once it ends', async () => {
        jest.useFakeTimers();
        const releases: ((list: DeviceTunnelList) => void)[] = [];
        const sent: DeviceTunnelList[] = [];

        const reporting = startTunnelReporting(() => new Promise((resolve) => { releases.push(resolve); }),
                                               (list) => sent.push(list), 5000);
        reporting.pollNow();
        expect(releases).toHaveLength(1);

        releases[0](listWith('live', 1));
        await flush();
        expect(releases).toHaveLength(2);
        releases[1](listWith('exited', 2));
        await flush();

        expect(sent.map((list) => list.tunnels[0].state)).toEqual(['live', 'exited']);
        reporting();
    });
});

describe('reading the machine', () => {
    let configHome: { dir: string; cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
        fs.mkdirSync(getTunnelConfigDir(), { recursive: true });
        fs.writeFileSync(path.join(getTunnelConfigDir(), 'api_c2d4.json'),
                         JSON.stringify(savedConfig('api', 'c2d4', '2025-09-24T00:00:00Z')));
    });

    afterAll(() => {
        configHome.cleanup();
    });

    afterEach(() => {
        fs.rmSync(getDaemonInfoPath(), { force: true });
    });

    test('no daemon.json: not running, nothing spawned, saved configs still listed', async () => {
        const list = await collectTunnelList(machineTunnelListSource);

        expect(list.daemon_running).toBe(false);
        expect(list.daemon_unavailable_reason).toBeNull();
        expect(list.tunnels).toEqual([]);
        expect(list.saved_configs).toEqual([{ config_id: 'c2d4', name: 'api', running: false }]);
        expect(fs.existsSync(getDaemonInfoPath())).toBe(false);
    });

    test('a dead pid in daemon.json: not running, and nothing spawned', async () => {
        fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({
            pid: 2 ** 22 + 12345, port: 1, startedAt: '', ipcVersion: IPC_VERSION,
        }));

        const list = await collectTunnelList(machineTunnelListSource);

        expect(list.daemon_running).toBe(false);
        expect(list.saved_configs).toHaveLength(1);
        expect(fs.existsSync(getDaemonInfoPath())).toBe(false);
    });

    /** A daemon from another build is alive, but its answer is not parsed. */
    test('a live daemon on another IPC version: not running, with the reason', async () => {
        fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({
            pid: process.pid, port: 1, startedAt: '', ipcVersion: IPC_VERSION + 1,
        }));

        const list = await collectTunnelList(machineTunnelListSource);

        expect(list.daemon_running).toBe(false);
        expect(list.daemon_unavailable_reason).toBe(REASON_IPC_VERSION_MISMATCH);
    });
});

describe('the agent', () => {
    let configHome: { cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    /** The poll stops with the socket, and the next welcome sends the list again though nothing changed. */
    test('sends the list once after every welcome', async () => {
        const tunnelFramesPerConnection: number[] = [0, 0, 0];

        const dashboard = await startFakeDashboard({
            onHello: (connection) => connection.send(welcomeFrame()),
            onFrame: (connection, frame) => {
                if (frame.ch !== 'device' || frame.op !== 'tunnels') return;
                tunnelFramesPerConnection[connection.index] += 1;
                const payload = frame.payload as DeviceTunnelList;
                expect(payload.daemon_running).toBe(false);
                if (connection.index === 1) {
                    connection.drop();
                } else {
                    connection.send(disconnectFrame('revoked'));
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, {
            reconnectPolicy: new ReconnectPolicy({ random: () => 0 }),
        });

        expect(dashboard.connections()).toBe(2);
        expect(tunnelFramesPerConnection.slice(1)).toEqual([1, 1]);
        dashboard.close();
    }, 15000);
});
