import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

import {
    BackgroundAgentDependencies, DeviceAgentDaemonClient, differsFromStored, foregroundRefusal, olderDaemonMessage,
    startAgentInBackground, stopAgentBeforeRemove, stopAgentInBackground,
} from '../devices/backgroundAgent.js';
import { DEVICE_AGENT_TOKEN_VARIABLE, handleDevice } from '../cli/subcommand/handlers/deviceCommand.js';
import { DeviceAgentEnd } from '../devices/deviceAgent.js';
import { DeviceIdentity } from '../devices/deviceIdentity.js';
import { DaemonInfo } from '../daemon/lifecycle/daemonChild.js';
import { IPCHttpError } from '../daemon/ipc/ipcClient.js';
import {
    DaemonHost, DeviceAgentState, DeviceAgentStatus, IPC_VERSION,
} from '../daemon/ipc/ipcRoutes.js';
import { ErrorCode } from '../types.js';
import { EXIT_FAILED, EXIT_OK } from '../devices/login/deviceLogin.js';
import { plain } from './helpers/fakeDashboard.js';

/**
 * The CLI's half of `pinggy device connect -b`: a new token is checked before the daemon sees it, the
 * daemon starts the agent from device.json, and the CLI exits once the device connects. No daemon, no
 * dashboard and no terminal: every dependency is a fake.
 */

const STORED_TOKEN = 'pga_stored_token';
const NEW_TOKEN = 'pga_new_token';
const DEVICE_ID = '0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d';
const LOG_PATH = '/home/user/.local/state/pinggy-cli/logs/daemon.log';

const STORED: DeviceIdentity = {
    device_agent_id: DEVICE_ID, token: STORED_TOKEN, server: 'dashboard.pinggy.io', enrolled_at: null,
};

function daemon(host: DaemonHost = DaemonHost.CLI): DaemonInfo {
    return { pid: 4242, port: 5555, startedAt: '2026-10-15T10:00:00.000Z', host, ipcVersion: IPC_VERSION };
}

function status(state: DeviceAgentState, extra: Partial<DeviceAgentStatus> = {}): DeviceAgentStatus {
    return {
        state, deviceAgentId: DEVICE_ID, server: 'dashboard.pinggy.io', email: null, deviceUrl: null,
        startedAt: null, connectedAt: null, startedBy: 'cli', lastError: null, ...extra,
    };
}

const CONNECTED = status(DeviceAgentState.Connected, {
    email: 'owner@example.com',
    deviceUrl: `https://dashboard.pinggy.io/pinggy-devices/${DEVICE_ID}`,
    connectedAt: '2026-10-15T10:00:01.000Z',
});

interface FakeDaemonAgent {
    statuses: DeviceAgentStatus[];
    startAnswer?: DeviceAgentStatus | { code: string; message: string };
    failure?: Error;
}

/** Calls in the order they happened, and every line printed. */
function harness(options: {
    stored?: DeviceIdentity | null;
    running?: DaemonInfo | null;
    started?: DaemonInfo | Error;
    verified?: DeviceAgentEnd;
    agent?: FakeDaemonAgent;
} = {}) {
    const calls: string[] = [];
    const printed: string[] = [];
    const agent: FakeDaemonAgent = options.agent ?? { statuses: [CONNECTED] };
    let clockMillis = 0;

    const nextStatus = () => (agent.statuses.length > 1 ? agent.statuses.shift()! : agent.statuses[0]);
    const client: DeviceAgentDaemonClient = {
        getDeviceAgentStatus: async () => {
            calls.push('status');
            if (agent.failure) throw agent.failure;
            return nextStatus();
        },
        startDeviceAgent: async () => {
            calls.push('start');
            if (agent.failure) throw agent.failure;
            return (agent.startAnswer ?? status(DeviceAgentState.Connecting)) as DeviceAgentStatus;
        },
        stopDeviceAgent: async () => {
            calls.push('stop');
            if (agent.failure) throw agent.failure;
            return status(DeviceAgentState.Stopped);
        },
    };

    const dependencies: BackgroundAgentDependencies = {
        readIdentity: () => (options.stored === undefined ? STORED : options.stored),
        findDaemon: () => options.running ?? null,
        ensureDaemon: async () => {
            calls.push('ensureDaemon');
            if (options.started instanceof Error) throw options.started;
            return options.started ?? daemon();
        },
        client: () => client,
        verify: async (token, manage) => {
            calls.push(`verify ${token} ${manage}`);
            return options.verified ?? { error: null, welcomed: true };
        },
        sleep: async (millis) => { clockMillis += millis; },
        now: () => clockMillis,
        print: (message) => { printed.push(plain(message)); },
        printSuccess: (message) => { printed.push(plain(message)); },
        printWarning: (message) => { printed.push(`warning: ${plain(message)}`); },
        printError: (message) => { printed.push(`error: ${plain(message)}`); },
        daemonLogPath: () => LOG_PATH,
    };
    return { dependencies, calls, printed };
}

describe('differsFromStored', () => {
    test('the stored token on the stored server does not differ', () => {
        expect(differsFromStored({ token: STORED_TOKEN, manage: 'dashboard.pinggy.io' }, STORED)).toBe(false);
    });

    test('no --manage means dashboard.pinggy.io', () => {
        expect(differsFromStored({ token: STORED_TOKEN, manage: undefined }, STORED)).toBe(false);
    });

    test.each([
        ['another token', { token: NEW_TOKEN, manage: undefined }],
        ['another server', { token: STORED_TOKEN, manage: 'ws://dashboard.localhost.pinggy.io' }],
    ])('%s differs', (_label, target) => {
        expect(differsFromStored(target, STORED)).toBe(true);
    });

    test('anything differs from no device.json', () => {
        expect(differsFromStored({ token: NEW_TOKEN, manage: undefined }, null)).toBe(true);
    });
});

describe('connect -b', () => {
    test('a new token is verified before the daemon is asked', async () => {
        const cli = harness();

        expect(await startAgentInBackground({ token: NEW_TOKEN, manage: undefined }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.calls.slice(0, 3)).toEqual([`verify ${NEW_TOKEN} undefined`, 'ensureDaemon', 'start']);
    });

    // A token the dashboard refuses never reaches device.json, and the daemon never hears of it.
    test('a refused token stops before the daemon, with the refusal', async () => {
        const cli = harness({
            verified: { error: { code: 'unauthorized', message: 'Unauthorized.' }, welcomed: false },
        });

        expect(await startAgentInBackground({ token: NEW_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_FAILED);

        expect(cli.calls).toEqual([`verify ${NEW_TOKEN} undefined`]);
        expect(cli.printed).toEqual(['error: Unauthorized.']);
    });

    test('the stored token is not verified again', async () => {
        const cli = harness();

        await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies);

        expect(cli.calls[0]).toBe('ensureDaemon');
    });

    test('once connected, prints the device and how to stop it', async () => {
        const cli = harness({ agent: { statuses: [status(DeviceAgentState.Connecting), CONNECTED] } });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_OK);

        expect(cli.printed).toEqual([
            'Starting the device agent in the background...',
            `Running in the background as device ${DEVICE_ID}`,
            'Signed in as owner@example.com',
            'Open the device in a browser:',
            '',
            `  https://dashboard.pinggy.io/pinggy-devices/${DEVICE_ID}`,
            '',
            `Logs: ${LOG_PATH}`,
            'Stop it with: pinggy device stop',
        ]);
    });

    test('inside the Pinggy app, says the agent stops when the app quits', async () => {
        const cli = harness({ started: daemon(DaemonHost.APP) });

        await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies);

        expect(cli.printed).toContain('It runs inside the Pinggy app, and stops when the app quits.');
    });

    test('an agent that stops before it connects fails with why', async () => {
        const cli = harness({
            agent: {
                statuses: [status(DeviceAgentState.Stopped, {
                    lastError: { code: 'revoked', message: 'Credential revoked.' },
                })],
            },
        });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_FAILED);
        expect(cli.printed.at(-1)).toBe('error: Credential revoked.');
    });

    test('an agent still connecting after 15 s is left to the daemon', async () => {
        const cli = harness({ agent: { statuses: [status(DeviceAgentState.Connecting)] } });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_OK);
        expect(cli.printed.at(-1))
            .toBe('warning: Still connecting in the background. Check with: pinggy device status');
    });

    // A refusal before the daemon's agent starts prints only the refusal: no line says it is starting.
    test('device_not_enrolled from the daemon fails with its message alone', async () => {
        const cli = harness({
            agent: {
                statuses: [CONNECTED],
                startAnswer: { code: ErrorCode.DeviceNotEnrolled, message: 'Not enrolled.' },
            },
        });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_FAILED);
        expect(cli.printed).toEqual(['error: Not enrolled.']);
    });

    test('a daemon on another IPC version fails with what to do, and nothing about starting', async () => {
        const cli = harness({ started: new Error('A daemon from a different Pinggy CLI version is running.') });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_FAILED);
        expect(cli.printed).toEqual(['error: A daemon from a different Pinggy CLI version is running.']);
    });

    // A daemon from before slice 17 answers the device routes with 404.
    test.each([
        [DaemonHost.CLI, 'pinggy daemon stop'],
        [DaemonHost.APP, 'Update the Pinggy app'],
    ])('a daemon hosted by %s that predates the routes says what to do', async (host, advice) => {
        const cli = harness({
            started: daemon(host),
            agent: { statuses: [CONNECTED], failure: new IPCHttpError(404, 'Daemon returned HTTP 404') },
        });

        expect(await startAgentInBackground({ token: STORED_TOKEN, manage: undefined }, cli.dependencies))
            .toBe(EXIT_FAILED);
        expect(cli.printed).toEqual([`error: ${olderDaemonMessage(daemon(host))}`]);
        expect(cli.printed.at(-1)).toContain(advice);
    });
});

describe('a foreground agent while the daemon runs one', () => {
    test('is refused, naming the device', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        expect(await foregroundRefusal(cli.dependencies)).toBe(`This machine already runs as device ${DEVICE_ID} `
            + 'in the background. Stop it first: pinggy device stop');
    });

    test.each([
        ['no daemon', { running: null }],
        ['a stopped agent', { running: daemon(), agent: { statuses: [status(DeviceAgentState.Stopped)] } }],
        ['a daemon from before the routes', {
            running: daemon(), agent: { statuses: [CONNECTED], failure: new IPCHttpError(404, 'HTTP 404') },
        }],
        ['a daemon on another IPC version', { running: { ...daemon(), ipcVersion: IPC_VERSION + 1 } }],
    ])('runs with %s', async (_label, options) => {
        const cli = harness(options);

        expect(await foregroundRefusal(cli.dependencies)).toBeNull();
    });
});

describe('device stop and remove', () => {
    test('stop with no agent running says so and succeeds', async () => {
        const cli = harness();

        expect(await stopAgentInBackground(cli.dependencies)).toBe(EXIT_OK);
        expect(cli.printed).toEqual(['No device agent is running in the background.']);
    });

    test('stop asks the daemon to stop its agent', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        expect(await stopAgentInBackground(cli.dependencies)).toBe(EXIT_OK);
        expect(cli.calls).toEqual(['status', 'stop']);
        expect(cli.printed).toEqual(['Stopped. The device shows offline in the dashboard.']);
    });

    test('remove stops a running agent first', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        expect(await stopAgentBeforeRemove(cli.dependencies)).toBe(true);
        expect(cli.calls).toEqual(['status', 'stop']);
    });

    test('remove with no agent running stops nothing', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [status(DeviceAgentState.Stopped)] } });

        expect(await stopAgentBeforeRemove(cli.dependencies)).toBe(true);
        expect(cli.calls).toEqual(['status']);
    });
});

describe('handleDevice', () => {
    let printed: string[];
    let logSpy: ReturnType<typeof jest.spyOn>;
    let errorSpy: ReturnType<typeof jest.spyOn>;
    let exitSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        printed = [];
        const capture = (...args: unknown[]) => { printed.push(plain(args.map(String).join(' '))); };
        logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(capture);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
        delete process.env[DEVICE_AGENT_TOKEN_VARIABLE];
    });

    // The daemon copies the CLI's environment when it spawns, and every shell copies the daemon's.
    test('connect -b removes DEVICE_AGENT_TOKEN before a daemon can start', async () => {
        process.env[DEVICE_AGENT_TOKEN_VARIABLE] = NEW_TOKEN;
        const cli = harness({ stored: null });
        let variableWhenDaemonStarted: string | undefined = 'not called';
        const ensureDaemon = cli.dependencies.ensureDaemon;
        cli.dependencies.ensureDaemon = () => {
            variableWhenDaemonStarted = process.env[DEVICE_AGENT_TOKEN_VARIABLE];
            return ensureDaemon();
        };

        await handleDevice(['connect', '-b'], cli.dependencies);

        expect(cli.calls[0]).toBe(`verify ${NEW_TOKEN} undefined`);
        expect(variableWhenDaemonStarted).toBeUndefined();
    });

    test('connect without -b is refused while the daemon runs an agent', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        await expect(handleDevice(['connect'], cli.dependencies)).rejects.toThrow('exit 1');
        expect(printed.join('\n')).toContain('Stop it first: pinggy device stop');
    });

    test('stop reaches the daemon', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        await handleDevice(['stop'], cli.dependencies);

        expect(cli.calls).toContain('stop');
    });

    test('status adds the background agent', async () => {
        const cli = harness({ running: daemon(), agent: { statuses: [CONNECTED] } });

        await handleDevice(['status'], cli.dependencies);

        expect(printed).toContain(`  Device id  ${DEVICE_ID}`);
        expect(cli.printed).toEqual(['  Background connected since 2026-10-15T10:00:01.000Z, in the daemon, PID 4242']);
    });
});
