import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'module';
import type { Terminal } from '@xterm/headless';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { SkipTuning, TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { TerminalActivity, TerminalResyncPart } from '../devices/terminal/terminal_schema.js';
import { Envelope, event, request } from '../devices/envelope.js';
import { buildCapabilities } from '../devices/deviceAgent.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';

/**
 * Output never waits.
 *
 * With `terminal_resync` in `welcome`, a full window or a dropped socket skips output instead of pausing
 * the pty. Skipped bytes feed the screen mirror and take no seq. Once the tabs have drawn everything they
 * were sent, the latest screen goes to every tab as `resync`, then live `data` from the next seq.
 */

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const TEST_MAX_FRAME_BYTES = 32768;
const SMALL_WINDOW_BYTES = 4096;
/** The raw bundle size at a 32 KB frame. A print this large leaves as 1 bundle at once, not after 8 ms. */
const FULL_BUNDLE_BYTES = 24192;

/** Longer than the splitter's 8 ms bundle delay, so printed output has left the splitter. */
const OUTPUT_SETTLE_MILLIS = 40;
const WAIT_TIMEOUT_MILLIS = 3000;
const WAIT_POLL_MILLIS = 5;

const FAST_TUNING: SkipTuning = {
    resyncMinIntervalMillis: 50,
    mirrorHighWaterBytes: 64 * 1024 * 1024,
    mirrorLowWaterBytes: 16 * 1024 * 1024,
    activityReportMillis: 60_000,
};

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

async function waitFor(condition: () => boolean, timeoutMillis = WAIT_TIMEOUT_MILLIS): Promise<void> {
    const deadline = Date.now() + timeoutMillis;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting');
        await sleep(WAIT_POLL_MILLIS);
    }
}

function setUpHandler(windowBytes = SMALL_WINDOW_BYTES, tuning: Partial<SkipTuning> = {}, terminalResync = true) {
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
        skipTuning: { ...FAST_TUNING, ...tuning },
    });
    handler.configure(undefined, undefined, windowBytes, TEST_MAX_FRAME_BYTES, undefined, terminalResync);
    const open = (terminalId = 't-1', cols = 120, rows = 32) =>
        handler.handle(request('terminal', 'open', { terminal_id: terminalId, cols, rows }));
    const ack = (ackBytes: number, terminalId = 't-1') =>
        handler.handle(event('terminal', 'ack', { terminal_id: terminalId, ack_bytes: ackBytes }));
    const print = async (text: string, session = 0) => {
        sessions[session].print(text);
        await sleep(OUTPUT_SETTLE_MILLIS);
    };
    const dataFrames = () => sent.filter((frame) => frame.op === 'data');
    const resyncParts = () => sent.filter((frame) => frame.op === 'resync')
        .map((frame) => frame.payload as TerminalResyncPart);
    const resyncs = () => {
        const byId = new Map<string, TerminalResyncPart[]>();
        for (const part of resyncParts()) {
            byId.set(part.resync_id, [...(byId.get(part.resync_id) ?? []), part]);
        }
        return [...byId.values()].filter((parts) => parts.some((part) => part.last));
    };
    const activities = () => sent.filter((frame) => frame.op === 'activity')
        .map((frame) => frame.payload as TerminalActivity);
    return { handler, sent, sessions, open, ack, print, dataFrames, resyncParts, resyncs, activities };
}

function joinParts(parts: TerminalResyncPart[]): string {
    return Buffer.concat(parts.map((part) => Buffer.from(part.data, 'base64'))).toString('utf-8');
}

/** A fresh emulator fed the screen, the way a tab applies a resync. */
async function restore(text: string, cols: number, rows: number): Promise<Terminal> {
    const terminal = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    return terminal;
}

function allLines(terminal: Terminal): string {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
        lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
}

/** Sends 1 bundle that fills the small window, so the next one skips. */
async function fillWindow(print: (text: string) => Promise<void>): Promise<string> {
    const filler = 'a'.repeat(SMALL_WINDOW_BYTES + 100);
    await print(filler);
    return filler;
}

describe('a full window skips output instead of pausing the pty', () => {
    test('a skipped bundle sends no data, takes no seq, and the pty is never paused', async () => {
        const { sessions, open, print, dataFrames } = setUpHandler();
        open();
        await fillWindow(print);
        expect(dataFrames()).toHaveLength(1);
        expect(dataFrames()[0].seq).toBe(1);

        await print('skipped\r\n');
        await print('also skipped\r\n');

        expect(dataFrames()).toHaveLength(1);
        expect(sessions[0].pause).not.toHaveBeenCalled();
    });

    test('after the drain, 1 resync carries the skipped output, then live data from after_seq + 1', async () => {
        const { open, ack, print, dataFrames, resyncs } = setUpHandler();
        open();
        const filler = await fillWindow(print);
        const skipped = 'skipped line one\r\nskipped line two\r\n';
        await print(skipped);

        ack(filler.length);
        await waitFor(() => resyncs().length === 1);

        const [parts] = resyncs();
        expect(parts[parts.length - 1]).toMatchObject({
            terminal_id: 't-1', last: true, after_seq: 1, after_bytes: filler.length,
            skipped_bytes: Buffer.byteLength(skipped), cols: 120, rows: 32,
        });
        const restored = await restore(joinParts(parts), 120, 32);
        expect(allLines(restored)).toContain('skipped line two');

        await print('live again\r\n');
        expect(dataFrames()).toHaveLength(2);
        expect(dataFrames()[1].seq).toBe(2);
    });

    test('not drained, no resync: it waits for the ack that covers every sent byte', async () => {
        const { open, ack, print, resyncs } = setUpHandler();
        open();
        const filler = await fillWindow(print);
        await print('skipped\r\n');

        ack(filler.length - 1);
        await sleep(OUTPUT_SETTLE_MILLIS * 2);
        expect(resyncs()).toHaveLength(0);

        ack(filler.length);
        await waitFor(() => resyncs().length === 1);
    });

    test('no second resync inside the interval, and 1 once it has passed', async () => {
        const intervalMillis = 400;
        const { open, ack, print, resyncs, dataFrames } = setUpHandler(SMALL_WINDOW_BYTES,
            { resyncMinIntervalMillis: intervalMillis });
        open();
        const filler = await fillWindow(print);
        await print('first skip\r\n');
        ack(filler.length);
        await waitFor(() => resyncs().length === 1);

        // The window reopened with the resync: this bundle goes out live and fills it again.
        const refill = 'b'.repeat(SMALL_WINDOW_BYTES + 100);
        await print(refill);
        expect(dataFrames()).toHaveLength(2);
        await print('second skip\r\n');
        ack(filler.length + refill.length);
        await sleep(OUTPUT_SETTLE_MILLIS);
        expect(resyncs()).toHaveLength(1);

        await waitFor(() => resyncs().length === 2, intervalMillis * 3);
    });

    test('a screen over the window size is serialised again with fewer lines', async () => {
        const windowBytes = 16384;
        const { open, ack, print, resyncs } = setUpHandler(windowBytes);
        open();
        const filler = 'a'.repeat(windowBytes + 100);
        await print(filler);
        let colored = '';
        for (let line = 1; line <= 600; line++) {
            colored += `\x1b[32mINFO\x1b[0m \x1b[1;34mworker-${line % 8}\x1b[0m request ${line}\r\n`;
        }
        await print(colored);

        ack(filler.length);
        await waitFor(() => resyncs().length === 1);

        const text = joinParts(resyncs()[0]);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(windowBytes);
        const restored = await restore(text, 120, 32);
        expect(allLines(restored)).toContain('request 600');
    });
});

describe('the socket going down skips too', () => {
    test('while suspended the pty is not paused and output skips, and after welcome a resync goes at once',
        async () => {
            const { handler, sessions, open, print, dataFrames, resyncs } = setUpHandler(262144);
            open();
            await print('before\r\n');
            expect(dataFrames()).toHaveLength(1);

            handler.suspend();
            expect(sessions[0].pause).not.toHaveBeenCalled();
            await print('while the socket was down\r\n');
            expect(dataFrames()).toHaveLength(1);

            handler.resumeAll();
            await waitFor(() => resyncs().length === 1);
            const [parts] = resyncs();
            expect(parts[0]).toMatchObject({
                after_seq: 1, skipped_bytes: Buffer.byteLength('while the socket was down\r\n'),
            });
            const restored = await restore(joinParts(parts), 120, 32);
            expect(allLines(restored)).toContain('while the socket was down');
        });

    test('bytes in flight when the socket dropped resync at once, with nothing skipped', async () => {
        const { handler, open, print, resyncs } = setUpHandler(262144);
        open();
        await print('sent, never acked\r\n');

        handler.suspend();
        handler.resumeAll();

        await waitFor(() => resyncs().length === 1);
        expect(resyncs()[0][0]).toMatchObject({
            after_seq: 1, after_bytes: Buffer.byteLength('sent, never acked\r\n'), skipped_bytes: 0,
        });
    });

    test('a shell with nothing in flight and nothing skipped sends no resync after welcome', async () => {
        const { handler, open, ack, print, resyncs } = setUpHandler(262144);
        open();
        await print('drawn\r\n');
        ack(Buffer.byteLength('drawn\r\n'));

        handler.suspend();
        handler.resumeAll();
        await sleep(OUTPUT_SETTLE_MILLIS);

        expect(resyncs()).toHaveLength(0);
    });
});

describe('a resync being serialised', () => {
    test('holds output cut meanwhile, and sends it after the parts with the next seq', async () => {
        const windowBytes = 32768;
        const { sent, sessions, open, ack, print, resyncs } = setUpHandler(windowBytes);
        open();
        const filler = 'a'.repeat(windowBytes + 100);
        await print(filler);
        await print('skipped\r\n');
        const sentBefore = sent.length;

        ack(filler.length);
        // 1 full bundle leaves the splitter at once, inside the resync's wait for the screen.
        sessions[0].print('h'.repeat(FULL_BUNDLE_BYTES));
        await waitFor(() => resyncs().length === 1);
        await sleep(OUTPUT_SETTLE_MILLIS);

        const after = sent.slice(sentBefore);
        const lastPartIndex = after.findIndex((frame) => frame.op === 'resync'
            && (frame.payload as TerminalResyncPart).last);
        const heldIndex = after.findIndex((frame) => frame.op === 'data');
        expect(heldIndex).toBeGreaterThan(lastPartIndex);
        const afterSeq = (after[lastPartIndex].payload as TerminalResyncPart).after_seq;
        expect(after[heldIndex].seq).toBe(afterSeq + 1);
        expect(joinParts(resyncs()[0])).not.toContain('hhhh');
    });

    test('skips held output past the window size, and resyncs again after the interval', async () => {
        const windowBytes = 32768;
        const { sessions, open, ack, print, resyncs, dataFrames } = setUpHandler(windowBytes);
        open();
        const filler = 'a'.repeat(windowBytes + 100);
        await print(filler);
        await print('skipped\r\n');
        const dataBefore = dataFrames().length;

        ack(filler.length);
        sessions[0].print('h'.repeat(FULL_BUNDLE_BYTES * 2));
        await waitFor(() => resyncs().length === 2);

        expect(dataFrames()).toHaveLength(dataBefore);
        const restored = await restore(joinParts(resyncs()[1]), 120, 32);
        expect(allLines(restored)).toContain('hhhh');
    });
});

describe('the edges', () => {
    test('a shell that exits while skipping sends its last screen, then exit and close', async () => {
        const { sent, sessions, open, print, resyncs } = setUpHandler();
        open();
        await fillWindow(print);
        // A new line first: the filler has none, and a wrapped phrase would span 2 rows.
        await print('\r\nthe last words\r\n');

        sessions[0].exit(0);
        await waitFor(() => sent.some((frame) => frame.op === 'close'));

        const ops = sent.map((frame) => frame.op);
        expect(ops.lastIndexOf('resync')).toBeLessThan(ops.indexOf('exit'));
        expect(ops.indexOf('exit')).toBeLessThan(ops.indexOf('close'));
        const restored = await restore(joinParts(resyncs()[0]), 120, 32);
        expect(allLines(restored)).toContain('the last words');
    });

    test('a shell that exits with nothing skipped sends exit and close at once, and no resync', () => {
        const { sent, sessions, open } = setUpHandler();
        open();
        sessions[0].exit(0);
        expect(sent.map((frame) => frame.op)).toEqual(['opened', 'exit', 'close']);
    });

    test('the mirror falling behind pauses the pty, and catching up resumes it', async () => {
        const { sessions, open } = setUpHandler(SMALL_WINDOW_BYTES,
            { mirrorHighWaterBytes: 64 * 1024, mirrorLowWaterBytes: 16 * 1024 });
        open();

        sessions[0].print('y\r\n'.repeat(200_000));

        expect(sessions[0].pause).toHaveBeenCalledTimes(1);
        await waitFor(() => sessions[0].resume.mock.calls.length === 1);
    });

    test('a T6 snapshot does not end skip mode, and the drain still resyncs every tab', async () => {
        const { handler, sent, open, ack, print, dataFrames, resyncs } = setUpHandler();
        open();
        const filler = await fillWindow(print);
        await print('skipped\r\n');

        handler.handle(event('terminal', 'snapshot', { terminal_id: 't-1', snapshot_id: 's-1' }));
        await waitFor(() => sent.some((frame) => frame.op === 'snapshot'));
        await print('still skipped\r\n');
        expect(dataFrames()).toHaveLength(1);
        expect(resyncs()).toHaveLength(0);

        ack(filler.length);
        await waitFor(() => resyncs().length === 1);
    });

    test('a skipping shell tells the dashboard it is busy, at most once per interval', async () => {
        const { open, print, activities } = setUpHandler(SMALL_WINDOW_BYTES, { activityReportMillis: 150 });
        open();
        await fillWindow(print);

        await print('skipped\r\n');
        await print('skipped again\r\n');
        expect(activities()).toEqual([{ terminal_id: 't-1', skipped_bytes: Buffer.byteLength('skipped\r\n') }]);

        await sleep(200);
        await print('later\r\n');
        expect(activities()).toHaveLength(2);
    });

    test('without terminal_resync in welcome, a full window still pauses the pty', async () => {
        const { sessions, open, print, dataFrames } = setUpHandler(SMALL_WINDOW_BYTES, {}, false);
        open();
        await fillWindow(print);

        expect(sessions[0].pause).toHaveBeenCalledTimes(1);
        expect(dataFrames()).toHaveLength(1);
    });

    test('terminal_resync is advertised only beside terminal_snapshot', () => {
        expect(buildCapabilities(true, true)).toEqual(expect.arrayContaining(['terminal_snapshot', 'terminal_resync']));
        expect(buildCapabilities(true, false)).not.toContain('terminal_resync');
        expect(buildCapabilities(false, true)).not.toContain('terminal_resync');
    });
});
