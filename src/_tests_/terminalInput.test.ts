import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'module';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';
import { Envelope, event, request } from '../devices/envelope.js';

/**
 * Slice T3: keystrokes in, resize on an actual change, and signals to the foreground process group.
 *
 * Ctrl-C is a keystroke. Written to the pty, the line discipline turns it into SIGINT for the
 * foreground group. `signal` is for a signal with no keystroke, and it targets the same group, never
 * the shell's pid. The last 2 tests prove both on a real pty, because that is the whole claim.
 * See docs/pinggy-devices/slices/T3-input-resize-signal.md in the pinggy_backend repo.
 */

const require = createRequire(import.meta.url);

const TEST_WINDOW_BYTES = 262144;
const TEST_MAX_FRAME_BYTES = 32768;

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
    handler.configure(undefined, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES);
    const open = (terminalId: string, cols = 120, rows = 32) =>
        handler.handle(request('terminal', 'open', { terminal_id: terminalId, cols, rows }));
    return { handler, sent, sessions, open };
}

function input(terminalId: string, text: string): Envelope {
    return event('terminal', 'data', { terminal_id: terminalId, data: Buffer.from(text).toString('base64') });
}

function written(session: FakeSession): string {
    return session.write.mock.calls.map(([bytes]) => (bytes as Buffer).toString()).join('');
}

describe('terminal input', () => {
    test('keystrokes reach the pty as raw bytes, escape sequences and Ctrl-C included', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.handle(input('t-1', 'ls -la\r'));
        handler.handle(input('t-1', '\u001b[A\u0003'));

        expect(written(sessions[0])).toBe('ls -la\r\u001b[A\u0003');
    });

    test('3 terminals on 1 socket each receive only their own input', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');
        open('t-2');
        open('t-3');

        handler.handle(input('t-2', 'two'));
        handler.handle(input('t-1', 'one'));
        handler.handle(input('t-3', 'three'));

        expect(sessions.map(written)).toEqual(['one', 'two', 'three']);
    });

    test('input for a terminal this agent does not hold is ignored', () => {
        const { handler } = setUpHandler();

        expect(() => handler.handle(input('nope', 'x'))).not.toThrow();
    });
});

describe('terminal resize', () => {
    test('the pty is resized only when the grid actually changes', () => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1', 120, 32);

        handler.handle(event('terminal', 'resize', { terminal_id: 't-1', cols: 120, rows: 32 }));
        expect(sessions[0].resize).not.toHaveBeenCalled();

        handler.handle(event('terminal', 'resize', { terminal_id: 't-1', cols: 100, rows: 30 }));
        handler.handle(event('terminal', 'resize', { terminal_id: 't-1', cols: 100, rows: 30 }));
        expect(sessions[0].resize).toHaveBeenCalledTimes(1);
        expect(sessions[0].resize).toHaveBeenCalledWith(100, 30);
    });
});

describe('terminal signal', () => {
    test.each(['INT', 'TERM', 'QUIT', 'HUP'])('%s reaches the foreground process group', (signal) => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.handle(event('terminal', 'signal', { terminal_id: 't-1', signal }));

        expect(sessions[0].signalForeground).toHaveBeenCalledWith(signal);
    });

    // KILL by name: its absence is the design, and it must never reach the process.
    test.each(['KILL', 'SIGINT', 'int', 'STOP', ''])('%p never reaches the process', (signal) => {
        const { handler, sessions, open } = setUpHandler();
        open('t-1');

        handler.handle(event('terminal', 'signal', { terminal_id: 't-1', signal }));

        expect(sessions[0].signalForeground).not.toHaveBeenCalled();
    });
});

const ptyAvailable = (() => {
    try {
        require('node-pty');
        return process.platform !== 'win32';
    } catch {
        return false;
    }
})();

/** Resolves once the shell has printed `text`, or rejects after `deadlineMillis`. */
function waitForOutput(session: PtySession, output: { text: string }, text: string, deadlineMillis: number) {
    return new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (output.text.includes(text)) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > deadlineMillis) {
                clearInterval(timer);
                reject(new Error(`no "${text}" within ${deadlineMillis} ms; pid ${session.pid}`));
            }
        }, 20);
    });
}

describe('on a real pty', () => {
    // A prompt-free shell, so the only output is what the test asks for.
    async function spawnShell() {
        const { ensureSpawnHelperExecutable, spawnPty } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();
        const session = spawnPty({ shell: '/bin/sh', cwd: null, cols: 80, rows: 24 });
        const output = { text: '' };
        session.onData((chunk) => { output.text += chunk.toString(); });
        return { session, output };
    }

    (ptyAvailable ? test : test.skip)('Ctrl-C written as input interrupts sleep 100', async () => {
        const { session, output } = await spawnShell();
        try {
            session.write(Buffer.from('PS1=; sleep 100; echo "exit=$?"\n'));
            await new Promise((resolve) => setTimeout(resolve, 500));

            session.write(Buffer.from('\u0003'));

            await waitForOutput(session, output, 'exit=130', 3000);
        } finally {
            session.kill();
        }
    }, 10000);

    (ptyAvailable ? test : test.skip)('signal INT reaches sleep 100 in the foreground, not only the shell', async () => {
        const { session, output } = await spawnShell();
        try {
            session.write(Buffer.from('PS1=; sleep 100; echo "exit=$?"\n'));
            await new Promise((resolve) => setTimeout(resolve, 500));

            session.signalForeground('INT');

            await waitForOutput(session, output, 'exit=130', 3000);
        } finally {
            session.kill();
        }
    }, 10000);
});