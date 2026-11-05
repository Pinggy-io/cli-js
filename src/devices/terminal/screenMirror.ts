import { createRequire } from "module";
import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { logger } from "../../logger.js";

/**
 * 1 shell's screen, kept on the agent so that a tab that attaches is shown what it missed (slice T6).
 *
 * A headless copy of the emulator the browser runs, fed every output bundle as it is sent. It holds
 * cells, not bytes: what reached the screen, after every escape sequence was applied. Memory only, 1
 * per open shell, disposed with the shell. Never logged, never written to disk. See
 * docs/pinggy-devices/slices/T6-screen-restore.md in the pinggy_backend repo.
 */

/** The browser xterm's default. The pane sets none, so this is what a tab held before a refresh. */
export const SCROLLBACK_LINES = 1000;

/** A snapshot over this is serialised again with fewer lines. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** Tried in order until the text fits. 0 is the screen alone. */
const SCROLLBACK_LINES_TO_TRY = [SCROLLBACK_LINES, 200, 0];

/** What a tab needs to redraw: the serialised text, and the grid it was serialised at. */
export interface ScreenSnapshot {
    text: string;
    cols: number;
    rows: number;
}

interface HeadlessModules {
    Terminal: typeof Terminal;
    SerializeAddon: typeof SerializeAddon;
}

const require = createRequire(import.meta.url);

let loadedModules: HeadlessModules | null | undefined;

/**
 * Both packages, or null when they cannot load. They are pure JavaScript, so this fails only on a
 * broken install, and the agent then leaves `terminal_snapshot` out of its capabilities.
 */
function loadModules(): HeadlessModules | null {
    if (loadedModules !== undefined) return loadedModules;
    try {
        const headless = require("@xterm/headless") as typeof import("@xterm/headless");
        const serialize = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
        loadedModules = { Terminal: headless.Terminal, SerializeAddon: serialize.SerializeAddon };
    } catch (err) {
        logger.warn("Screen restore unavailable: the headless terminal did not load", { error: errorName(err) });
        loadedModules = null;
    }
    return loadedModules;
}

export function isScreenMirrorSupported(): boolean {
    return loadModules() !== null;
}

export class ScreenMirror {
    private disposed = false;
    private unparsedBytes = 0;

    private constructor(private readonly terminal: Terminal, private readonly serializer: SerializeAddon) {
    }

    /** Null when the headless terminal cannot load. The shell then works as before, without restore. */
    static create(cols: number, rows: number): ScreenMirror | null {
        const modules = loadModules();
        if (!modules) return null;
        // The serialize addon reads the buffer through the proposed API, and refuses to load without it.
        const terminal = new modules.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
        const serializer = new modules.SerializeAddon();
        terminal.loadAddon(serializer);
        return new ScreenMirror(terminal, serializer);
    }

    /**
     * Bytes exactly as they were sent or skipped. xterm parses them later, in order, and joins split
     * characters. `onParsed` runs once they are parsed, when {@link backlogBytes} has already dropped by them.
     */
    feed(bytes: Uint8Array, onParsed?: () => void): void {
        if (this.disposed) return;
        const byteCount = bytes.length;
        this.unparsedBytes += byteCount;
        this.terminal.write(bytes, () => {
            this.unparsedBytes -= byteCount;
            onParsed?.();
        });
    }

    /**
     * Fed and not yet parsed. xterm queues writes without limit, so a shell that skips its output
     * (slice T8) pauses on this, and on nothing else.
     */
    get backlogBytes(): number {
        return this.unparsedBytes;
    }

    resize(cols: number, rows: number): void {
        if (!this.disposed) this.terminal.resize(cols, rows);
    }

    /**
     * The screen after everything fed before this call, and nothing fed after it, serialised under
     * `maxBytes`. Null when the mirror was disposed first, or when even the screen alone is over
     * {@link MAX_SNAPSHOT_BYTES}.
     *
     * xterm parses writes in batches, on a timer. An empty write queued now has its callback run
     * after every earlier chunk is parsed and before the next one is, so serialising inside it sees
     * exactly what was fed before this call.
     */
    snapshot(maxBytes: number = MAX_SNAPSHOT_BYTES): Promise<ScreenSnapshot | null> {
        return new Promise((resolve) => {
            if (this.disposed) {
                resolve(null);
                return;
            }
            this.terminal.write("", () => resolve(this.disposed ? null : this.serialise(maxBytes)));
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.terminal.dispose();
    }

    /**
     * Fewer lines of scrollback until the text fits `maxBytes`. A screen alone over a cap below
     * {@link MAX_SNAPSHOT_BYTES} is still sent under that: a resync over its cap beats a tab that never
     * catches up. Null when even the screen alone is over {@link MAX_SNAPSHOT_BYTES}.
     */
    private serialise(maxBytes: number): ScreenSnapshot | null {
        for (const scrollback of SCROLLBACK_LINES_TO_TRY) {
            const text = this.serializer.serialize({ scrollback });
            if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
                return { text, cols: this.terminal.cols, rows: this.terminal.rows };
            }
        }
        if (maxBytes < MAX_SNAPSHOT_BYTES) {
            const screenOnly = this.serializer.serialize({ scrollback: 0 });
            if (Buffer.byteLength(screenOnly, "utf-8") <= MAX_SNAPSHOT_BYTES) {
                return { text: screenOnly, cols: this.terminal.cols, rows: this.terminal.rows };
            }
        }
        return null;
    }
}

/** The error's class name only. A message can quote the path it failed on. */
function errorName(err: unknown): string {
    return err instanceof Error ? err.name : typeof err;
}
