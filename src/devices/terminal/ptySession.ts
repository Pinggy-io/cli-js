import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import { logger } from "../../logger.js";
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
 * Slice T2: `onData` hands the shell's raw bytes to the handler, which frames them and runs the flow
 * window.
 *
 * `pause` stops reading the pty master. The kernel buffer then fills and the shell blocks on its next
 * `write()`, so nothing it prints is lost. 2 things pause a shell: the dashboard being unreachable
 * (slice T1b) and a full flow window (slice T2). `resize` follows the grid the watching tabs share.
 *
 * Slice T3: `write` takes keystrokes as raw bytes. Ctrl-C is 1 of them: the pty's line discipline
 * turns it into SIGINT for the foreground process group, as in any terminal. `signalForeground` is
 * for a signal with no keystroke. It targets the **foreground process group**, not the shell's pid:
 * while `sleep 100` runs, bash waits and ignores SIGINT, and only the group holding the terminal
 * gets to act on it. `node-pty`'s own `kill(signal)` signals the shell's pid only.
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
    /** Keystrokes, as raw bytes. */
    write(bytes: Buffer): void;
    /** 1 allowlisted signal to the terminal's foreground process group. Never throws. */
    signalForeground(signal: TerminalSignalName): void;
}

/** Without the SIG prefix, as the wire names them. The allowlist itself lives in terminal_schema.ts. */
export type TerminalSignalName = "INT" | "TERM" | "QUIT" | "HUP";

/**
 * The process group that holds the terminal: `tpgid` of the shell's controlling tty. `ps` reports it
 * on macOS and Linux alike. Null when it cannot be read, and the caller falls back to the shell's own
 * group, which is the foreground group whenever nothing else runs.
 */
export function foregroundProcessGroup(shellPid: number): Promise<number | null> {
    return new Promise((resolve) => {
        execFile("ps", ["-o", "tpgid=", "-p", String(shellPid)], (err, stdout) => {
            const processGroupId = err ? NaN : Number.parseInt(String(stdout).trim(), 10);
            resolve(Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null);
        });
    });
}

/**
 * Signals the group, never the pid. A negative pid is a process group to `kill(2)`. The shell is a
 * session leader, so its own pid is also its group id, which is the fallback.
 */
async function signalForegroundGroup(shellPid: number, signal: TerminalSignalName): Promise<void> {
    if (process.platform === "win32") {
        // ConPTY has no signals to send. Ctrl-C as input is the only interrupt there.
        logger.debug("Terminal signal ignored on Windows", { pid: shellPid, signal });
        return;
    }
    const processGroupId = (await foregroundProcessGroup(shellPid)) ?? shellPid;
    try {
        process.kill(-processGroupId, `SIG${signal}`);
    } catch (err) {
        // The group ended between the lookup and the call.
        logger.debug("Terminal signal not delivered", {
            pid: shellPid, signal, error: err instanceof Error ? err.name : typeof err,
        });
    }
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
        write: (bytes) => process_.write(bytes),
        signalForeground: (signal) => {
            void signalForegroundGroup(process_.pid, signal);
        },
    };
}