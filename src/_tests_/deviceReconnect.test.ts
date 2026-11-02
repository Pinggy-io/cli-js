import { describe, test, expect, jest, afterEach } from '@jest/globals';

import {
    INITIAL_DELAY_MILLIS,
    MAX_DELAY_MILLIS,
    STABLE_CONNECTION_MILLIS,
    ReconnectPolicy,
    backoffCeilingMillis,
    fullJitterMillis,
} from '../devices/reconnect.js';

/** A clock the test drives by hand, so none of this depends on wall time. */
function fakeClock(startMillis = 1_000_000) {
    let current = startMillis;
    return {
        now: () => current,
        advance: (millis: number) => { current += millis; },
    };
}

describe('backoff ceiling', () => {
    // The schedule from docs/pinggy-devices/cli.md, attempt by attempt.
    test.each([
        [0, 1000],
        [1, 2000],
        [2, 4000],
        [3, 8000],
        [4, 16000],
        [5, 32000],
        [6, 60000],
        [7, 60000],
        [8, 60000],
    ])('attempt %i has a ceiling of %i ms', (attempt, expected) => {
        expect(backoffCeilingMillis(attempt)).toBe(expected);
    });

    test('starts at 1 s', () => {
        expect(backoffCeilingMillis(0)).toBe(INITIAL_DELAY_MILLIS);
    });

    // 2 ** 2000 is Infinity, and Math.min must still hand back the cap rather than NaN.
    test('an absurd attempt count still returns the cap, not Infinity', () => {
        expect(backoffCeilingMillis(2000)).toBe(MAX_DELAY_MILLIS);
    });

    test('a negative attempt is treated as the first one', () => {
        expect(backoffCeilingMillis(-5)).toBe(INITIAL_DELAY_MILLIS);
    });
});

describe('full jitter', () => {
    test('a random of 0 gives no delay at all', () => {
        expect(fullJitterMillis(8000, () => 0)).toBe(0);
    });

    test('the draw scales with the ceiling', () => {
        expect(fullJitterMillis(8000, () => 0.5)).toBe(4000);
    });

    // Full jitter, not a wobble around the ceiling: the whole range below it has to be reachable,
    // or a fleet dropped by 1 cutover reconnects in lockstep.
    test('100 draws all land inside the ceiling and are not all the same', () => {
        const ceiling = 16000;
        const draws = Array.from({ length: 100 }, () => fullJitterMillis(ceiling, Math.random));

        for (const draw of draws) {
            expect(draw).toBeGreaterThanOrEqual(0);
            expect(draw).toBeLessThan(ceiling);
        }
        expect(new Set(draws).size).toBeGreaterThan(1);
    });

    test('draws spread across the range rather than hugging the ceiling', () => {
        const ceiling = 16000;
        const draws = Array.from({ length: 200 }, () => fullJitterMillis(ceiling, Math.random));
        expect(draws.some((d) => d < ceiling / 2)).toBe(true);
        expect(draws.some((d) => d > ceiling / 2)).toBe(true);
    });
});

describe('reconnect policy schedule', () => {
    test('the ceiling doubles on every failed attempt and then holds at the cap', () => {
        const policy = new ReconnectPolicy({ now: fakeClock().now, random: () => 0.5 });
        const ceilings: number[] = [];

        for (let i = 0; i < 8; i += 1) {
            ceilings.push(policy.nextCeilingMillis);
            policy.nextDelayMillis();
        }

        expect(ceilings).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    });

    test('every delay stays inside its own ceiling', () => {
        const policy = new ReconnectPolicy({ now: fakeClock().now });

        for (let i = 0; i < 10; i += 1) {
            const ceiling = policy.nextCeilingMillis;
            const delay = policy.nextDelayMillis();
            expect(delay).toBeGreaterThanOrEqual(0);
            expect(delay).toBeLessThan(ceiling);
        }
    });

    test('the attempt counter stops growing once the ceiling is capped', () => {
        const policy = new ReconnectPolicy({ now: fakeClock().now });

        for (let i = 0; i < 50; i += 1) {
            policy.nextDelayMillis();
        }

        expect(policy.attempt).toBe(6);
        expect(policy.nextCeilingMillis).toBe(MAX_DELAY_MILLIS);
    });
});

describe('reconnect policy reset', () => {
    test('a connection that held long enough resets the schedule to 1 s', () => {
        const clock = fakeClock();
        const policy = new ReconnectPolicy({ now: clock.now });

        policy.nextDelayMillis();
        policy.nextDelayMillis();
        policy.nextDelayMillis();
        expect(policy.nextCeilingMillis).toBe(8000);

        policy.markConnected();
        clock.advance(STABLE_CONNECTION_MILLIS);

        expect(policy.markDisconnected()).toBe(true);
        expect(policy.attempt).toBe(0);
        expect(policy.nextCeilingMillis).toBe(INITIAL_DELAY_MILLIS);
    });

    test('a connection 1 ms short of stable does not reset', () => {
        const clock = fakeClock();
        const policy = new ReconnectPolicy({ now: clock.now });

        policy.nextDelayMillis();
        policy.nextDelayMillis();

        policy.markConnected();
        clock.advance(STABLE_CONNECTION_MILLIS - 1);

        expect(policy.markDisconnected()).toBe(false);
        expect(policy.attempt).toBe(2);
        expect(policy.nextCeilingMillis).toBe(4000);
    });

    /**
     * The headline regression. Resetting on connect rather than on a stable connection turns the
     * cap into a no-op, and a flapping agent then dials every second forever.
     */
    test('a flapping connection keeps climbing to the cap', () => {
        const clock = fakeClock();
        const policy = new ReconnectPolicy({ now: clock.now });

        for (let i = 0; i < 10; i += 1) {
            policy.markConnected();
            clock.advance(2000);
            expect(policy.markDisconnected()).toBe(false);
            policy.nextDelayMillis();
        }

        expect(policy.nextCeilingMillis).toBe(MAX_DELAY_MILLIS);
    });

    test('a dial that never opened counts as unstable', () => {
        const clock = fakeClock();
        const policy = new ReconnectPolicy({ now: clock.now });

        policy.nextDelayMillis();
        clock.advance(STABLE_CONNECTION_MILLIS * 10);

        expect(policy.markDisconnected()).toBe(false);
        expect(policy.attempt).toBe(1);
    });

    test('a stable connection does not credit the one after it', () => {
        const clock = fakeClock();
        const policy = new ReconnectPolicy({ now: clock.now });

        policy.markConnected();
        clock.advance(STABLE_CONNECTION_MILLIS);
        expect(policy.markDisconnected()).toBe(true);

        // No markConnected this time: the elapsed time must not be measured from the old open.
        clock.advance(STABLE_CONNECTION_MILLIS);
        expect(policy.markDisconnected()).toBe(false);
    });
});

describe('reconnect policy on the real clock', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('the default clock is Date.now, so fake timers drive it', () => {
        jest.useFakeTimers();
        const policy = new ReconnectPolicy();

        policy.nextDelayMillis();
        policy.markConnected();
        jest.advanceTimersByTime(STABLE_CONNECTION_MILLIS);

        expect(policy.markDisconnected()).toBe(true);
        expect(policy.attempt).toBe(0);
    });
});
