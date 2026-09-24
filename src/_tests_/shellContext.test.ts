import { describe, test, expect, jest } from '@jest/globals';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import {
    MAX_COMMAND_CHARACTERS, MAX_CWD_CHARACTERS, RawShellContext, ShellContextReader, ShellContextTracker,
    displayCwd, processTableReader, programName,
} from '../devices/terminal/shellContext.js';
import { Envelope, request } from '../devices/envelope.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';

/**
 * Slice T4c on the agent: each shell's directory and foreground program, read from the process table
 * and sent as `context` when it changes. Program names are the first word, basename only, because a
 * process can write its arguments into its own name. See docs/pinggy-devices/slices/T4c-shell-context.md
 * in the pinggy_backend repo.
 */

const require = createRequire(import.meta.url);

const TEST_WINDOW_BYTES = 262144;
const TEST_MAX_FRAME_BYTES = 32768;
const HOME = '/Users/priya';

describe('programName', () => {
    // Measured 2026-09-24: npm writes its arguments into its own process name.
    test('keeps the first word, so npm arguments never survive', () => {
        expect(programName('npm run s --token=abc123')).toBe('npm');
        expect(programName('npm run s --tok')).toBe('npm');
        expect(programName('mysql -psecret')).toBe('mysql');
    });

    test('takes the basename and drops a trailing colon', () => {
        expect(programName('/bin/sleep')).toBe('sleep');
        expect(programName('postgres:')).toBe('postgres');
        expect(programName('sshd: priya@pts/0')).toBe('sshd');
    });

    test('takes the first word before the basename', () => {
        expect(programName('npm run deploy --token=abc/def')).toBe('npm');
    });

    test('is null for nothing, or nothing but a slash or colon', () => {
        expect(programName(null)).toBeNull();
        expect(programName('   ')).toBeNull();
        expect(programName('/')).toBeNull();
        expect(programName(':')).toBeNull();
    });

    test(`is cut to ${MAX_COMMAND_CHARACTERS} characters`, () => {
        expect(programName('x'.repeat(200))).toHaveLength(MAX_COMMAND_CHARACTERS);
    });
});

describe('displayCwd', () => {
    test('writes the home directory as ~, and only on a path boundary', () => {
        expect(displayCwd('/Users/priya', HOME)).toBe('~');
        expect(displayCwd('/Users/priya/src', HOME)).toBe('~/src');
        expect(displayCwd('/Users/priyanka/src', HOME)).toBe('/Users/priyanka/src');
        expect(displayCwd('/private/tmp', HOME)).toBe('/private/tmp');
    });

    test('leaves the path whole when the home directory is unknown', () => {
        expect(displayCwd('/Users/priya/src', null)).toBe('/Users/priya/src');
    });

    // A directory name can hold an escape sequence that sets the terminal title.
    test('drops control characters', () => {
        expect(displayCwd('/Users/priya/evil\u001b]0;pwned\u0007dir', HOME)).toBe('~/evil]0;pwneddir');
    });

    test(`is cut to ${MAX_CWD_CHARACTERS} characters, on a code point boundary`, () => {
        const shown = displayCwd('/Users/priya/' + '\u{1F600}'.repeat(2000), HOME) ?? '';
        expect(Array.from(shown)).toHaveLength(MAX_CWD_CHARACTERS);
    });
});

describe('ShellContextTracker', () => {
    const shellAlone: RawShellContext = { cwd: HOME, foregroundName: null };

    test('the shell alone in the foreground has no command', () => {
        const tracker = new ShellContextTracker();
        expect(tracker.observe('t-1', shellAlone, HOME))
            .toEqual({ terminal_id: 't-1', cwd: '~', command: null, last_command: null });
    });

    test('a program ending becomes last_command when the shell takes the foreground back', () => {
        const tracker = new ShellContextTracker();
        tracker.observe('t-1', shellAlone, HOME);
        expect(tracker.observe('t-1', { cwd: HOME, foregroundName: 'top' }, HOME)?.command).toBe('top');

        expect(tracker.observe('t-1', shellAlone, HOME))
            .toEqual({ terminal_id: 't-1', cwd: '~', command: null, last_command: 'top' });
    });

    test('1 program replacing another between polls makes the first last_command', () => {
        const tracker = new ShellContextTracker();
        tracker.observe('t-1', { cwd: HOME, foregroundName: 'git' }, HOME);

        expect(tracker.observe('t-1', { cwd: HOME, foregroundName: 'vim' }, HOME))
            .toEqual({ terminal_id: 't-1', cwd: '~', command: 'vim', last_command: 'git' });
    });

    test('nothing changed between 2 polls gives nothing to send', () => {
        const tracker = new ShellContextTracker();
        tracker.observe('t-1', { cwd: HOME, foregroundName: 'top' }, HOME);

        expect(tracker.observe('t-1', { cwd: HOME, foregroundName: 'top' }, HOME)).toBeNull();
    });

    test('a forgotten shell starts again from nothing', () => {
        const tracker = new ShellContextTracker();
        tracker.observe('t-1', shellAlone, HOME);
        tracker.forget('t-1');

        expect(tracker.current()).toEqual([]);
        expect(tracker.observe('t-1', shellAlone, HOME)).not.toBeNull();
    });
});

describe('processTableReader', () => {
    test('there is nothing to read on Windows', () => {
        expect(processTableReader('win32')).toBeNull();
    });
});

function setUpHandler(read: ShellContextReader) {
    const sent: Envelope[] = [];
    const sessions: FakeSession[] = [];
    let nextPid = 48210;
    let nowMillis = 1_700_000_000_000;
    const handler = new TerminalHandler({
        send: (frame) => sent.push(frame),
        spawn: (spawnRequest) => {
            const session = fakeSession(nextPid++, spawnRequest.shell, spawnRequest.cols, spawnRequest.rows);
            sessions.push(session);
            return session;
        },
        resolveShell: (requested) => ({ shell: requested ?? '/bin/bash' }),
        registry: new TerminalRegistry<PtySession>(),
        now: () => nowMillis,
        readShellContexts: read,
        resolvedHome: HOME,
    });
    handler.configure(undefined, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES, 60, undefined);
    const open = (terminalId: string) => handler.handle(request('terminal', 'open', { terminal_id: terminalId }));
    const contexts = () => sent.filter((frame) => frame.ch === 'terminal' && frame.op === 'context');
    const advance = (millis: number) => { nowMillis += millis; };
    return { handler, sent, sessions, open, contexts, advance };
}

/** A process table holding whatever `table` says for each pid. */
function tableReader(table: Map<number, RawShellContext>) {
    return jest.fn<ShellContextReader>(async (pids) => {
        const contexts = new Map<number, RawShellContext>();
        for (const pid of pids) {
            const raw = table.get(pid);
            if (raw) contexts.set(pid, raw);
        }
        return contexts;
    });
}

describe('terminal handler and shell context', () => {
    test('a poll sends context for a changed shell, and nothing when it has not changed', async () => {
        const table = new Map<number, RawShellContext>([[48210, { cwd: HOME + '/src/api', foregroundName: 'npm run build' }]]);
        const { handler, open, contexts } = setUpHandler(tableReader(table));
        open('t-1');

        await handler.pollShellContexts();
        await handler.pollShellContexts();

        expect(contexts()).toHaveLength(1);
        expect(contexts()[0].payload).toEqual({ terminal_id: 't-1', cwd: '~/src/api', command: 'npm', last_command: null });
    });

    test('with no shell open, the process table is not read', async () => {
        const read = tableReader(new Map());
        const { handler } = setUpHandler(read);

        await handler.pollShellContexts();

        expect(read).not.toHaveBeenCalled();
    });

    // A program starting or ending is not a person using the shell.
    test('a poll does not count as activity, so the idle timeout still ends the shell', async () => {
        const table = new Map<number, RawShellContext>([[48210, { cwd: HOME, foregroundName: 'watch' }]]);
        const { handler, sessions, open, sent, advance } = setUpHandler(tableReader(table));
        open('t-1');

        advance(59_000);
        await handler.pollShellContexts();
        advance(2_000);
        handler.expireShells();

        expect(sessions[0].kill).toHaveBeenCalled();
        expect(sent.some((frame) => frame.op === 'close'
            && (frame.payload as { reason: string }).reason === 'idle_timeout')).toBe(true);
    });

    test('no poll runs while suspended, and welcome sends every held shell again', async () => {
        const table = new Map<number, RawShellContext>([
            [48210, { cwd: HOME, foregroundName: null }],
            [48211, { cwd: HOME + '/src', foregroundName: 'top' }],
        ]);
        const read = tableReader(table);
        const { handler, open, contexts } = setUpHandler(read);
        open('t-1');
        open('t-2');
        await handler.pollShellContexts();
        expect(contexts()).toHaveLength(2);

        handler.suspend();
        await handler.pollShellContexts();
        expect(read).toHaveBeenCalledTimes(1);

        handler.resumeAll();
        expect(contexts()).toHaveLength(4);
        expect(contexts().slice(2).map((frame) => frame.payload)).toEqual(contexts().slice(0, 2).map((frame) => frame.payload));
    });

    test('a closed shell is not sent again after welcome', async () => {
        const table = new Map<number, RawShellContext>([[48210, { cwd: HOME, foregroundName: null }]]);
        const { handler, open, contexts } = setUpHandler(tableReader(table));
        open('t-1');
        await handler.pollShellContexts();

        handler.suspend();
        handler.handle(request('terminal', 'close', { terminal_id: 't-1' }));
        handler.resumeAll();

        expect(contexts()).toHaveLength(1);
    });

    test('a reader that throws is not fatal', async () => {
        const read = jest.fn<ShellContextReader>(async () => { throw new Error('ps went away'); });
        const { handler, open, contexts } = setUpHandler(read);
        open('t-1');

        await expect(handler.pollShellContexts()).resolves.toBeUndefined();
        expect(contexts()).toHaveLength(0);
    });
});

const ptyAvailable = (() => {
    try {
        require('node-pty');
        return process.platform === 'darwin' || process.platform === 'linux';
    } catch {
        return false;
    }
})();

describe('on a real pty', () => {
    // The leak this slice is built around: a program that writes its arguments into its own name.
    (ptyAvailable ? test : test.skip)('a renamed process shows as its first word, with no argument, and cwd follows cd',
        async () => {
            const { ensureSpawnHelperExecutable, spawnPty } = await import('../devices/terminal/ptySession.js');
            ensureSpawnHelperExecutable();
            const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't4c-')));
            const session = spawnPty({ shell: '/bin/sh', cwd: null, cols: 80, rows: 24 });
            try {
                const title = 'npm run s --token=abc123';
                session.write(Buffer.from(`cd '${directory}'; '${process.execPath}' -e `
                    + `"process.title='${title}'; setTimeout(() => {}, 5000)"\n`));
                await new Promise((resolve) => setTimeout(resolve, 1500));

                const read = processTableReader();
                const raw = (await read!([session.pid])).get(session.pid);
                const context = new ShellContextTracker().observe('t-1', raw!, null);

                expect(context?.command).toBe('npm');
                expect(context?.cwd).toBe(directory);
                expect(JSON.stringify(context)).not.toContain('abc123');
            } finally {
                session.kill();
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }, 10000);
});
