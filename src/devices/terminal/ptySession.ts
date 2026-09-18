import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import type { IPty } from "node-pty";
import { TerminalHandle } from "./terminalRegistry.js";

/**
 * 1 real pseudo-terminal running 1 shell, through `node-pty`.
 *
 * `node-pty` is a native addon, so it is loaded lazily and a failure is an answer rather than a
 * crash: an agent that cannot load it does not advertise `terminal`, and the Terminal button stays
 * greyed. Advertising a capability the agent cannot serve is the one thing this must never do.
 *
 * Slice T1: nothing reads or writes shell bytes here. Whatever the shell prints is discarded by
 * `node-pty` because nobody listens for it. Flow control and the data path arrive in T2.
 */

const require = createRequire(import.meta.url);

type NodePty = typeof import("node-pty");

let loadedPty: NodePty | null | undefined;

const SPAWN_HELPER_FILE = "spawn-helper";
const EXECUTABLE_MODE = 0o755;
const TERM_NAME = "xterm-256color";

export interface PtySpawnRequest {
    shell: string;
    cwd: string | null | undefined;
    cols: number;
    rows: number;
}

export interface PtySession extends TerminalHandle {
    readonly shell: string;
    onExit(listener: (exitCode: number, signal: number | undefined) => void): void;
}

/** Null when the addon will not load on this machine. Tried once. */
export function loadNodePty(): NodePty | null {
    if (loadedPty !== undefined) return loadedPty;
    try {
        const pty = require("node-pty") as NodePty;
        ensureSpawnHelperExecutable();
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
 * release ships it correctly. Nothing to do on Linux (it builds from source) or Windows (no helper).
 */
export function ensureSpawnHelperExecutable(): void {
    if (process.platform !== "darwin") return;
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const candidates = [
        path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, SPAWN_HELPER_FILE),
        path.join(packageRoot, "build", "Release", SPAWN_HELPER_FILE),
    ];
    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(candidate);
            if ((stat.mode & 0o111) === 0) {
                fs.chmodSync(candidate, EXECUTABLE_MODE);
            }
        } catch {
            // Not this layout. Try the next one.
        }
    }
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
    });

    return {
        pid: process_.pid,
        shell: request.shell,
        kill: () => process_.kill(),
        onExit: (listener) => {
            process_.onExit(({ exitCode, signal }) => listener(exitCode, signal));
        },
    };
}