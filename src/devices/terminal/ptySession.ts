import fs from "fs";
import os from "os";
import type { IPty } from "node-pty";
import { TerminalHandle } from "./terminalRegistry.js";
import { NodePty, makeSpawnHelperExecutable, requireNodePty, resolveNodePtyRoot } from "./nodePtyRuntime.js";

/**
 * 1 real pseudo-terminal running 1 shell, through `node-pty`.
 *
 * `node-pty` is a native addon, so it is loaded lazily and a failure is an answer rather than a
 * crash: an agent that cannot load it does not advertise `terminal`, and the Terminal button stays
 * greyed. Advertising a capability the agent cannot serve is the one thing this must never do.
 *
 * Slice T1: nothing reads or writes shell bytes here. Whatever the shell prints is discarded by
 * `node-pty` because nobody listens for it. Flow control and the data path arrive in T2.
 *
 * Slice T1b: `pause` stops reading the pty master while the dashboard is unreachable. The kernel
 * buffer then fills and the shell blocks on its next `write()`, so nothing it prints is lost to a
 * reader that is not there. `resize` follows the grid the watching tabs share.
 */

let loadedPty: NodePty | null | undefined;

const TERM_NAME = "xterm-256color";

export interface PtySpawnRequest {
    shell: string;
    cwd: string | null | undefined;
    cols: number;
    rows: number;
}

export interface PtySession extends TerminalHandle {
    readonly shell: string;
    /** The grid the pty has now: the spawn size, then whatever the last `resize` set. */
    readonly cols: number;
    readonly rows: number;
    onExit(listener: (exitCode: number, signal: number | undefined) => void): void;
    /** Raw bytes, never a decoded string. A frame boundary inside a UTF-8 character corrupts it. */
    onData(listener: (chunk: Buffer) => void): void;
    /** Stops reading the pty, so its buffer fills and the shell's next write blocks in the kernel. */
    pause(): void;
    resume(): void;
    resize(cols: number, rows: number): void;
}

/** Null when the addon will not load on this machine. Tried once. */
export function loadNodePty(): NodePty | null {
    if (loadedPty !== undefined) return loadedPty;
    try {
        const packageRoot = resolveNodePtyRoot();
        const pty = requireNodePty(packageRoot);
        ensureSpawnHelperExecutable(packageRoot);
        loadedPty = pty;
    } catch {
        loadedPty = null;
    }
    return loadedPty;
}

export function isTerminalSupported(): boolean {
    return loadNodePty() !== null;
}

/**
 * node-pty 1.1.0 publishes its macOS `spawn-helper` prebuild without the execute bit, and every
 * spawn then fails with "posix_spawnp failed". Restoring the bit once, at load, is the fix until a
 * release ships it correctly. A packaged binary needs it on every platform with a helper, because
 * the copy it unpacks loses the bit too. Windows has no helper.
 */
export function ensureSpawnHelperExecutable(packageRoot?: string): void {
    makeSpawnHelperExecutable(packageRoot ?? resolveNodePtyRoot());
}

/** The requested directory when it exists, otherwise home. A bad cwd is not worth refusing a shell over. */
export function resolveCwd(requested: string | null | undefined): string {
    if (requested) {
        try {
            if (fs.statSync(requested).isDirectory()) return requested;
        } catch {
            // Fall through to home.
        }
    }
    return os.homedir();
}

/** Throws when the addon is unavailable or the spawn fails. The caller answers `spawn_failed`. */
export function spawnPty(request: PtySpawnRequest): PtySession {
    const pty = loadNodePty();
    if (!pty) {
        throw new Error("node-pty is not available on this machine");
    }
    const process_: IPty = pty.spawn(request.shell, [], {
        name: TERM_NAME,
        cols: request.cols,
        rows: request.rows,
        cwd: resolveCwd(request.cwd),
        env: { ...process.env, TERM: TERM_NAME } as Record<string, string>,
        // Buffers rather than strings. node-pty decodes per read otherwise, and a read that ends
        // mid-character yields a replacement character the browser can never recover.
        encoding: null,
    });

    return {
        pid: process_.pid,
        shell: request.shell,
        get cols() {
            return process_.cols;
        },
        get rows() {
            return process_.rows;
        },
        kill: () => process_.kill(),
        onExit: (listener) => {
            process_.onExit(({ exitCode, signal }) => listener(exitCode, signal));
        },
        onData: (listener) => {
            // Typed as string because `encoding` is typed as string. With encoding null the runtime
            // hands over a Buffer, and a decoded string would have to be re-encoded to count bytes.
            process_.onData((chunk: string | Buffer) => {
                listener(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
            });
        },
        pause: () => process_.pause(),
        resume: () => process_.resume(),
        resize: (cols, rows) => process_.resize(cols, rows),
    };
}