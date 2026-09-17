import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { TerminalRegistry, TerminalHandle } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { Envelope, request } from '../devices/envelope.js';

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

interface FakeSession extends PtySession {
    kill: jest.Mock;
    exit: (exitCode: number) => void;
}

function fakeSession(pid: number, shell: string): FakeSession {
    let exitListener: ((exitCode: number, signal: number | undefined) => void) | null = null;
    return {
        pid,
        shell,
        kill: jest.fn(),
        onExit: (listener) => { exitListener = listener; },
        exit: (exitCode) => exitListener?.(exitCode, undefined),
    };
}

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
        handler.configure(false, undefined);

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

    test('a shell that exits on its own sends close up, once', () => {
        const { handler, sent, sessions } = setUpHandler();
        handler.handle(openFrame({ terminal_id: 't-1' }));
        sent.length = 0;

        sessions[0].exit(0);
        sessions[0].exit(0);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: 'event', op: 'close', payload: { terminal_id: 't-1', reason: 'user_closed' } });
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