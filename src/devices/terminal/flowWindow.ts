/**
 * The brake, for 1 terminal.
 *
 * `remaining = window - (sent - acked)`. At 0 the agent stops reading its pty, so the pty buffer
 * fills, so the shell's next `write()` blocks inside the kernel, so the loud program pauses. The
 * brake reaches the source. Buffering here instead would only move the surplus to whichever hop has
 * the most memory, which is a dashboard node shared by every other user's devices.
 *
 * Counted in **raw shell bytes**, never base64. The frame cap is denominated in encoded bytes and
 * the window is not, and mixing them gives a window a third smaller than intended.
 *
 * The window size comes from `welcome`. There is no compiled-in default on purpose: a hardcoded one
 * keeps working after the dashboard stops sending the field, and nobody notices until a node falls
 * over. See docs/pinggy-devices/slices/T2-output-and-flow-control.md in the pinggy_backend repo.
 */
export class FlowWindow {
    private readonly windowBytes: number;
    private sentBytes = 0;
    private ackedBytes = 0;

    constructor(windowBytes: number) {
        if (!Number.isFinite(windowBytes) || windowBytes <= 0) {
            throw new Error("A terminal flow window needs a positive size from welcome");
        }
        this.windowBytes = Math.trunc(windowBytes);
    }

    /** How many more raw bytes may go out before the browser has to catch up. */
    remaining(): number {
        return Math.max(0, this.windowBytes - (this.sentBytes - this.ackedBytes));
    }

    /** False means stop reading the pty. Nothing else is an acceptable response. */
    isOpen(): boolean {
        return this.remaining() > 0;
    }

    recordSent(byteCount: number): void {
        if (!Number.isFinite(byteCount) || byteCount <= 0) return;
        this.sentBytes += Math.trunc(byteCount);
    }

    /**
     * Cumulative totals, never increments, so a dropped ack self-heals on the next one.
     *
     * A browser is not a trusted input. An ack beyond what was sent is clamped rather than believed,
     * and one that arrives out of order never moves the counter backwards.
     */
    recordAck(ackBytes: number): void {
        if (!Number.isFinite(ackBytes)) return;
        const clamped = Math.min(Math.max(Math.trunc(ackBytes), 0), this.sentBytes);
        if (clamped > this.ackedBytes) {
            this.ackedBytes = clamped;
        }
    }

    get sent(): number {
        return this.sentBytes;
    }

    get acked(): number {
        return this.ackedBytes;
    }

    get size(): number {
        return this.windowBytes;
    }
}
