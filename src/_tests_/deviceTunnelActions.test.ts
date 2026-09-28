import { describe, test, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import {
    ERROR_INVALID_PAYLOAD, ERROR_SAVED_CONFIG_NOT_FOUND, ERROR_TUNNEL_ACTION_FAILED, ERROR_TUNNEL_NOT_FOUND,
    ERROR_UNSUPPORTED_OP, TunnelActionDependencies, TunnelDaemonClient, handleTunnelAction,
    machineTunnelActionDependencies,
} from '../devices/tunnels/tunnelActions.js';
import { buildCapabilities } from '../devices/deviceAgent.js';
import { CHANNEL_TUNNEL, Envelope } from '../devices/envelope.js';
import { SavedTunnelConfig } from '../cli/configStore.js';
import { logger } from '../logger.js';
import { ErrorCode } from '../types.js';
import { getDaemonInfoPath } from '../utils/configDir.js';
import { redirectConfigHome } from './helpers/fakeDashboard.js';

/**
 * `tunnel/start`, `tunnel/stop` and `tunnel/restart`, slice 10.
 *
 * The daemon is a recording fake. The dashboard config carries a real-looking token on purpose: it
 * must reach the daemon whole and appear in no log line.
 *
 * See docs/pinggy-devices/slices/10-device-tunnel-actions.md in the pinggy_backend repo.
 */

const TUNNEL_ID = '8f1c2d3e-0000-4000-8000-000000000001';
const SAVED_CONFIG_ID = 'c2d4e5f6-0000-4000-8000-000000000002';
const TUNNEL_TOKEN = 'tkn_9f8e7d6c5b4a';
const REQUEST_ID = 'dash-req-1';

type Call = { route: string; args: unknown[] };

function daemonAnswer(tunnelid: string, state: string) {
    return { tunnelid, remoteurls: [], tunnelconfig: {}, status: { state }, stats: {} };
}

/** A daemon that records every call and answers each route with what the test set. */
function fakeDaemon(answers: Partial<Record<'stop' | 'restart' | 'start', unknown>> = {}) {
    const calls: Call[] = [];
    const answer = (route: 'stop' | 'restart' | 'start', fallback: unknown) =>
        Promise.resolve((route in answers ? answers[route] : fallback) as never);
    const client: TunnelDaemonClient = {
        stopTunnel: (tunnelId: string) => {
            calls.push({ route: 'stop', args: [tunnelId] });
            return answer('stop', daemonAnswer(tunnelId, 'exited'));
        },
        restartTunnel: (tunnelId: string, noWait?: boolean) => {
            calls.push({ route: 'restart', args: [tunnelId, noWait] });
            return answer('restart', daemonAnswer(tunnelId, 'starting'));
        },
        startTunnelWithConfig: (config, mode, noWait) => {
            calls.push({ route: 'start', args: [config, mode, noWait] });
            return answer('start', daemonAnswer('new-tunnel-id', 'starting'));
        },
    };
    return { client, calls };
}

function savedConfig(name: string, configId: string): SavedTunnelConfig {
    return {
        name, configId, autoStart: false, createdAt: '2025-09-24T00:00:00Z', updatedAt: '2025-09-24T00:00:00Z',
        tunnelConfig: {
            version: '1.0', name, configId, force: false, webDebugger: '', token: TUNNEL_TOKEN,
            forwarding: [{ type: 'http', address: 'localhost:3000' }],
        } as unknown as SavedTunnelConfig['tunnelConfig'],
    };
}

/**
 * Dependencies around the fake. `running: false` means no daemon until one is started, and records
 * whether anything asked to start one.
 */
function dependencies(client: TunnelDaemonClient | null, saved: SavedTunnelConfig[] = []) {
    const asked: boolean[] = [];
    const deps: TunnelActionDependencies = {
        daemon: (startIfMissing: boolean) => {
            asked.push(startIfMissing);
            return Promise.resolve(client ?? (startIfMissing ? fakeDaemon().client : null));
        },
        readSavedConfigs: () => saved,
    };
    return { deps, asked };
}

function request(op: string, payload: unknown, kind: Envelope['kind'] = 'req'): Envelope {
    return { v: 1, kind, ch: CHANNEL_TUNNEL, op, id: REQUEST_ID, seq: 0, ts: 0, payload };
}

async function act(envelope: Envelope, deps: TunnelActionDependencies): Promise<Envelope[]> {
    const sent: Envelope[] = [];
    await handleTunnelAction(envelope, (frame) => sent.push(frame), deps);
    return sent;
}

function errorCodeOf(frame: Envelope): string | undefined {
    return (frame.payload as { error?: { code: string } }).error?.code;
}

function dashboardConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: '1.0', name: 'api', configId: '5b9e0000-0000-4000-8000-000000000003', force: false,
        webDebugger: '', token: TUNNEL_TOKEN, forwarding: [{ type: 'http', address: 'localhost:3000' }],
        basicAuth: [], bearerTokenAuth: [], headerModification: [], ipWhitelist: [],
        ...overrides,
    };
}

describe('each action reaches the right daemon route and answers on the request id', () => {
    test('stop calls stop with the tunnel id and answers the state', async () => {
        const daemon = fakeDaemon();
        const [answer] = await act(request('stop', { tunnel_id: TUNNEL_ID }), dependencies(daemon.client).deps);

        expect(daemon.calls).toEqual([{ route: 'stop', args: [TUNNEL_ID] }]);
        expect(answer).toMatchObject({ kind: 'res', ch: 'tunnel', op: 'stop', id: REQUEST_ID });
        expect(answer.payload).toEqual({ tunnel_id: TUNNEL_ID, state: 'exited' });
    });

    test('restart calls restart with noWait', async () => {
        const daemon = fakeDaemon();
        const [answer] = await act(request('restart', { tunnel_id: TUNNEL_ID }), dependencies(daemon.client).deps);

        expect(daemon.calls).toEqual([{ route: 'restart', args: [TUNNEL_ID, true] }]);
        expect(answer.op).toBe('restart');
        expect(answer.payload).toEqual({ tunnel_id: TUNNEL_ID, state: 'starting' });
    });

    test('start of a stopped tunnel calls restart, not start, and keeps the id', async () => {
        const daemon = fakeDaemon();
        const [answer] = await act(request('start', { tunnel_id: TUNNEL_ID }), dependencies(daemon.client).deps);

        expect(daemon.calls).toEqual([{ route: 'restart', args: [TUNNEL_ID, true] }]);
        expect(answer.op).toBe('start');
        expect(answer.payload).toEqual({ tunnel_id: TUNNEL_ID, state: 'starting' });
    });

    test('start of a saved config sends it through start-config, detached, with noWait', async () => {
        const daemon = fakeDaemon();
        const { deps } = dependencies(daemon.client, [savedConfig('api', SAVED_CONFIG_ID)]);

        const [answer] = await act(request('start', { source: 'device', config_id: SAVED_CONFIG_ID }), deps);

        expect(daemon.calls).toHaveLength(1);
        const [config, mode, noWait] = daemon.calls[0].args as [Record<string, unknown>, string, boolean];
        expect(daemon.calls[0].route).toBe('start');
        expect(config.configId).toBe(SAVED_CONFIG_ID);
        expect(config.name).toBe('api');
        expect(mode).toBe('detached');
        expect(noWait).toBe(true);
        expect(answer.payload).toEqual({ tunnel_id: 'new-tunnel-id', state: 'starting' });
    });

    test('a saved config is found by its exact id only, never a prefix', async () => {
        const daemon = fakeDaemon();
        const { deps } = dependencies(daemon.client, [savedConfig('api', SAVED_CONFIG_ID)]);

        const [answer] = await act(request('start', { source: 'device', config_id: SAVED_CONFIG_ID.slice(0, 8) }),
            deps);

        expect(errorCodeOf(answer)).toBe(ERROR_SAVED_CONFIG_NOT_FOUND);
        expect(daemon.calls).toEqual([]);
    });
});

describe('the dashboard config', () => {
    test('reaches the daemon whole, token included, and appears in no log line', async () => {
        const logged: unknown[] = [];
        const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
            jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
                logged.push(args);
                return logger;
            }) as never));
        try {
            const daemon = fakeDaemon();
            const [answer] = await act(request('start', { source: 'dashboard', config: dashboardConfig() }),
                dependencies(daemon.client).deps);

            const [config] = daemon.calls[0].args as [Record<string, unknown>];
            expect(config.token).toBe(TUNNEL_TOKEN);
            expect(config.forwarding).toEqual([{ type: 'http', address: 'localhost:3000' }]);
            expect(answer.payload).toEqual({ tunnel_id: 'new-tunnel-id', state: 'starting' });
            expect(logged.length).toBeGreaterThan(0);
            expect(JSON.stringify(logged)).not.toContain(TUNNEL_TOKEN);
        } finally {
            spies.forEach((spy) => spy.mockRestore());
        }
    });

    test('null fields from the dashboard serialiser are dropped before the schema reads it', async () => {
        const daemon = fakeDaemon();
        const [answer] = await act(request('start', {
            source: 'dashboard', config: dashboardConfig({ serverAddress: null, haProxy: null }),
        }), dependencies(daemon.client).deps);

        expect(errorCodeOf(answer)).toBeUndefined();
        expect(daemon.calls[0].args[0]).not.toHaveProperty('serverAddress');
    });

    test('a config the schema refuses is invalid_payload, and the daemon is not called', async () => {
        const daemon = fakeDaemon();
        const [answer] = await act(request('start', {
            source: 'dashboard', config: dashboardConfig({ forwarding: 42 }),
        }), dependencies(daemon.client).deps);

        expect(errorCodeOf(answer)).toBe(ERROR_INVALID_PAYLOAD);
        expect(JSON.stringify(answer)).not.toContain(TUNNEL_TOKEN);
        expect(daemon.calls).toEqual([]);
    });
});

describe('no daemon', () => {
    test('a stop or restart answers tunnel_not_found and starts no daemon', async () => {
        for (const op of ['stop', 'restart']) {
            const { deps, asked } = dependencies(null);
            const [answer] = await act(request(op, { tunnel_id: TUNNEL_ID }), deps);

            expect(errorCodeOf(answer)).toBe(ERROR_TUNNEL_NOT_FOUND);
            expect(asked).toEqual([false]);
        }
    });

    test('a start of a stopped tunnel starts no daemon either: without one, there is no tunnel', async () => {
        const { deps, asked } = dependencies(null);
        const [answer] = await act(request('start', { tunnel_id: TUNNEL_ID }), deps);

        expect(errorCodeOf(answer)).toBe(ERROR_TUNNEL_NOT_FOUND);
        expect(asked).toEqual([false]);
    });

    test('a start of a config may start one', async () => {
        const { deps, asked } = dependencies(null, [savedConfig('api', SAVED_CONFIG_ID)]);
        const [answer] = await act(request('start', { source: 'device', config_id: SAVED_CONFIG_ID }), deps);

        expect(errorCodeOf(answer)).toBeUndefined();
        expect(asked).toEqual([true]);
    });
});

describe('the daemon refuses', () => {
    test('its unknown-tunnel code becomes tunnel_not_found', async () => {
        const daemon = fakeDaemon({ stop: { code: ErrorCode.TunnelNotFound, message: 'Tunnel "x" not found' } });
        const [answer] = await act(request('stop', { tunnel_id: TUNNEL_ID }), dependencies(daemon.client).deps);

        expect(errorCodeOf(answer)).toBe(ERROR_TUNNEL_NOT_FOUND);
    });

    test('any other refusal becomes tunnel_action_failed, its message cleaned and cut', async () => {
        const message = 'token\u0007 already\n active ' + 'x'.repeat(400);
        const daemon = fakeDaemon({ start: { code: ErrorCode.ErrorStartingTunnel, message } });
        const { deps } = dependencies(daemon.client, [savedConfig('api', SAVED_CONFIG_ID)]);

        const [answer] = await act(request('start', { source: 'device', config_id: SAVED_CONFIG_ID }), deps);

        const error = (answer.payload as { error: { code: string; message: string } }).error;
        expect(error.code).toBe(ERROR_TUNNEL_ACTION_FAILED);
        expect(error.message).toMatch(/^token already active x+$/);
        expect(error.message).toHaveLength(256);
    });

    test('a daemon call that throws becomes tunnel_action_failed', async () => {
        const client: TunnelDaemonClient = {
            ...fakeDaemon().client,
            stopTunnel: () => Promise.reject(new Error('Daemon returned HTTP 500: boom')),
        };
        const [answer] = await act(request('stop', { tunnel_id: TUNNEL_ID }), dependencies(client).deps);

        expect(errorCodeOf(answer)).toBe(ERROR_TUNNEL_ACTION_FAILED);
    });

    test('a daemon from another IPC version becomes tunnel_action_failed, with the reason', async () => {
        const deps: TunnelActionDependencies = {
            daemon: () => Promise.reject(new Error('The running daemon speaks IPC v0, this pinggy speaks v1.')),
            readSavedConfigs: () => [],
        };
        const [answer] = await act(request('stop', { tunnel_id: TUNNEL_ID }), deps);

        expect(errorCodeOf(answer)).toBe(ERROR_TUNNEL_ACTION_FAILED);
        expect(JSON.stringify(answer.payload)).toContain('IPC v0');
    });
});

describe('unreadable frames', () => {
    test('a payload naming no source, or several, is invalid_payload and calls nothing', async () => {
        const daemon = fakeDaemon();
        const { deps, asked } = dependencies(daemon.client);
        const cases: [string, unknown][] = [
            ['stop', {}],
            ['stop', { source: 'device', config_id: SAVED_CONFIG_ID }],
            ['start', {}],
            ['start', { tunnel_id: TUNNEL_ID, source: 'device', config_id: SAVED_CONFIG_ID }],
            ['start', { source: 'device' }],
            ['start', { source: 'dashboard' }],
            ['start', { source: 'device', config_id: SAVED_CONFIG_ID, config: dashboardConfig() }],
            ['start', { source: 'elsewhere', config_id: SAVED_CONFIG_ID }],
            ['start', 'not an object'],
        ];
        for (const [op, payload] of cases) {
            const [answer] = await act(request(op, payload), deps);
            expect(errorCodeOf(answer)).toBe(ERROR_INVALID_PAYLOAD);
        }
        expect(daemon.calls).toEqual([]);
        expect(asked).toEqual([]);
    });

    test('an op this build does not know is answered unsupported_op', async () => {
        const [answer] = await act(request('pause', { tunnel_id: TUNNEL_ID }), dependencies(fakeDaemon().client).deps);

        expect(errorCodeOf(answer)).toBe(ERROR_UNSUPPORTED_OP);
        expect(answer.op).toBe('pause');
    });

    test('a frame that is not a request is ignored', async () => {
        const daemon = fakeDaemon();
        const sent = await act(request('stop', { tunnel_id: TUNNEL_ID }, 'res'), dependencies(daemon.client).deps);

        expect(sent).toEqual([]);
        expect(daemon.calls).toEqual([]);
    });
});

describe('the agent advertises it', () => {
    test('tunnel_control is in the capabilities, with or without a terminal', () => {
        expect(buildCapabilities(false)).toContain('tunnel_control');
        expect(buildCapabilities(true)).toContain('tunnel_control');
    });
});

describe('the real machine', () => {
    let configHome: { dir: string; cleanup: () => void };

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    afterEach(() => {
        fs.rmSync(getDaemonInfoPath(), { force: true });
    });

    test('with no daemon.json, a stop gets no client and nothing is spawned', async () => {
        const client = await machineTunnelActionDependencies.daemon(false);

        expect(client).toBeNull();
        expect(fs.existsSync(getDaemonInfoPath())).toBe(false);
    });

    test('a daemon from another IPC version is refused, not used', async () => {
        fs.mkdirSync(path.dirname(getDaemonInfoPath()), { recursive: true });
        fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({
            pid: process.pid, port: 1, startedAt: '', ipcVersion: 0,
        }));

        await expect(machineTunnelActionDependencies.daemon(false)).rejects.toThrow();
    });
});
