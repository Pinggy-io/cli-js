import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import { ChildProcess, spawn } from 'child_process';

import {
    ForegroundAgentRecord, ForegroundStopDependencies, foregroundAgentRefusal, readForegroundAgent,
    recordForegroundAgent, stopForegroundAgentBeforeRemove,
} from '../devices/foregroundAgent.js';
import { runDeviceAgent } from '../devices/deviceAgent.js';
import { getForegroundAgentPath } from '../utils/configDir.js';
import { plain, redirectConfigHome, startFakeDashboard, welcomeFrame } from './helpers/fakeDashboard.js';

/**
 * device-agent.json: a foreground agent records its PID, and `pinggy device remove` deletes the record to
 * stop it. No signal goes to the PID, so a stale record never stops an unrelated process.
 */

let configHome: { cleanup: () => void };

beforeAll(() => {
    configHome = redirectConfigHome();
});

afterAll(() => {
    configHome.cleanup();
});

afterEach(() => {
    fs.rmSync(getForegroundAgentPath(), { force: true });
});

function writeRecord(record: ForegroundAgentRecord): void {
    fs.writeFileSync(getForegroundAgentPath(), JSON.stringify(record));
}

/** Another live process, so a record does not name this test's own PID. */
function startOtherProcess(): ChildProcess {
    return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

function exited(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('the record', () => {
    test('names this process while the agent runs, and goes away on release', () => {
        const release = recordForegroundAgent(() => undefined);

        const record = JSON.parse(fs.readFileSync(getForegroundAgentPath(), 'utf-8')) as ForegroundAgentRecord;
        expect(record.pid).toBe(process.pid);

        release();
        expect(fs.existsSync(getForegroundAgentPath())).toBe(false);
    });

    test('release leaves a record that names another process', () => {
        const release = recordForegroundAgent(() => undefined);
        writeRecord({ pid: process.pid + 1, started_at: new Date().toISOString() });

        release();

        expect(fs.existsSync(getForegroundAgentPath())).toBe(true);
    });

    test('a deleted record calls back once', () => {
        jest.useFakeTimers();
        try {
            const onDeleted = jest.fn();
            const release = recordForegroundAgent(onDeleted);

            jest.advanceTimersByTime(3000);
            expect(onDeleted).not.toHaveBeenCalled();

            fs.rmSync(getForegroundAgentPath());
            jest.advanceTimersByTime(3000);
            expect(onDeleted).toHaveBeenCalledTimes(1);
            release();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('reading the record', () => {
    test('a live process is a running agent', async () => {
        const other = startOtherProcess();
        try {
            writeRecord({ pid: other.pid!, started_at: new Date().toISOString() });

            expect(readForegroundAgent()?.pid).toBe(other.pid);
            expect(foregroundAgentRefusal()).toContain(`PID ${other.pid}`);
        } finally {
            other.kill();
            await exited(other);
        }
    });

    test('a process that exited leaves a stale record, which is deleted', async () => {
        const other = startOtherProcess();
        other.kill();
        await exited(other);
        writeRecord({ pid: other.pid!, started_at: new Date().toISOString() });

        expect(readForegroundAgent()).toBeNull();
        expect(fs.existsSync(getForegroundAgentPath())).toBe(false);
    });

    test('a record from before the last boot is stale, even when its PID is alive now', async () => {
        const other = startOtherProcess();
        try {
            writeRecord({ pid: other.pid!, started_at: '2000-01-01T00:00:00.000Z' });

            expect(readForegroundAgent()).toBeNull();
            expect(fs.existsSync(getForegroundAgentPath())).toBe(false);
        } finally {
            other.kill();
            await exited(other);
        }
    });

    test('this process is never another agent', () => {
        writeRecord({ pid: process.pid, started_at: new Date().toISOString() });

        expect(readForegroundAgent()).toBeNull();
        expect(foregroundAgentRefusal()).toBeNull();
    });
});

describe('stopping before remove', () => {
    const RECORD: ForegroundAgentRecord = { pid: 4242, started_at: '2026-11-05T10:00:00.000Z' };

    function fakes(options: { record: ForegroundAgentRecord | null; aliveChecks: number }) {
        const calls: string[] = [];
        const printed: string[] = [];
        let clockMillis = 0;
        let aliveChecksLeft = options.aliveChecks;
        const dependencies: ForegroundStopDependencies = {
            readAgent: () => options.record,
            deleteRecord: () => { calls.push('delete'); },
            isAlive: () => aliveChecksLeft-- > 0,
            sleep: async (millis) => { clockMillis += millis; },
            now: () => clockMillis,
            print: (message) => { printed.push(message); },
            printError: (message) => { printed.push(`error: ${message}`); },
        };
        return { dependencies, calls, printed };
    }

    test('no agent: nothing to stop', async () => {
        const { dependencies, calls } = fakes({ record: null, aliveChecks: 0 });

        expect(await stopForegroundAgentBeforeRemove(dependencies)).toBe(true);
        expect(calls).toEqual([]);
    });

    test('deletes the record and waits for the agent to exit', async () => {
        const { dependencies, calls, printed } = fakes({ record: RECORD, aliveChecks: 3 });

        expect(await stopForegroundAgentBeforeRemove(dependencies)).toBe(true);
        expect(calls).toEqual(['delete']);
        expect(printed).toEqual(['Stopped the device agent running in another terminal (PID 4242).']);
    });

    test('an agent that never exits fails the remove, so device.json stays', async () => {
        const { dependencies, printed } = fakes({ record: RECORD, aliveChecks: Number.POSITIVE_INFINITY });

        expect(await stopForegroundAgentBeforeRemove(dependencies)).toBe(false);
        expect(printed[0]).toContain('error: The device agent in another terminal (PID 4242) did not stop');
    });
});

describe('a running foreground agent', () => {
    let printed: string[];
    let warnSpy: ReturnType<typeof jest.spyOn>;
    let logSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        printed = [];
        const capture = (...args: unknown[]) => { printed.push(plain(args.map(String).join(' '))); };
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(capture);
        logSpy = jest.spyOn(console, 'log').mockImplementation(capture);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        logSpy.mockRestore();
    });

    test('stops when its record is deleted, and leaves no record behind', async () => {
        const dashboard = await startFakeDashboard({
            onHello: (connection) => {
                connection.send(welcomeFrame());
                fs.rmSync(getForegroundAgentPath());
            },
        });

        await runDeviceAgent('token', dashboard.url);

        expect(dashboard.connections()).toBe(1);
        expect(printed.join(' ')).toContain('pinggy device remove ran in another terminal');
        expect(fs.existsSync(getForegroundAgentPath())).toBe(false);
        dashboard.close();
    }, 15000);
});
