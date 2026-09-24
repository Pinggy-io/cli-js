import { describe, test, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { TerminalRegistry, TerminalHandle } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';
import { Envelope, event, request } from '../devices/envelope.js';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

function fakeHandle(pid: number): TerminalHandle & { kill: jest.Mock } {
    return { pid, kill: jest.fn() };
}

describe('terminal registry', () => {
    test('maps each terminal id to its own handle', () => {
        const registry = new TerminalRegistry();
        const first = fakeHandle(101);
        const second = fakeHandle(102);

        expect(registry.add('t-1', first)).toBe(true);
        expect(registry.add('t-2', second)).toBe(true);

        expect(registry.get('t-1')).toBe(first);
        expect(registry.get('t-2')).toBe(second);
        expect(registry.size()).toBe(2);
    });

    test('an id already taken is refused, and the first handle is kept', () => {
        const registry = new TerminalRegistry();
        const first = fakeHandle(101);
        registry.add('t-1', first);

        expect(registry.add('t-1', fakeHandle(102))).toBe(false);
        expect(registry.get('t-1')).toBe(first);
    });

    test('the ceiling from welcome holds', () => {
        const registry = new TerminalRegistry();
        registry.setMaxTerminals(2);
        registry.add('t-1', fakeHandle(1));
        registry.add('t-2', fakeHandle(2));

        expect(registry.isFull()).toBe(true);
        expect(registry.add('t-3', fakeHandle(3))).toBe(false);
    });

    test('remove returns the handle once, then nothing', () => {
        const registry = new TerminalRegistry();
        const handle = fakeHandle(1);
        registry.add('t-1', handle);

        expect(registry.remove('t-1')).toBe(handle);
        expect(registry.remove('t-1')).toBeUndefined();
    });

    test('killAll kills every handle, even when 1 throws', () => {
        const registry = new TerminalRegistry();
        const throwing = fakeHandle(1);
        throwing.kill.mockImplementation(() => { throw new Error('already gone'); });
        const other = fakeHandle(2);
        registry.add('t-1', throwing);
        registry.add('t-2', other);

        registry.killAll();

        expect(other.kill).toHaveBeenCalled();
        expect(registry.size()).toBe(0);
    });
});

// ---- the handler, against a fake pty -------------------------------------------------------------

const TEST_WINDOW_BYTES = 262144;
const TEST_MAX_FRAME_BYTES = 32768;

function openFrame(payload: unknown): Envelope {
    return request('terminal', 'open', payload);
}

function setUpHandler() {
    const sent: Envelope[] = [];
    const sessions: FakeSession[] = [];
    let nextPid = 48210;
    const handler = new TerminalHandler({
        send: (frame) => sent.push(frame),
        spawn: (spawnRequest) => {
            const session = fakeSession(nextPid++, spawnRequest.shell);
            sessions.push(session);
            return session;
        },
        resolveShell: (requested) => (requested === '/usr/bin/python3'
            ? { error: 'not allowed' }
            : { shell: requested ?? '/bin/bash' }),
        registry: new TerminalRegistry<PtySession>(),
    });
    handler.configure(undefined, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES);
    return { handler, sent, sessions };
}

describe('terminal handler', () => {
    test('open answers opened on the request id, with the terminal id in the payload and the pid', () => {
        const { handler, sent } = setUpHandler();
        const open = openFrame({ terminal_id: 't-1', cols: 120, rows: 32, shell: null, cwd: null });

        handler.handle(open);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'res', ch: 'terminal', op: 'opened', id: open.id });
        expect(sent[0].payload).toEqual({ terminal_id: 't-1', pid: 48210, shell: '/bin/bash', cols: 120, rows: 32 });
    });

    test('a second open on the same device gets its own shell', () => {
        const { handler, sent, sessions } = setUpHandler();

        handler.handle(openFrame({ terminal_id: 't-1' }));
        handler.handle(openFrame({ terminal_id: 't-2' }));

        expect(sessions).toHaveLength(2);
        expect((sent[0].payload as { pid: number }).pid).not.toBe((sent[1].payload as { pid: number }).pid);
    });

    test('a shell not on the allowlist is refused before anything spawns', () => {
        const { handler, sent, sessions } = setUpHandler();

        handler.handle(openFrame({ terminal_id: 't-1', shell: '/usr/bin/python3' }));

        expect(sessions).toHaveLength(0);
        expect(sent[0].payload).toMatchObject({ terminal_id: 't-1', error: { code: 'shell_not_allowed' } });
    });

    test('the grid is clamped to 1..1000', () => {
        const { handler, sent } = setUpHandler();

        handler.handle(openFrame({ terminal_id: 't-1', cols: 50000, rows: -3 }));

        expect(sent[0].payload).toMatchObject({ cols: 1000, rows: 1 });
    });

    test('welcome can disable terminals', () => {
        const { handler, sent, sessions } = setUpHandler();
        handler.configure(false, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES);

        handler.handle(openFrame({ terminal_id: 't-1' }));

        expect(sessions).toHaveLength(0);
        expect(sent[0].payload).toMatchObject({ error: { code: 'terminal_disabled' } });
    });

    test('close from the dashboard kills the shell and sends nothing back', () => {
        const { handler, sent, sessions } = setUpHandler();
        handler.handle(openFrame({ terminal_id: 't-1' }));
        sent.length = 0;

        handler.handle(request('terminal', 'close', { terminal_id: 't-1', reason: 'user_closed' }));
        sessions[0].exit(0);

        expect(sessions[0].kill).toHaveBeenCalled();
        expect(sent).toHaveLength(0);
    });

    test('a shell that exits on its own sends exit then close, once', () => {
        const { handler, sent, sessions } = setUpHandler();
        handler.handle(openFrame({ terminal_id: 't-1' }));
        sent.length = 0;

        sessions[0].exit(0);
        sessions[0].exit(0);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({ kind: 'event', op: 'exit', payload: { terminal_id: 't-1', exit_code: 0, signal: null } });
        expect(sent[1]).toMatchObject({ kind: 'event', op: 'close', payload: { terminal_id: 't-1', reason: 'user_closed' } });
    });

    test('an unknown terminal op is ignored, never fatal', () => {
        const { handler, sent } = setUpHandler();

        expect(() => handler.handle(request('terminal', 'frobnicate', {}))).not.toThrow();
        expect(sent).toHaveLength(0);
    });

    test('closeAll kills every shell the socket held', () => {
        const { handler, sessions } = setUpHandler();
        handler.handle(openFrame({ terminal_id: 't-1' }));
        handler.handle(openFrame({ terminal_id: 't-2' }));

        handler.closeAll();

        expect(sessions.every((session) => session.kill.mock.calls.length === 1)).toBe(true);
    });
});

// ---- a real pty, a real pid ---------------------------------------------------------------------

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

// ---- T2: output, the window, exit ---------------------------------------------------------------

// Small enough that a test can fill it by hand. 1024 leaves 384 raw bytes per frame after base64.
const SMALL_WINDOW_BYTES = 100;
const SMALL_MAX_FRAME_BYTES = 1024;
const BUNDLE_WAIT_MILLIS = 20;

function setUpSmallWindow() {
    const setup = setUpHandler();
    setup.handler.configure(undefined, undefined, SMALL_WINDOW_BYTES, SMALL_MAX_FRAME_BYTES);
    setup.handler.handle(openFrame({ terminal_id: 't-1' }));
    setup.sent.length = 0;
    return setup;
}

function ackFrame(ackBytes: number): Envelope {
    return event('terminal', 'ack', { terminal_id: 't-1', ack_seq: 0, ack_bytes: ackBytes });
}

function dataSent(sent: Envelope[]): string {
    return sent.filter((frame) => frame.op === 'data')
        .map((frame) => Buffer.from((frame.payload as { data: string }).data, 'base64').toString())
        .join('');
}

describe('terminal handler, output and the window', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('output flows up as data, base64, byte for byte', () => {
        const { sent, sessions } = setUpSmallWindow();

        sessions[0].print('\u001b[32mgreen\u001b[0m');
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        expect(sent[0]).toMatchObject({ kind: 'event', ch: 'terminal', op: 'data', payload: { terminal_id: 't-1' } });
        expect(dataSent(sent)).toBe('\u001b[32mgreen\u001b[0m');
    });

    // The done criterion that matters most. A window that never closes is the same as no window.
    test('at remaining 0 the agent pauses the pty, and does not resume on its own', () => {
        const { sent, sessions } = setUpSmallWindow();

        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        expect(sessions[0].pause).toHaveBeenCalledTimes(1);
        expect(sessions[0].resume).not.toHaveBeenCalled();

        jest.advanceTimersByTime(60_000);
        expect(sessions[0].resume).not.toHaveBeenCalled();
        expect(dataSent(sent)).toHaveLength(SMALL_WINDOW_BYTES);
    });

    test('an ack that reopens the window resumes the pty', () => {
        const { handler, sessions } = setUpSmallWindow();
        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        handler.handle(ackFrame(40));

        expect(sessions[0].resume).toHaveBeenCalledTimes(1);
    });

    test('a window below full does not pause at all', () => {
        const { sessions } = setUpSmallWindow();

        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES - 1));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        expect(sessions[0].pause).not.toHaveBeenCalled();
    });

    test('a dropped ack self-heals: the next cumulative one still reopens the window', () => {
        const { handler, sessions } = setUpSmallWindow();
        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        // The ack for 30 is lost. The ack for 60 carries the total anyway.
        handler.handle(ackFrame(60));

        expect(sessions[0].resume).toHaveBeenCalledTimes(1);
    });

    test('an ack claiming more than was sent cannot open a window wider than its size', () => {
        const { handler, sent, sessions } = setUpSmallWindow();
        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);
        handler.handle(ackFrame(999999));
        sent.length = 0;

        sessions[0].print('y'.repeat(SMALL_WINDOW_BYTES));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        expect(sessions[0].pause).toHaveBeenCalledTimes(2);
        expect(dataSent(sent)).toHaveLength(SMALL_WINDOW_BYTES);
    });

    test('an ack for a terminal this agent does not hold is ignored', () => {
        const { handler } = setUpSmallWindow();

        expect(() => handler.handle(event('terminal', 'ack', { terminal_id: 'nope', ack_bytes: 10 }))).not.toThrow();
    });

    test('what the shell printed on its way out is sent before exit', () => {
        const { sent, sessions } = setUpSmallWindow();

        sessions[0].print('bye');
        sessions[0].exit(0);

        expect(sent.map((frame) => frame.op)).toEqual(['data', 'exit', 'close']);
        expect(dataSent(sent)).toBe('bye');
    });

    test('a shell killed by a signal reports exit_code null and names the signal', () => {
        const { sent, sessions } = setUpSmallWindow();

        sessions[0].exit(0, 2);

        expect(sent[0]).toMatchObject({ op: 'exit', payload: { terminal_id: 't-1', exit_code: null, signal: 'INT' } });
    });

    test('an agent whose welcome carried no window refuses to open, rather than running unbraked', () => {
        const { handler, sent, sessions } = setUpHandler();
        handler.configure(undefined, undefined, undefined, TEST_MAX_FRAME_BYTES);

        handler.handle(openFrame({ terminal_id: 't-2' }));

        expect(sessions).toHaveLength(0);
        expect(sent[0].payload).toMatchObject({ error: { code: 'terminal_disabled' } });
    });

    // The dashboard closes a terminal with sequence_gap on a hole, so seq 0 on every frame kills it.
    test('data frames carry a per-terminal seq from 1, and 2 terminals count separately', () => {
        const { handler, sent, sessions } = setUpSmallWindow();
        handler.handle(openFrame({ terminal_id: 't-2' }));
        sent.length = 0;

        sessions[0].print('a');
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);
        sessions[1].print('b');
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);
        sessions[0].print('c');
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        const seqs = sent.filter((frame) => frame.op === 'data')
            .map((frame) => [(frame.payload as { terminal_id: string }).terminal_id, frame.seq]);
        expect(seqs).toEqual([['t-1', 1], ['t-2', 1], ['t-1', 2]]);
    });

    // Sent into no socket, a bundle would be a seq the dashboard never sees and bytes nobody acks.
    test('a bundle cut while suspended is held, then sent first after resumeAll with the next seq', () => {
        const { handler, sent, sessions } = setUpSmallWindow();
        sessions[0].print('before');
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        sessions[0].print('in flight');
        handler.suspend();
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);
        expect(dataSent(sent)).toBe('before');

        handler.resumeAll();

        expect(dataSent(sent)).toBe('beforein flight');
        expect(sent.filter((frame) => frame.op === 'data').map((frame) => frame.seq)).toEqual([1, 2]);
        expect(sessions[0].resume).toHaveBeenCalledTimes(1);
    });

    test('a held bundle that fills the window on resume keeps the pty paused', () => {
        const { handler, sessions } = setUpSmallWindow();
        sessions[0].print('x'.repeat(SMALL_WINDOW_BYTES));
        handler.suspend();
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        handler.resumeAll();

        expect(sessions[0].resume).not.toHaveBeenCalled();
    });

    test('a close from the dashboard drops any bundle still being held', () => {
        const { handler, sent, sessions } = setUpSmallWindow();
        sessions[0].print('held');

        handler.handle(event('terminal', 'close', { terminal_id: 't-1', reason: 'user_closed' }));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);

        expect(dataSent(sent)).toBe('');
    });

    // Payloads on this channel are what a person types. Asserted over every level the agent logs at.
    test('no log line at any level carries a payload byte', () => {
        const marker = 'SECRET-MARKER-7f3a';
        const logged: unknown[] = [];
        for (const level of ['error', 'warn', 'info', 'debug', 'verbose', 'silly'] as const) {
            jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
                logged.push(args);
                return logger;
            }) as never);
        }
        const { handler, sessions } = setUpSmallWindow();

        sessions[0].print(marker.repeat(20));
        jest.advanceTimersByTime(BUNDLE_WAIT_MILLIS);
        handler.handle(ackFrame(40));
        sessions[0].exit(0);

        const everything = JSON.stringify(logged);
        expect(everything).not.toContain(marker);
        expect(everything).not.toContain(Buffer.from(marker).toString('base64'));
    });
});

describe('killing the agent process', () => {
    let childPid: number | undefined;

    afterEach(() => {
        if (childPid && isAlive(childPid)) process.kill(childPid, 'SIGKILL');
    });

    // Asserted by pid, not by a mock: the property is the kernel's, not this code's. When the process
    // holding the pty master dies, the master closes, and the shell gets SIGHUP.
    (ptyAvailable ? test : test.skip)('leaves no orphan shell', async () => {
        const { ensureSpawnHelperExecutable } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();

        const agentScript = `
            const pty = require('node-pty');
            const shell = pty.spawn('/bin/sh', [], { cols: 80, rows: 24, cwd: process.env.HOME, env: process.env });
            process.stdout.write(String(shell.pid) + '\\n');
            setInterval(() => {}, 1000);
        `;
        const agent = spawn(process.execPath, ['-e', agentScript], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
        childPid = agent.pid;

        const shellPid = await new Promise<number>((resolve, reject) => {
            agent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
            agent.once('exit', () => reject(new Error('agent exited before spawning')));
        });
        expect(isAlive(shellPid)).toBe(true);

        // On macOS the pid is node-pty's spawn-helper until it execs the shell. An agent killed inside
        // that window strands the helper, which never execs and never exits: a known gap, recorded
        // for T5. The property under test is the running shell's, so wait for the exec first.
        const commandOf = (pid: number) => {
            try {
                return execSync(`ps -o command= -p ${pid}`).toString().trim();
            } catch {
                return '';
            }
        };
        expect(await waitUntil(() => !commandOf(shellPid).includes('spawn-helper'), 5000)).toBe(true);

        process.kill(agent.pid as number, 'SIGKILL');

        expect(await waitUntil(() => !isAlive(shellPid), 5000)).toBe(true);
    }, 15000);
});