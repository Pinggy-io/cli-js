/**
 * Reconnect scheduling for the device agent.
 *
 * Pure over an injected clock and random source, so the whole schedule is testable without a
 * socket. Holds no timer of its own: the caller sleeps, this decides for how long.
 *
 * See docs/pinggy-devices/cli.md, "Reconnect and backoff". The existing remote-management loop is
 * a fixed 5000 ms retry and stays that way; this is the device agent's own.
 */

/** First retry ceiling. Doubles from here. */
export const INITIAL_DELAY_MILLIS = 1000;

/** Ceiling on the ceiling. A machine that has been down for an hour still dials once a minute. */
export const MAX_DELAY_MILLIS = 60_000;

/**
 * How long a connection must hold before the schedule resets.
 *
 * Resetting on connect instead would let a flapping socket reset the backoff every few seconds,
 * which turns the cap into a no-op and is the whole failure this guards against.
 */
export const STABLE_CONNECTION_MILLIS = 60_000;

/** The attempt at which the ceiling first reaches MAX_DELAY_MILLIS. Counting past it changes nothing. */
const MAX_ATTEMPT = Math.ceil(Math.log2(MAX_DELAY_MILLIS / INITIAL_DELAY_MILLIS));

export interface ReconnectPolicyOptions {
    /** Epoch millis. Injected so tests need no fake timers. */
    now?: () => number;
    /** Returns [0, 1). Injected so jitter is assertable. */
    random?: () => number;
}

/**
 * The un-jittered ceiling for an attempt: 1 s, 2, 4, 8, 16, 32, then 60 forever.
 *
 * Attempt 0 is the first retry, so the sequence starts at INITIAL_DELAY_MILLIS rather than 0.
 */
export function backoffCeilingMillis(attempt: number): number {
    const uncapped = INITIAL_DELAY_MILLIS * 2 ** Math.max(0, attempt);
    return Math.min(uncapped, MAX_DELAY_MILLIS);
}

/**
 * Full jitter: a uniform pick from [0, ceiling), not a wobble around it.
 *
 * The fleet deploys as a single-slot cutover, so every agent drops in the same instant. Narrow
 * jitter would keep them in lockstep and hand the first node back up the entire fleet at once.
 */
export function fullJitterMillis(ceilingMillis: number, random: () => number): number {
    return Math.floor(random() * ceilingMillis);
}

/**
 * The reconnect schedule for 1 agent.
 *
 * Call markConnected when the socket opens, markDisconnected when it closes, and nextDelayMillis
 * before sleeping. A connection that never opened counts as unstable, so a refused dial still
 * advances the schedule.
 */
export class ReconnectPolicy {
    private readonly now: () => number;
    private readonly random: () => number;

    private attemptCount = 0;
    private connectedAtMillis: number | null = null;

    constructor(options: ReconnectPolicyOptions = {}) {
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    /** Attempts taken since the last reset. Exposed for logging and for tests. */
    get attempt(): number {
        return this.attemptCount;
    }

    /** The ceiling the next delay will be drawn from, before jitter. */
    get nextCeilingMillis(): number {
        return backoffCeilingMillis(this.attemptCount);
    }

    markConnected(): void {
        this.connectedAtMillis = this.now();
    }

    /**
     * Ends the current connection. Returns true when it had held long enough to reset the
     * schedule, which the caller logs.
     */
    markDisconnected(): boolean {
        const heldMillis = this.connectedAtMillis === null ? 0 : this.now() - this.connectedAtMillis;
        this.connectedAtMillis = null;

        const wasStable = heldMillis >= STABLE_CONNECTION_MILLIS;
        if (wasStable) {
            this.attemptCount = 0;
        }
        return wasStable;
    }

    /** The delay before the next dial, and advances the schedule. */
    nextDelayMillis(): number {
        const delay = fullJitterMillis(this.nextCeilingMillis, this.random);
        this.attemptCount = Math.min(this.attemptCount + 1, MAX_ATTEMPT);
        return delay;
    }
}
