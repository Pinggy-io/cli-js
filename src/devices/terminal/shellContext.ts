import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import type { TerminalContext } from "./terminal_schema.js";

/**
 * What each shell is doing, read from the **process table**, never from the pty stream: its working
 * directory, and the program in the foreground. Slice T4c, so a person can tell 3 shells apart.
 *
 * Nothing here reads a byte of shell output, prompt, or history. `cwd` and the program name are facts
 * about processes, the same kind as the pid `opened` already carries.
 *
 * **Program names are the first word, basename only.** A process can rewrite its own name, and npm
 * writes its arguments into it. Measured 2026-09-24 with `npm run s -- --token=abc123`: macOS
 * `ps -o comm=` read the whole line, Linux `/proc/<pid>/comm` read `npm run s --tok`, and node-pty's
 * own `.process` on Linux reads `argv[0]`, which leaks the same way. Cut to the first word it is `npm`.
 * The dashboard applies the same cut again.
 *
 * Linux reads `/proc` only. Slim Linux images ship no `ps`, and `/proc` costs no process spawn. macOS
 * spawns 3 processes per poll, whatever the shell count: 1 `ps` for the foreground groups, 1 `ps` for
 * their names, 1 `lsof` for every shell's `cwd`. Windows reports nothing: ConPTY has no foreground
 * process group.
 *
 * See docs/pinggy-devices/slices/T4c-shell-context.md in the pinggy_backend repo.
 */

/** How often the process table is read while any shell is open. */
export const SHELL_CONTEXT_POLL_MILLIS = 5000;

export const MAX_CWD_CHARACTERS = 1024;
export const MAX_COMMAND_CHARACTERS = 64;

/** A slow `ps` or `lsof` must not stack up polls behind it. */
const PROCESS_READ_TIMEOUT_MILLIS = 2000;

const HOME_PREFIX = "~";

/** 1 shell as the process table shows it, before any cleaning. */
export interface RawShellContext {
    /** The shell's own working directory, as the kernel reports it: resolved, not `$PWD`. */
    cwd: string | null;
    /** The foreground program's name, or null when the shell itself holds the terminal. */
    foregroundName: string | null;
}

/** Reads every given shell in 1 pass. A shell that cannot be read is left out, never thrown for. */
export type ShellContextReader = (shellPids: number[]) => Promise<Map<number, RawShellContext>>;

/** The reader for this platform, or null where there is nothing to read. */
export function processTableReader(platform: NodeJS.Platform = process.platform): ShellContextReader | null {
    if (platform === "linux") return readFromProc;
    if (platform === "darwin") return readFromPsAndLsof;
    return null;
}

/**
 * The first word, then the part after its last slash, then without a trailing colon. `/bin/sleep`
 * is `sleep`, `postgres:` is `postgres`. The first word comes before the basename: a basename of the
 * whole name would keep whatever follows the last slash of an argument.
 */
export function programName(rawName: string | null | undefined): string | null {
    const text = cleanText(rawName, Number.MAX_SAFE_INTEGER);
    if (text === null) return null;
    const firstWord = text.split(/\s+/, 1)[0];
    const baseName = firstWord.slice(firstWord.lastIndexOf("/") + 1).replace(/:+$/, "");
    return baseName === "" ? null : truncate(baseName, MAX_COMMAND_CHARACTERS);
}

/**
 * The home directory as `~`, compared against the resolved home: the kernel reports resolved paths,
 * so a symlinked home would otherwise never shorten.
 */
export function displayCwd(rawCwd: string | null | undefined, resolvedHome: string | null): string | null {
    const cwd = cleanText(rawCwd, Number.MAX_SAFE_INTEGER);
    if (cwd === null) return null;
    let shown = cwd;
    if (resolvedHome && cwd === resolvedHome) {
        shown = HOME_PREFIX;
    } else if (resolvedHome && cwd.startsWith(resolvedHome + "/")) {
        shown = HOME_PREFIX + cwd.slice(resolvedHome.length);
    }
    return truncate(shown, MAX_CWD_CHARACTERS);
}

/** The home directory with symlinks resolved, or null when it cannot be read. */
export function resolvedHomeDirectory(): string | null {
    try {
        return fs.realpathSync(os.homedir());
    } catch {
        return null;
    }
}

/**
 * Without control characters, trimmed, and at most `maxCharacters` code points. A directory name can
 * hold an escape sequence, and a tab label renders whatever it is given.
 */
function cleanText(raw: string | null | undefined, maxCharacters: number): string | null {
    if (raw === null || raw === undefined) return null;
    const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    return text === "" ? null : truncate(text, maxCharacters);
}

/** Cut on a code point boundary, so a surrogate pair is never split. */
function truncate(text: string, maxCharacters: number): string {
    const codePoints = Array.from(text);
    return codePoints.length <= maxCharacters ? text : codePoints.slice(0, maxCharacters).join("");
}

/**
 * Turns polls into `context` events: 1 per shell, only when something changed. `last_command` is the
 * program that held the foreground before the one now there, or before the shell took it back. A
 * program that starts and ends between 2 polls is never seen, which is accepted.
 */
export class ShellContextTracker {
    private readonly known = new Map<string, TerminalContext>();

    /** The event to send, or null when nothing changed since the last one. */
    observe(terminalId: string, raw: RawShellContext, resolvedHome: string | null): TerminalContext | null {
        const previous = this.known.get(terminalId);
        const command = programName(raw.foregroundName);
        const previousCommand = previous?.command ?? null;
        const lastCommand = previousCommand !== null && previousCommand !== command
            ? previousCommand
            : previous?.last_command ?? null;
        const next: TerminalContext = {
            terminal_id: terminalId,
            cwd: displayCwd(raw.cwd, resolvedHome),
            command,
            last_command: lastCommand,
        };
        if (previous && previous.cwd === next.cwd && previous.command === next.command
            && previous.last_command === next.last_command) {
            return null;
        }
        this.known.set(terminalId, next);
        return next;
    }

    /** What was last sent for every shell, to send again after a reconnect. */
    current(): TerminalContext[] {
        return [...this.known.values()];
    }

    forget(terminalId: string): void {
        this.known.delete(terminalId);
    }

    clear(): void {
        this.known.clear();
    }
}

// ---- Linux ------------------------------------------------------------------------------------

async function readFromProc(shellPids: number[]): Promise<Map<number, RawShellContext>> {
    const contexts = new Map<number, RawShellContext>();
    await Promise.all(shellPids.map(async (shellPid) => {
        const groups = await readProcGroups(shellPid);
        if (!groups) return;
        const cwd = await readOrNull(() => fs.promises.readlink(`/proc/${shellPid}/cwd`));
        const foregroundName = groups.foregroundGroupId === groups.shellGroupId
            ? null
            : await readOrNull(() => fs.promises.readFile(`/proc/${groups.foregroundGroupId}/comm`, "utf8"));
        contexts.set(shellPid, { cwd, foregroundName });
    }));
    return contexts;
}

/**
 * Field 5 (`pgrp`) and field 8 (`tpgid`) of `/proc/<pid>/stat`. The name in field 2 is in parentheses
 * and may hold spaces or parentheses itself, so the fields are counted from the last `)`.
 */
async function readProcGroups(shellPid: number): Promise<{ shellGroupId: number; foregroundGroupId: number } | null> {
    const stat = await readOrNull(() => fs.promises.readFile(`/proc/${shellPid}/stat`, "utf8"));
    if (stat === null) return null;
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state, ppid, pgrp, session, tty_nr, tpgid.
    const shellGroupId = Number.parseInt(afterName[2], 10);
    const foregroundGroupId = Number.parseInt(afterName[5], 10);
    if (!(shellGroupId > 0) || !(foregroundGroupId > 0)) return null;
    return { shellGroupId, foregroundGroupId };
}

// ---- macOS ------------------------------------------------------------------------------------

async function readFromPsAndLsof(shellPids: number[]): Promise<Map<number, RawShellContext>> {
    const contexts = new Map<number, RawShellContext>();
    if (shellPids.length === 0) return contexts;

    const groups = parseColumns(await run("ps", ["-o", "pid=,pgid=,tpgid=", "-p", shellPids.join(",")]));
    const foregroundGroupIds = [...groups.values()]
        .filter(([shellGroupId, foregroundGroupId]) => foregroundGroupId > 0 && foregroundGroupId !== shellGroupId)
        .map(([, foregroundGroupId]) => foregroundGroupId);
    const [names, cwds] = await Promise.all([
        foregroundGroupIds.length === 0
            ? Promise.resolve(new Map<number, string>())
            : run("ps", ["-o", "pid=,comm=", "-p", foregroundGroupIds.join(",")]).then(parseNames),
        run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", shellPids.join(",")]).then(parseLsofCwds),
    ]);

    for (const shellPid of shellPids) {
        const group = groups.get(shellPid);
        if (!group) continue;
        const [shellGroupId, foregroundGroupId] = group;
        contexts.set(shellPid, {
            cwd: cwds.get(shellPid) ?? null,
            foregroundName: foregroundGroupId === shellGroupId ? null : names.get(foregroundGroupId) ?? null,
        });
    }
    return contexts;
}

/** `pid pgid tpgid` per line, as numbers. */
function parseColumns(stdout: string | null): Map<number, [number, number]> {
    const columns = new Map<number, [number, number]>();
    for (const line of (stdout ?? "").split("\n")) {
        const [pid, groupId, foregroundGroupId] = line.trim().split(/\s+/).map((field) => Number.parseInt(field, 10));
        if (pid > 0 && groupId > 0) columns.set(pid, [groupId, foregroundGroupId]);
    }
    return columns;
}

/** `pid name` per line. The name is the rest of the line, spaces and all; `programName` cuts it later. */
function parseNames(stdout: string | null): Map<number, string> {
    const names = new Map<number, string>();
    for (const line of (stdout ?? "").split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (match) names.set(Number.parseInt(match[1], 10), match[2]);
    }
    return names;
}

/** `lsof -F pn`: a `p<pid>` line, then an `n<path>` line for its cwd. */
function parseLsofCwds(stdout: string | null): Map<number, string> {
    const cwds = new Map<number, string>();
    let pid = 0;
    for (const line of (stdout ?? "").split("\n")) {
        if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
        else if (line.startsWith("n") && pid > 0) cwds.set(pid, line.slice(1));
    }
    return cwds;
}

/**
 * Stdout, or null when the program failed or is missing. `lsof` exits 1 when 1 of several pids has
 * gone, and still prints the rest, so its output is kept whatever the exit code.
 */
function run(program: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(program, args, { timeout: PROCESS_READ_TIMEOUT_MILLIS }, (err, stdout) => {
            const output = String(stdout ?? "");
            resolve(err && output === "" ? null : output);
        });
    });
}

async function readOrNull(read: () => Promise<string>): Promise<string | null> {
    try {
        return await read();
    } catch {
        return null;
    }
}
