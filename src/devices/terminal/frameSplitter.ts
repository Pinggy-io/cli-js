/**
 * Bundles pty output into frames, for 1 terminal.
 *
 * A shell writes in whatever sizes the kernel hands over: 1 byte while a person types, megabytes
 * while a build runs. Without bundling the first produces 1 frame per keystroke and the second
 * produces thousands per second. Frames leave at the bundle cap **or** after the bundle delay,
 * whichever comes first, so neither case is pathological.
 *
 * The cap is in raw bytes and is derived from `max_frame_bytes` rather than written down, because
 * the bytes travel base64 encoded inside a JSON envelope and base64 costs 33%. See
 * docs/pinggy-devices/slices/T2-output-and-flow-control.md in the pinggy_backend repo.
 */

/** Room for the envelope around the payload: `v`, `ch`, `op`, `id`, `seq`, `ts`, `terminal_id`. */
const ENVELOPE_OVERHEAD_BYTES = 512;

const BASE64_NUMERATOR = 3;
const BASE64_DENOMINATOR = 4;

export const BUNDLE_MILLIS = 8;

/**
 * The most raw bytes whose base64 still fits a frame, with the envelope allowed for.
 *
 * `max_frame_bytes` is the socket's text limit on both halves. Sending a frame above it does not
 * truncate, it closes the socket, which would take every other terminal on it.
 */
export function rawBundleBytes(maxFrameBytes: number): number {
    const available = maxFrameBytes - ENVELOPE_OVERHEAD_BYTES;
    if (available <= 0) {
        throw new Error("max_frame_bytes leaves no room for a terminal payload");
    }
    return Math.floor((available * BASE64_NUMERATOR) / BASE64_DENOMINATOR);
}

export class FrameSplitter {
    private pending: Buffer[] = [];
    private pendingBytes = 0;
    private timer: NodeJS.Timeout | undefined;

    constructor(private readonly emit: (chunk: Buffer) => void,
                private readonly bundleBytes: number,
                private readonly bundleMillis: number = BUNDLE_MILLIS) {
        if (!Number.isFinite(bundleBytes) || bundleBytes <= 0) {
            throw new Error("A frame splitter needs a positive bundle size");
        }
    }

    /** A chunk over the cap is split across frames, never truncated. */
    push(chunk: Buffer): void {
        if (chunk.length === 0) return;
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;

        while (this.pendingBytes >= this.bundleBytes) {
            this.emitBytes(this.bundleBytes);
        }
        if (this.pendingBytes > 0) {
            this.arm();
        } else {
            this.disarm();
        }
    }

    /** Sends whatever is held, if anything. Used when the terminal closes and by the timer. */
    flush(): void {
        this.disarm();
        if (this.pendingBytes > 0) {
            this.emitBytes(this.pendingBytes);
        }
    }

    dispose(): void {
        this.disarm();
        this.pending = [];
        this.pendingBytes = 0;
    }

    get buffered(): number {
        return this.pendingBytes;
    }

    private emitBytes(byteCount: number): void {
        const joined = Buffer.concat(this.pending, this.pendingBytes);
        const frame = joined.subarray(0, byteCount);
        const rest = joined.subarray(byteCount);
        this.pending = rest.length > 0 ? [rest] : [];
        this.pendingBytes = rest.length;
        this.emit(frame);
    }

    private arm(): void {
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.bundleMillis);
        // A pending bundle must never hold the process open on its own.
        this.timer.unref?.();
    }

    private disarm(): void {
        if (this.timer === undefined) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
