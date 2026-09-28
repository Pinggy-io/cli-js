import { describe, test, expect } from '@jest/globals';
import { TerminalRegistry } from '../devices/terminal/terminalRegistry.js';
import { TerminalHandler } from '../devices/terminal/terminalHandler.js';
import { PtySession } from '../devices/terminal/ptySession.js';
import { FakeSession, fakeSession } from './helpers/fakePty.js';
import { Envelope, event, request } from '../devices/envelope.js';

/**
 * Slice T4: shells expire on the agent's own timers, from the values in `welcome`.
 *
 * The idle clock moves on every frame in either direction. The failure the slice names is a clock
 * reset on output but not input, or the reverse, so a slow build closes underneath somebody watching
 * it. Both directions are asserted. There is no default: without the 2 values, no timer runs.
 * See docs/pinggy-devices/slices/T4-limits-and-lifecycle.md in the pinggy_backend repo.
 */

const TEST_WINDOW_BYTES = 262144;
const TEST_MAX_FRAME_BYTES = 32768;
const IDLE_TIMEOUT_SECONDS = 1800;
const MAX_SESSION_SECONDS = 28800;
const SECOND = 1000;

/** `welcomeCarriesTimeouts: false` is a dashboard that sent neither value. */
function setUpHandler(welcomeCarriesTimeouts = true) {
    const idleTimeoutSeconds = welcomeCarriesTimeouts ? IDLE_TIMEOUT_SECONDS : undefined;
    const maxSessionSeconds = welcomeCarriesTimeouts ? MAX_SESSION_SECONDS : undefined;
    const sent: Envelope[] = [];
    const sessions: FakeSession[] = [];
    const clock = { millis: 1_700_000_000_000 };
    const handler = new TerminalHandler({
        send: (frame) => sent.push(frame),
        spawn: (spawnRequest) => {
            const pid = 48210 + sessions.length;
            const session = fakeSession(pid, spawnRequest.shell, spawnRequest.cols, spawnRequest.rows);
            sessions.push(session);
            return session;
        },
        resolveShell: (requested) => ({ shell: requested ?? '/bin/bash' }),
        registry: new TerminalRegistry<PtySession>(),
        now: () => clock.millis,
    });
    handler.configure(undefined, undefined, TEST_WINDOW_BYTES, TEST_MAX_FRAME_BYTES, idleTimeoutSeconds,
        maxSessionSeconds);
    const open = (terminalId: string) =>
        handler.handle(request('terminal', 'open', { terminal_id: terminalId, cols: 80, rows: 24 }));
    const advance = (millis: number) => { clock.millis += millis; };
    const closes = () => sent.filter((frame) => frame.op === 'close').map((frame) => frame.payload);
    return { handler, sent, sessions, open, advance, closes };
}

function input(terminalId: string, text: string): Envelope {
    return event('terminal', 'data', { terminal_id: terminalId, data: Buffer.from(text).toString('base64') });
}

describe('terminal idle timeout', () => {
    test('a shell with no frame in either direction closes with idle_timeout and is killed', () => {
        const { handler, sessions, open, advance, closes } = setUpHandler();
        open('t-1');

        advance(IDLE_TIMEOUT_SECONDS * SECOND - 1);
        handler.expireShells();
        expect(closes()).toEqual([]);

        advance(1);
        handler.expireShells();

        expect(closes()).toEqual([{ terminal_id: 't-1', reason: 'idle_timeout' }]);
        expect(sessions[0].kill).toHaveBeenCalledTimes(1);
    });

    test('output moves the idle clock, so a slow build is not closed underneath its watcher', () => {
        const { handler, sessions, open, advance, closes } = setUpHandler();
        open('t-1');

        advance((IDLE_TIMEOUT_SECONDS - 10) * SECOND);
        sessions[0].print('compiling...\r\n');
        advance(20 * SECOND);
        handler.expireShells();

        expect(closes()).toEqual([]);
    });

    test('input, resize and signal each move the idle clock too', () => {
        const { handler, open, advance, closes } = setUpHandler();
        open('t-1');
        const almostIdle = (IDLE_TIMEOUT_SECONDS - 10) * SECOND;

        advance(almostIdle);
        handler.handle(input('t-1', 'l'));
        advance(almostIdle);
        handler.handle(event('terminal', 'resize', { terminal_id: 't-1', cols: 100, rows: 30 }));
        advance(almostIdle);
        handler.handle(event('terminal', 'signal', { terminal_id: 't-1', signal: 'INT' }));
        advance(almostIdle);
        handler.expireShells();

        expect(closes()).toEqual([]);
    });

    test('the exit that follows the kill sends no user_closed', () => {
        const { handler, sessions, open, advance, sent } = setUpHandler();
        open('t-1');
        advance(IDLE_TIMEOUT_SECONDS * SECOND);
        handler.expireShells();

        sessions[0].exit(0, 15);

        expect(sent.filter((frame) => frame.op === 'exit')).toEqual([]);
        expect(sent.filter((frame) => frame.op === 'close')).toHaveLength(1);
    });

    test('only the idle shell closes, the busy one on the same socket is untouched', () => {
        const { handler, sessions, open, advance, closes } = setUpHandler();
        open('t-idle');
        open('t-busy');

        advance((IDLE_TIMEOUT_SECONDS - 1) * SECOND);
        sessions[1].print('tick\r\n');
        advance(SECOND);
        handler.expireShells();

        expect(closes()).toEqual([{ terminal_id: 't-idle', reason: 'idle_timeout' }]);
        expect(sessions[1].kill).not.toHaveBeenCalled();
    });
});

describe('terminal max session', () => {
    test('a busy shell still closes at the cap, with max_session', () => {
        const { handler, sessions, open, advance, closes } = setUpHandler();
        open('t-1');

        for (let elapsed = 0; elapsed < MAX_SESSION_SECONDS; elapsed += 600) {
            advance(600 * SECOND);
            sessions[0].print('still busy\r\n');
            handler.expireShells();
        }

        expect(closes()).toEqual([{ terminal_id: 't-1', reason: 'max_session' }]);
    });

    test('idle and too old at once closes for max_session, the rule typing cannot reset', () => {
        const { handler, open, advance, closes } = setUpHandler();
        open('t-1');

        advance(MAX_SESSION_SECONDS * SECOND);
        handler.expireShells();

        expect(closes()).toEqual([{ terminal_id: 't-1', reason: 'max_session' }]);
    });
});

describe('terminal expiry configuration', () => {
    test('with no values in welcome, no timer runs and nothing expires', () => {
        const { handler, open, advance, closes } = setUpHandler(false);
        open('t-1');

        advance(MAX_SESSION_SECONDS * 2 * SECOND);
        handler.expireShells();

        expect(closes()).toEqual([]);
    });

    test('nothing expires while suspended, and the first check after welcome ends it', () => {
        const { handler, open, advance, closes } = setUpHandler();
        open('t-1');
        handler.suspend();

        advance(IDLE_TIMEOUT_SECONDS * 2 * SECOND);
        handler.expireShells();
        expect(closes()).toEqual([]);

        handler.resumeAll();
        handler.expireShells();
        expect(closes()).toEqual([{ terminal_id: 't-1', reason: 'idle_timeout' }]);
    });
});