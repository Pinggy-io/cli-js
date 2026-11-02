import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'module';
import type { Terminal } from '@xterm/headless';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { rawBundleBytes } from '../devices/terminal/frameSplitter.js';
import { MAX_SNAPSHOT_BYTES, ScreenMirror } from '../devices/terminal/screenMirror.js';
import { TerminalSnapshotPart } from '../devices/terminal/terminal_schema.js';
import { Envelope, event, request } from '../devices/envelope.js';
import { buildCapabilities } from '../devices/deviceAgent.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';

/**
 * Slice T6 on the agent: a tab that attaches is sent the screen it missed.
 *
 * The screen is a headless xterm fed every bundle as it is sent. The seam is what matters: the
 * snapshot holds exactly the bundles up to its `after_seq` and none after, so the tab draws no byte
 * twice and skips none. See docs/pinggy-devices/slices/T6-screen-restore.md in the pinggy_backend repo.
 */

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const TEST_WINDOW_BYTES = 262144;
const TEST_MAX_FRAME_BYTES = 32768;
const BUNDLE_BYTES = rawBundleBytes(TEST_MAX_FRAME_BYTES);

/** Longer than the splitter's 8 ms bundle delay, so printed output has left as `data`. */
const OUTPUT_SETTLE_MILLIS = 40;
const WAIT_TIMEOUT_MILLIS = 3000;
const WAIT_POLL_MILLIS = 10;

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

async function waitFor(condition: () => boolean, timeoutMillis = WAIT_TIMEOUT_MILLIS): Promise<void> {
    const deadline = Date.now() + timeoutMillis;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting');
        await sleep(WAIT_POLL_MILLIS);
    }
}

function setUpHandler(windowBytes = TEST_WINDOW_BYTES) {
    const sent: Envelope[] = [];
    const sessions: FakeSession[] = [];
    const handler = new TerminalHandler({
        send: (frame) => sent.push(frame),
        spawn: (spawnRequest) => {
            const session = fakeSession(48210 + sessions.length, spawnRequest.shell, spawnRequest.cols,
                spawnRequest.rows);
            sessions.push(session);
            return session;
        },
        resolveShell: (requested) => ({ shell: requested ?? '/bin/bash' }),
        registry: new TerminalRegistry<PtySession>(),
    });
    handler.configure(undefined, undefined, windowBytes, TEST_MAX_FRAME_BYTES);
    const open = (terminalId: string, cols = 120, rows = 32) =>
        handler.handle(request('terminal', 'open', { terminal_id: terminalId, cols, rows }));
    const askForScreen = (terminalId: string, snapshotId: string) =>
        handler.handle(event('terminal', 'snapshot', { terminal_id: terminalId, snapshot_id: snapshotId }));
    const parts = (snapshotId: string) => sent
        .filter((frame) => frame.op === 'snapshot')
        .filter((frame) => (frame.payload as TerminalSnapshotPart).snapshot_id === snapshotId);
    const lastPartArrived = (snapshotId: string) =>
        parts(snapshotId).some((frame) => (frame.payload as TerminalSnapshotPart).last);
    const dataFrames = () => sent.filter((frame) => frame.op === 'data');
    return { handler, sent, sessions, open, askForScreen, parts, lastPartArrived, dataFrames };
}

function joinParts(frames: Envelope[]): string {
    return Buffer.concat(frames.map((frame) =>
        Buffer.from((frame.payload as TerminalSnapshotPart).data, 'base64'))).toString('utf-8');
}

/** A fresh emulator fed the snapshot, the way a tab that attaches is. */
async function restore(text: string, cols: number, rows: number): Promise<Terminal> {
    const terminal = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    return terminal;
}

function visibleLines(terminal: Terminal): string[] {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < terminal.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    return lines;
}

describe('the screen a tab missed', () => {
    test('comes back with the text, the grid, and the seq and bytes it holds', async () => {
        const { sessions, open, askForScreen, parts, lastPartArrived } = setUpHandler();
        open('t-1', 120, 32);
        const printed = '\x1b[32mhello\x1b[0m\r\n$ ';
        sessions[0].print(printed);
        await sleep(OUTPUT_SETTLE_MILLIS);

        askForScreen('t-1', 's-1');
        await waitFor(() => lastPartArrived('s-1'));

        const [only] = parts('s-1');
        expect(only.payload).toMatchObject({
            terminal_id: 't-1', snapshot_id: 's-1', part: 0, last: true,
            after_seq: 1, after_bytes: Buffer.byteLength(printed), cols: 120, rows: 32,
        });
        const restored = await restore(joinParts(parts('s-1')), 120, 32);
        // A written space is a cell, so the prompt keeps it.
        expect(visibleLines(restored).slice(0, 2)).toEqual(['hello', '$ ']);
        expect(restored.buffer.active.cursorX).toBe(2);
    });

    test('holds every bundle up to after_seq and none sent after the request', async () => {
        const { sessions, open, askForScreen, parts, lastPartArrived, dataFrames } = setUpHandler();
        open('t-1');
        sessions[0].print('before\r\n');
        await sleep(OUTPUT_SETTLE_MILLIS);

        askForScreen('t-1', 's-1');
        // A full bundle leaves at once, in this tick, after the request and before the screen is read.
        sessions[0].print('after\r\n' + 'x'.repeat(BUNDLE_BYTES));
        expect(dataFrames()).toHaveLength(2);
        await waitFor(() => lastPartArrived('s-1'));

        const [first] = parts('s-1');
        const snapshot = first.payload as TerminalSnapshotPart;
        expect(snapshot.after_seq).toBe(1);
        expect(dataFrames()[1].seq).toBe(2);
        const text = joinParts(parts('s-1'));
        expect(text).toContain('before');
        expect(text).not.toContain('after');
    });

    test('is cut into parts that each fit a frame, take no seq, and leave the window alone', async () => {
        const windowBytes = 102400;
        const { sessions, open, askForScreen, parts, lastPartArrived, dataFrames } = setUpHandler(windowBytes);
        open('t-1', 80, 24);
        const lines = Array.from({ length: 1000 }, (_, index) => `line ${index} `.padEnd(79, '.')).join('\r\n');
        sessions[0].print(lines + '\r\n');
        await sleep(OUTPUT_SETTLE_MILLIS);
        // The screen is bigger than what is left of the window. Counted, it would close it.
        expect(windowBytes - Buffer.byteLength(lines)).toBeLessThan(BUNDLE_BYTES);

        askForScreen('t-1', 's-1');
        await waitFor(() => lastPartArrived('s-1'));

        const snapshotFrames = parts('s-1');
        expect(snapshotFrames.length).toBeGreaterThan(1);
        snapshotFrames.forEach((frame, index) => {
            const part = frame.payload as TerminalSnapshotPart;
            expect(part.part).toBe(index);
            expect(part.last).toBe(index === snapshotFrames.length - 1);
            expect(frame.seq).toBe(0);
            expect(JSON.stringify(frame).length).toBeLessThanOrEqual(TEST_MAX_FRAME_BYTES);
        });
        expect(sessions[0].pause).not.toHaveBeenCalled();

        const afterSeq = (snapshotFrames[0].payload as TerminalSnapshotPart).after_seq;
        sessions[0].print('next\r\n');
        await sleep(OUTPUT_SETTLE_MILLIS);
        expect(dataFrames().at(-1)?.seq).toBe(afterSeq + 1);

        const restored = await restore(joinParts(snapshotFrames), 80, 24);
        // 1000 printed lines and the line the cursor sits on. Nothing trimmed.
        expect(restored.buffer.normal.length).toBe(1001);
        expect(visibleLines(restored)[22]).toBe('line 999 '.padEnd(79, '.'));
    });

    test('follows a resize of the pty', async () => {
        const { handler, open, askForScreen, parts, lastPartArrived } = setUpHandler();
        open('t-1', 80, 24);
        handler.handle(event('terminal', 'resize', { terminal_id: 't-1', cols: 100, rows: 30 }));

        askForScreen('t-1', 's-1');
        await waitFor(() => lastPartArrived('s-1'));

        expect(parts('s-1')[0].payload).toMatchObject({ cols: 100, rows: 30 });
    });

    test('brings vim back on its alternate screen, with application cursor keys', async () => {
        const { sessions, open, askForScreen, parts, lastPartArrived } = setUpHandler();
        open('t-1', 80, 24);
        sessions[0].print('$ vim notes.txt\r\n');
        sessions[0].print('\x1b[?1049h\x1b[?1h\x1b[H\x1b[2Jfirst line of the file\x1b[1;6H');
        await sleep(OUTPUT_SETTLE_MILLIS);

        askForScreen('t-1', 's-1');
        await waitFor(() => lastPartArrived('s-1'));

        const restored = await restore(joinParts(parts('s-1')), 80, 24);
        expect(restored.buffer.active.type).toBe('alternate');
        expect(restored.modes.applicationCursorKeysMode).toBe(true);
        expect(visibleLines(restored)[0]).toBe('first line of the file');
        expect(restored.buffer.active.cursorX).toBe(5);
        expect(restored.buffer.normal.getLine(0)?.translateToString(true)).toBe('$ vim notes.txt');
    });

    test('of a shell that printed nothing still ends in a last part', async () => {
        const { open, askForScreen, parts, lastPartArrived } = setUpHandler();
        open('t-1');

        askForScreen('t-1', 's-1');
        await waitFor(() => lastPartArrived('s-1'));

        expect(parts('s-1')).toHaveLength(1);
        expect(parts('s-1')[0].payload).toMatchObject({ after_seq: 0, after_bytes: 0 });
    });

    test('is not answered for a shell that is gone or never existed', async () => {
        const { handler, open, askForScreen, parts } = setUpHandler();
        open('t-1');
        handler.handle(event('terminal', 'close', { terminal_id: 't-1' }));

        askForScreen('t-1', 's-1');
        askForScreen('t-unknown', 's-2');
        await sleep(OUTPUT_SETTLE_MILLIS * 5);

        expect(parts('s-1')).toHaveLength(0);
        expect(parts('s-2')).toHaveLength(0);
    });

    test('is not answered after the agent stops', async () => {
        const { handler, open, askForScreen, parts } = setUpHandler();
        open('t-1');
        handler.closeAll();

        askForScreen('t-1', 's-1');
        await sleep(OUTPUT_SETTLE_MILLIS * 5);

        expect(parts('s-1')).toHaveLength(0);
    });
});

/** A real shell printing 20000 lines through a pty, bundled every 8 ms. */
const PTY_WAIT_TIMEOUT_MILLIS = 15000;

const ptyAvailable = (() => {
    try {
        require('node-pty');
        return process.platform !== 'win32';
    } catch {
        return false;
    }
})();

describe('the seam, on a real pty', () => {
    /**
     * What a tab does: the screen, then only the `data` after its `after_seq`. It must end on exactly
     * the screen of a terminal that drew every frame, with the request landing mid-stream.
     */
    (ptyAvailable ? test : test.skip)('a restored tab ends on the screen of a tab that saw every byte', async () => {
        const { ensureSpawnHelperExecutable, spawnPty } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();
        const sent: Envelope[] = [];
        const handler = new TerminalHandler({
            send: (frame) => sent.push(frame),
            spawn: spawnPty,
            resolveShell: () => ({ shell: '/bin/sh' }),
            registry: new TerminalRegistry<PtySession>(),
        });
        handler.configure(undefined, undefined, 64 * 1024 * 1024, TEST_MAX_FRAME_BYTES);
        const dataFrames = () => sent.filter((frame) => frame.op === 'data');
        const lastPartArrived = () => sent.some((frame) =>
            frame.op === 'snapshot' && (frame.payload as TerminalSnapshotPart).last);

        try {
            handler.handle(request('terminal', 'open', { terminal_id: 't-1', cols: 80, rows: 24 }));
            // The end marker is assembled by printf, so the echoed command line never contains it.
            const script = 'i=0; while [ $i -lt 20000 ]; do printf "\\033[3%dmline %d\\033[0m\\n" $((i % 8)) $i; '
                + "i=$((i+1)); done; printf 'FIN%s\\n' ISHED\n";
            const printedSoFar = () => Buffer.concat(dataFrames().map((frame) =>
                Buffer.from((frame.payload as { data: string }).data, 'base64'))).toString('utf-8');
            handler.handle(event('terminal', 'data', { terminal_id: 't-1', data: Buffer.from(script).toString('base64') }));
            await waitFor(() => dataFrames().length >= 3, PTY_WAIT_TIMEOUT_MILLIS);

            handler.handle(event('terminal', 'snapshot', { terminal_id: 't-1', snapshot_id: 's-1' }));
            await waitFor(lastPartArrived, PTY_WAIT_TIMEOUT_MILLIS);
            await waitFor(() => printedSoFar().includes('FINISHED'), PTY_WAIT_TIMEOUT_MILLIS);
            await sleep(OUTPUT_SETTLE_MILLIS);

            const parts = sent.filter((frame) => frame.op === 'snapshot');
            const afterSeq = (parts[0].payload as TerminalSnapshotPart).after_seq;
            expect(afterSeq).toBeGreaterThan(0);
            expect(dataFrames().at(-1)!.seq).toBeGreaterThan(afterSeq);

            const everyByte = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
            const restored = await restore(joinParts(parts), 80, 24);
            for (const frame of dataFrames()) {
                const bytes = Buffer.from((frame.payload as { data: string }).data, 'base64');
                everyByte.write(bytes);
                if (frame.seq > afterSeq) restored.write(bytes);
            }
            await new Promise<void>((resolve) => everyByte.write('', resolve));
            await new Promise<void>((resolve) => restored.write('', resolve));

            expect(visibleLines(restored)).toEqual(visibleLines(everyByte));
            expect(restored.buffer.active.cursorX).toBe(everyByte.buffer.active.cursorX);
            expect(restored.buffer.active.cursorY).toBe(everyByte.buffer.active.cursorY);
        } finally {
            handler.closeAll();
        }
    }, 30000);
});

describe('the screen mirror', () => {
    test('serialises again with fewer lines when the screen is over the cap', async () => {
        const cols = 400;
        const rows = 40;
        const mirror = ScreenMirror.create(cols, rows);
        expect(mirror).not.toBeNull();
        // 1 colour change per cell, so every cell costs its own escape sequence.
        const line = '\x1b[31ma\x1b[32mb'.repeat(cols / 2) + '\x1b[0m\r\n';
        for (let index = 0; index < 1100; index++) {
            mirror!.feed(Buffer.from(line));
        }
        mirror!.feed(Buffer.from('last line'));

        const screen = await mirror!.snapshot();

        expect(screen).not.toBeNull();
        expect(Buffer.byteLength(screen!.text)).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
        const restored = await restore(screen!.text, cols, rows);
        expect(restored.buffer.normal.length).toBeLessThan(1000 + rows);
        expect(visibleLines(restored)[rows - 1]).toBe('last line');
        mirror!.dispose();
    });

    test('answers null once disposed', async () => {
        const mirror = ScreenMirror.create(80, 24);
        mirror!.feed(Buffer.from('gone\r\n'));
        mirror!.dispose();

        expect(await mirror!.snapshot()).toBeNull();
    });
});

describe('capabilities', () => {
    test('advertise terminal_snapshot only beside terminal, and only when the mirror loads', () => {
        expect(buildCapabilities(true, true)).toEqual(expect.arrayContaining(['terminal', 'terminal_snapshot']));
        expect(buildCapabilities(true, false)).not.toContain('terminal_snapshot');
        expect(buildCapabilities(false, true)).not.toContain('terminal_snapshot');
        expect(buildCapabilities(true)).not.toContain('terminal_snapshot');
    });
});
