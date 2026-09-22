import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createRequire } from 'module';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { Envelope, request } from '../devices/envelope.js';
import { runDeviceAgent } from '../devices/deviceAgent.js';
import { ReconnectPolicy } from '../devices/reconnect.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';
import { disconnectFrame, redirectConfigHome, startFakeDashboard, welcomeFrame } from './helpers/fakeDashboard.js';

/**
 * Slice T1b on the agent: a shell outlives the socket that opened it.
 *
 * A dropped socket pauses every shell and kills none. The next hello lists them, the dashboard
 * closes the ones it forgot, and welcome resumes the rest. Only the agent stopping kills them. See
 * docs/pinggy-devices/slices/T1b-shells-outlive-the-tab.md in the pinggy_backend repo.
 */

const require = createRequire(import.meta.url);

function setUpHandler() {
    const sent: Envelope[] = [];
    const sessions: FakeSession[] = [];
    let nextPid = 48210;
    const handler = new TerminalHandler({
        send: (frame) => sent.push(frame),
        spawn: (spawnRequest) => {
            const session = fakeSession(nextPid++, spawnRequest.shell, spawnRequest.cols, spawnRequest.rows);
            sessions.push(session);
            return session;
        },
        resolveShell: (requested) => ({ shell: requested ?? '/bin/bash' }),
        registry: new TerminalRegistry<PtySession>(),
    });
    const open = (terminalId: string, cols = 120, rows = 32) =>
        handler.handle(request('terminal', 'open', { terminal_id: terminalId, cols, rows }));
    return { handler, sent, sessions, open };
}

describe('terminal handler across a reconnect', () => {
    test('suspend pauses every shell and kills none', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');
        open('t-2');

        handler.suspend();

        for (const session of sessions) {
            expect(session.pause).toHaveBeenCalledTimes(1);
            expect(session.kill).not.toHaveBeenCalled();
        }
    });

    test('held lists every shell with its pid, shell and current grid', () => {
        const { handler, open } = setUpHandler();
        open('t-1', 120, 32);
        open('t-2', 80, 24);
        handler.handle(request('terminal', 'resize', { terminal_id: 't-2', cols: 100, rows: 30 }));

        expect(handler.held()).toEqual([
            { terminal_id: 't-1', pid: 48210, shell: '/bin/bash', cols: 120, rows: 32 },
            { terminal_id: 't-2', pid: 48211, shell: '/bin/bash', cols: 100, rows: 30 },
        ]);
    });

    test('resumeAll resumes only after a suspend, and only once', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.resumeAll();
        expect(sessions[0].resume).not.toHaveBeenCalled();

        handler.suspend();
        handler.suspend();
        handler.resumeAll();
        handler.resumeAll();

        expect(sessions[0].pause).toHaveBeenCalledTimes(1);
        expect(sessions[0].resume).toHaveBeenCalledTimes(1);
    });

    // The dashboard reconciles while it answers hello, so this close lands before welcome.
    test('a close before welcome kills exactly that shell, and the rest resume', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');
        open('t-2');
        handler.suspend();

        handler.handle(request('terminal', 'close', { terminal_id: 't-1', reason: 'device_gone' }));
        handler.resumeAll();

        expect(sessions[0].kill).toHaveBeenCalled();
        expect(sessions[1].kill).not.toHaveBeenCalled();
        expect(sessions[1].resume).toHaveBeenCalled();
        expect(handler.held().map((shell) => shell.terminal_id)).toEqual(['t-2']);
    });

    test('closeAll kills every shell, suspended or not', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');
        open('t-2');
        handler.suspend();

        handler.closeAll();

        expect(sessions.every((session) => session.kill.mock.calls.length === 1)).toBe(true);
        expect(handler.held()).toEqual([]);
    });
});

describe('terminal resize', () => {
    test('resize is clamped like open', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.handle(request('terminal', 'resize', { terminal_id: 't-1', cols: 50000, rows: 0 }));

        expect(sessions[0].resize).toHaveBeenCalledWith(1000, 1);
    });

    test('resize for a shell this agent does not hold is ignored', () => {
        const { handler, sent } = setUpHandler();

        expect(() => handler.handle(request('terminal', 'resize', { terminal_id: 't-9', cols: 80, rows: 24 })))
            .not.toThrow();
        expect(sent).toHaveLength(0);
    });

    test('a malformed resize is ignored', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.handle(request('terminal', 'resize', { terminal_id: 't-1', cols: 'wide' }));

        expect(sessions[0].resize).not.toHaveBeenCalled();
    });
});

// ---- the whole agent, a real pty, a real pid ----------------------------------------------------

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(condition: () => boolean, timeoutMillis: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMillis;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return condition();
}

const ptyAvailable = (() => {
    try {
        require('node-pty');
        return process.platform !== 'win32';
    } catch {
        return false;
    }
})();

function terminalFrame(op: string, payload: unknown): string {
    return JSON.stringify({ v: 1, kind: 'req', ch: 'terminal', op, id: 'c-1', seq: 0, ts: 0, payload });
}

describe('the agent across a dropped socket', () => {
    let configHome: { cleanup: () => void };
    let shellPid: number | undefined;

    beforeAll(() => {
        configHome = redirectConfigHome();
    });

    afterAll(() => {
        configHome.cleanup();
    });

    afterEach(() => {
        if (shellPid && isAlive(shellPid)) process.kill(shellPid, 'SIGKILL');
    });

    /**
     * Connection 1 opens a shell and drops. Connection 2 must see that shell in hello, alive by pid.
     * Connection 3 hears nothing about it in hello once connection 2 closed it. Then the agent is
     * revoked, which is the 1 path that kills from this side.
     */
    (ptyAvailable ? test : test.skip)('keeps its shell, lists it in hello, and kills it only when stopped', async () => {
        const { ensureSpawnHelperExecutable } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();

        const hellos: Array<Record<string, unknown>> = [];
        let keptPid: number | undefined;
        const dashboard = await startFakeDashboard({
            onHello: (connection, hello) => {
                hellos.push(hello);
                connection.send(welcomeFrame());
                if (connection.index === 1) {
                    connection.send(terminalFrame('open', { terminal_id: 't-kept', cols: 80, rows: 24 }));
                } else if (connection.index === 2) {
                    keptPid = shellPid;
                    connection.drop();
                } else {
                    connection.send(disconnectFrame('revoked'));
                }
            },
            onFrame: (connection, frame) => {
                if (connection.index === 1 && frame.op === 'opened') {
                    shellPid = (frame.payload as { pid: number }).pid;
                    connection.drop();
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: new ReconnectPolicy({ random: () => 0 }) });
        dashboard.close();

        expect(shellPid).toBeDefined();
        expect(hellos).toHaveLength(3);
        expect(hellos[0].terminals).toEqual([]);
        expect(hellos[1].terminals).toEqual([
            { terminal_id: 't-kept', pid: shellPid, shell: expect.any(String), cols: 80, rows: 24 },
        ]);
        expect(keptPid).toBe(shellPid);
        // Still listed after a second drop: nothing but a close or the agent stopping ends it.
        expect(hellos[2].terminals).toHaveLength(1);

        // Revoked: the loop ended, and closeAll took the shell with it.
        expect(await waitUntil(() => !isAlive(shellPid as number), 5000)).toBe(true);
    }, 20000);

    (ptyAvailable ? test : test.skip)('a close from the reconciling dashboard kills the shell before welcome', async () => {
        const { ensureSpawnHelperExecutable } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();

        const hellos: Array<Record<string, unknown>> = [];
        const dashboard = await startFakeDashboard({
            onHello: (connection, hello) => {
                hellos.push(hello);
                if (connection.index === 1) {
                    connection.send(welcomeFrame());
                    connection.send(terminalFrame('open', { terminal_id: 't-forgotten', cols: 80, rows: 24 }));
                } else if (connection.index === 2) {
                    // The dashboard lost this shell during the gap. It says so before it says welcome.
                    connection.send(JSON.stringify({
                        v: 1, kind: 'event', ch: 'terminal', op: 'close', id: '', seq: 0, ts: 0,
                        payload: { terminal_id: 't-forgotten', reason: 'device_gone' },
                    }));
                    connection.send(welcomeFrame());
                    setTimeout(() => connection.drop(), 200);
                } else {
                    connection.send(welcomeFrame());
                    connection.send(disconnectFrame('revoked'));
                }
            },
            onFrame: (connection, frame) => {
                if (connection.index === 1 && frame.op === 'opened') {
                    shellPid = (frame.payload as { pid: number }).pid;
                    connection.drop();
                }
            },
        });

        await runDeviceAgent('token', dashboard.url, { reconnectPolicy: new ReconnectPolicy({ random: () => 0 }) });
        dashboard.close();

        expect(hellos[1].terminals).toHaveLength(1);
        expect(hellos[2].terminals).toEqual([]);
        expect(await waitUntil(() => !isAlive(shellPid as number), 5000)).toBe(true);
    }, 20000);
});
