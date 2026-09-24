import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'module';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { Envelope, event, request } from '../devices/envelope.js';

/**
 * Slice T2's open criterion: at `remaining == 0` the agent **stops calling read**, verified in the
 * loop rather than inferred from the shell's state.
 *
 * A real pty runs `yes`, nothing acks, and every read the handler takes from the pty is counted where
 * node-pty hands it over. Once the window is full the count must stop moving entirely: not slow down,
 * stop. Then 1 cumulative ack reopens the window and the count moves again.
 * See docs/pinggy-devices/slices/T2-output-and-flow-control.md in the pinggy_backend repo.
 */

const require = createRequire(import.meta.url);

const TEST_WINDOW_BYTES = 65536;
const TEST_MAX_FRAME_BYTES = 32768;
const FILL_WAIT_MILLIS = 1500;
const BRAKED_WAIT_MILLIS = 1000;
const RESUMED_WAIT_MILLIS = 500;

const ptyAvailable = (() => {
    try {
        require('node-pty');
        return process.platform !== 'win32';
    } catch {
        return false;
    }
})();

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

describe('the read loop on a real pty', () => {
    (ptyAvailable ? test : test.skip)('stops reading at a full window, and reads again after an ack', async () => {
        const { ensureSpawnHelperExecutable, spawnPty } = await import('../devices/terminal/ptySession.js');
        ensureSpawnHelperExecutable();

        const reads = { count: 0, bytes: 0 };
        const sent: Envelope[] = [];
        const handler = new TerminalHandler({
            send: (frame) => sent.push(frame),
            spawn: (spawnRequest) => {
                const session = spawnPty(spawnRequest);
                // Counted at the source: every chunk node-pty reads from the pty master passes here.
                const onData = session.onData.bind(session);
                session.onData = (listener) => onData((chunk) => {
                    reads.count += 1;
                    reads.bytes += chunk.length;
                    listener(chunk);
                });
                return session;
            },
            resolveShell: () => ({ shell: '/bin/sh' }),
            registry: new TerminalRegistry<PtySession>(),
        });
        handler.configure(undefined, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES);

        try {
            handler.handle(request('terminal', 'open', { terminal_id: 't-1', cols: 80, rows: 24 }));
            handler.handle(event('terminal', 'data', {
                terminal_id: 't-1', data: Buffer.from('yes\n').toString('base64'),
            }));

            await sleep(FILL_WAIT_MILLIS);
            const readsWhenBraked = { ...reads };
            const bytesSent = sent
                .filter((frame) => frame.op === 'data')
                .map((frame) => Buffer.from((frame.payload as { data: string }).data, 'base64').length)
                .reduce((total, length) => total + length, 0);
            expect(bytesSent).toBeGreaterThanOrEqual(TEST_WINDOW_BYTES);

            await sleep(BRAKED_WAIT_MILLIS);
            expect(reads.count).toBe(readsWhenBraked.count);
            expect(reads.bytes).toBe(readsWhenBraked.bytes);

            handler.handle(event('terminal', 'ack', { terminal_id: 't-1', ack_bytes: bytesSent }));
            await sleep(RESUMED_WAIT_MILLIS);
            expect(reads.bytes).toBeGreaterThan(readsWhenBraked.bytes);
        } finally {
            handler.closeAll();
        }
    }, 15000);
});