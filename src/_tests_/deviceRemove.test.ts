import { describe, test, expect } from '@jest/globals';

import { DeviceRemoveDependencies, runDeviceRemove } from '../devices/removeDevice.js';
import { BackgroundAgentDependencies } from '../devices/backgroundAgent.js';
import { ForegroundAgentRecord } from '../devices/foregroundAgent.js';
import { DeviceIdentity } from '../devices/deviceIdentity.js';
import { DaemonHost, DeviceAgentState, DeviceAgentStatus, IPC_VERSION } from '../daemon/ipc/ipcRoutes.js';
import { EXIT_FAILED, EXIT_OK } from '../devices/login/deviceLogin.js';
import { plain } from './helpers/fakeDashboard.js';

/**
 * `pinggy device remove`: it says which device this is and whether it is connected, asks, and only a yes
 * stops the agents and deletes device.json. No daemon, no terminal and no file: every dependency is a fake.
 */

const DEVICE_ID = '0a7d3f6c-2b41-4e8a-9c5d-1e2f3a4b5c6d';
const STORED: DeviceIdentity = {
    device_agent_id: DEVICE_ID, token: 'pga_stored_token', server: 'dashboard.pinggy.io', enrolled_at: null,
};
const QUESTION = 'Remove this device from this machine? [y/N] ';

function agentStatus(state: DeviceAgentState): DeviceAgentStatus {
    return {
        state, deviceAgentId: DEVICE_ID, server: 'dashboard.pinggy.io', email: null, deviceUrl: null,
        startedAt: null, connectedAt: '2026-11-05T10:00:01.000Z', startedBy: 'cli', lastError: null,
    };
}

function harness(options: {
    stored?: DeviceIdentity | null;
    background?: DeviceAgentState | null;
    foreground?: ForegroundAgentRecord | null;
    interactive?: boolean;
    answer?: string;
} = {}) {
    const calls: string[] = [];
    const printed: string[] = [];
    const asked: string[] = [];
    let backgroundState = options.background ?? null;
    let foregroundRecord = options.foreground ?? null;

    const background = {
        readIdentity: () => (options.stored === undefined ? STORED : options.stored),
        readForegroundAgent: () => foregroundRecord,
        findDaemon: () => (backgroundState
            ? { pid: 4242, port: 5555, startedAt: '', host: DaemonHost.CLI, ipcVersion: IPC_VERSION }
            : null),
        client: () => ({
            getDeviceAgentStatus: async () => agentStatus(backgroundState ?? DeviceAgentState.Stopped),
            stopDeviceAgent: async () => {
                calls.push('stop background');
                backgroundState = DeviceAgentState.Stopped;
                return agentStatus(DeviceAgentState.Stopped);
            },
        }),
        print: (message: string) => { printed.push(plain(message)); },
        printSuccess: (message: string) => { printed.push(plain(message)); },
        printWarning: (message: string) => { printed.push(plain(message)); },
        printError: (message: string) => { printed.push(`error: ${plain(message)}`); },
    } as unknown as BackgroundAgentDependencies;

    const dependencies: DeviceRemoveDependencies = {
        background,
        foreground: {
            readAgent: () => foregroundRecord,
            deleteRecord: () => {
                calls.push('stop foreground');
                foregroundRecord = null;
            },
            isAlive: () => false,
            sleep: async () => undefined,
            now: () => 0,
            print: (message) => { printed.push(message); },
            printError: (message) => { printed.push(`error: ${message}`); },
        },
        clearIdentity: () => {
            calls.push('delete device.json');
            return true;
        },
        isInteractive: () => options.interactive ?? true,
        prompter: {
            ask: async (question) => {
                asked.push(question);
                return options.answer ?? '';
            },
            askHidden: async () => '',
        },
        print: (message) => { printed.push(plain(message)); },
        printSuccess: (message) => { printed.push(plain(message)); },
        printError: (message) => { printed.push(`error: ${plain(message)}`); },
    };
    return { dependencies, calls, printed, asked };
}

describe('device remove', () => {
    test('names the device, says it is not connected, and asks', async () => {
        const cli = harness({ answer: 'y' });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.printed).toContain(`This machine is device ${DEVICE_ID} on dashboard.pinggy.io.`);
        expect(cli.printed).toContain('The device is not connected now.');
        expect(cli.asked).toEqual([QUESTION]);
        expect(cli.calls).toEqual(['delete device.json']);
    });

    test('says the device is connected in the background, then stops it after a yes', async () => {
        const cli = harness({ background: DeviceAgentState.Connected, answer: 'yes' });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.printed).toContain('The device agent runs in the background: '
            + 'connected since 2026-11-05T10:00:01.000Z, in the daemon, PID 4242.');
        expect(cli.printed).toContain('Removing it stops the agent, and the device shows offline in the dashboard.');
        expect(cli.calls).toEqual(['stop background', 'delete device.json']);
    });

    test('says the device runs in another terminal, then stops it after a yes', async () => {
        const cli = harness({ foreground: { pid: 777, started_at: '2026-11-05T10:00:00.000Z' }, answer: 'Y' });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.printed).toContain('The device agent runs in another terminal, PID 777.');
        expect(cli.calls).toEqual(['stop foreground', 'delete device.json']);
    });

    test.each(['', 'n', 'no', 'maybe'])('the answer %p removes nothing and stops nothing', async (answer) => {
        const cli = harness({ background: DeviceAgentState.Connected, answer });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.printed).toContain('Nothing removed.');
        expect(cli.calls).toEqual([]);
    });

    test('-f removes without asking, with no terminal', async () => {
        const cli = harness({ background: DeviceAgentState.Connected, interactive: false });

        expect(await runDeviceRemove({ skipConfirmation: true }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.asked).toEqual([]);
        expect(cli.calls).toEqual(['stop background', 'delete device.json']);
    });

    test('no terminal and no -f: refuses, and removes nothing', async () => {
        const cli = harness({ interactive: false });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_FAILED);

        expect(cli.printed[0]).toContain('add -f to remove without asking');
        expect(cli.asked).toEqual([]);
        expect(cli.calls).toEqual([]);
    });

    test('a machine that is not enrolled asks nothing', async () => {
        const cli = harness({ stored: null });

        expect(await runDeviceRemove({ skipConfirmation: false }, cli.dependencies)).toBe(EXIT_OK);

        expect(cli.printed).toEqual(['This machine is not enrolled.']);
        expect(cli.asked).toEqual([]);
        expect(cli.calls).toEqual([]);
    });
});
