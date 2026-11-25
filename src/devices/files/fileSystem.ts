import fs from "fs";
import os from "os";
import path from "path";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import { FileKnownType, FileTargetType, MAX_NAME_BYTES, MAX_PATH_BYTES } from "./file_schema.js";

/**
 * What the file ops share: the filesystem calls they make, the path and name rules, and the helpers
 * that turn Node's answers into the file channel's words. `list` and `stat` only read. Nothing here logs
 * a path.
 */

/** The filesystem calls `list` and `stat` make. A test swaps in a fake to slow, fail or shape 1 of them. */
export interface FileSystemReader {
    readdir(folder: string): Promise<fs.Dirent[]>;
    lstat(target: string): Promise<fs.Stats>;
    stat(target: string): Promise<fs.Stats>;
    readlink(target: string): Promise<string>;
    /** Resolves when the agent's user has `mode` (`fs.constants.R_OK` and so on) on `target`. Absent: exists. */
    access(target: string, mode?: number): Promise<void>;
    homedir(): string;
}

export interface FileSystemDependencies {
    fs: FileSystemReader;
    /** Picks the path rules: `win32` for drive letters and `\`, anything else for POSIX. */
    platform: NodeJS.Platform;
}

export const machineFileSystem: FileSystemReader = {
    readdir: (folder) => fs.promises.readdir(folder, { withFileTypes: true }),
    lstat: (target) => fs.promises.lstat(target),
    stat: (target) => fs.promises.stat(target),
    readlink: (target) => fs.promises.readlink(target),
    access: (target, mode) => fs.promises.access(target, mode),
    homedir: () => os.homedir(),
};

export const machineFileSystemDependencies: FileSystemDependencies = {
    fs: machineFileSystem,
    platform: process.platform,
};

/**
 * The filesystem calls `delete` makes. Stats come as bigints, so a device and inode compare exactly: a
 * Windows file id can pass 2^53. A test swaps in a fake to slow, fail or reshape 1 of them.
 */
export interface FileSystemRemover {
    lstat(target: string): Promise<fs.BigIntStats>;
    stat(target: string): Promise<fs.BigIntStats>;
    /** Names only. */
    readdir(folder: string): Promise<string[]>;
    unlink(target: string): Promise<void>;
    rmdir(target: string): Promise<void>;
    chmod(target: string, mode: number): Promise<void>;
    /** Every link resolved. For the protected folders: what Pinggy runs from is protected by its real path. */
    realpath(target: string): Promise<string>;
}

export const machineFileSystemRemover: FileSystemRemover = {
    lstat: (target) => fs.promises.lstat(target, { bigint: true }),
    stat: (target) => fs.promises.stat(target, { bigint: true }),
    readdir: (folder) => fs.promises.readdir(folder),
    unlink: (target) => fs.promises.unlink(target),
    rmdir: (target) => fs.promises.rmdir(target),
    chmod: (target, mode) => fs.promises.chmod(target, mode),
    realpath: (target) => fs.promises.realpath(target),
};

/** The filesystem call `mkdir` makes. A test swaps in a fake to slow or fail it. */
export interface FileSystemMaker {
    /** 1 folder, not recursive: a missing parent is `ENOENT`, a name already taken `EEXIST`. */
    mkdir(target: string): Promise<void>;
}

export const machineFileSystemMaker: FileSystemMaker = {
    mkdir: async (target) => {
        await fs.promises.mkdir(target);
    },
};

/** What `symlink` makes on Windows. Elsewhere the type is ignored. */
export type LinkType = "file" | "dir";

/**
 * The filesystem calls `copy` makes. Stats come as bigints, as for `delete`, so identities compare exactly.
 * Every call that makes an entry fails with `EEXIST` when the name is taken, so a copy never overwrites
 * anything. A test swaps in a fake to slow, fail or reshape 1 of them.
 */
export interface FileSystemCopier {
    lstat(target: string): Promise<fs.BigIntStats>;
    stat(target: string): Promise<fs.BigIntStats>;
    realpath(target: string): Promise<string>;
    /** Names only. */
    readdir(folder: string): Promise<string[]>;
    /** 1 folder, not recursive. */
    mkdir(target: string): Promise<void>;
    openToRead(target: string): Promise<fs.promises.FileHandle>;
    /** A new file, readable and writable by the agent's user only until `chmod`. `EEXIST` when the name is taken. */
    createFile(target: string): Promise<fs.promises.FileHandle>;
    /** Reads the next bytes into `buffer`. 0 at the end of the file. */
    read(handle: fs.promises.FileHandle, buffer: Buffer): Promise<number>;
    /** Writes the first `length` bytes of `buffer`, all of them. */
    write(handle: fs.promises.FileHandle, buffer: Buffer, length: number): Promise<void>;
    close(handle: fs.promises.FileHandle): Promise<void>;
    readlink(target: string): Promise<string>;
    symlink(linkText: string, target: string, type: LinkType): Promise<void>;
    chmod(target: string, mode: number): Promise<void>;
    utimes(target: string, accessed: Date, modified: Date): Promise<void>;
    /** Replaces `to` when both are files or links. */
    rename(from: string, to: string): Promise<void>;
    unlink(target: string): Promise<void>;
    /** Bytes the agent's user may still write on the disk holding `folder`. */
    freeBytes(folder: string): Promise<bigint>;
}

/** Only the agent's user, until the copy takes the source's bits. */
const NEW_FILE_MODE = 0o600;
const CREATE_ONLY_IF_FREE = "wx";

export const machineFileSystemCopier: FileSystemCopier = {
    lstat: (target) => fs.promises.lstat(target, { bigint: true }),
    stat: (target) => fs.promises.stat(target, { bigint: true }),
    realpath: (target) => fs.promises.realpath(target),
    readdir: (folder) => fs.promises.readdir(folder),
    mkdir: async (target) => {
        await fs.promises.mkdir(target);
    },
    openToRead: (target) => fs.promises.open(target, "r"),
    createFile: (target) => fs.promises.open(target, CREATE_ONLY_IF_FREE, NEW_FILE_MODE),
    read: async (handle, buffer) => (await handle.read(buffer, 0, buffer.length, null)).bytesRead,
    write: async (handle, buffer, length) => {
        let written = 0;
        while (written < length) {
            written += (await handle.write(buffer, written, length - written, null)).bytesWritten;
        }
    },
    close: (handle) => handle.close(),
    readlink: (target) => fs.promises.readlink(target),
    symlink: (linkText, target, type) => fs.promises.symlink(linkText, target, type),
    chmod: (target, mode) => fs.promises.chmod(target, mode),
    utimes: (target, accessed, modified) => fs.promises.utimes(target, accessed, modified),
    rename: (from, to) => fs.promises.rename(from, to),
    unlink: (target) => fs.promises.unlink(target),
    freeBytes: async (folder) => {
        const stats = await fs.promises.statfs(folder, { bigint: true });
        return stats.bavail * stats.bsize;
    },
};

export const HIDDEN_NAME_PREFIX = ".";
const MILLIS_PER_SECOND = 1000;

export function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
    return platform === "win32" ? path.win32 : path.posix;
}

/** Null when the path is usable. Checked before `resolve`, which turns `""` into the process's own folder. */
export function pathProblem(requested: string, paths: path.PlatformPath): string | null {
    if (requested.includes("\0")) {
        return "The path holds a NUL byte.";
    }
    if (Buffer.byteLength(requested, "utf8") > MAX_PATH_BYTES) {
        return `The path is longer than ${MAX_PATH_BYTES} bytes.`;
    }
    if (!paths.isAbsolute(requested)) {
        return "The path must be absolute.";
    }
    return null;
}

/**
 * Null when `name` is usable as 1 entry of a folder: the last part of the path a `mkdir` makes, or of the path a
 * `copy` or a `move` lands at. `\\` is a separator on Windows only; elsewhere a file may hold it.
 */
export function nameProblem(name: string, platform: NodeJS.Platform): string | null {
    if (name.length === 0) {
        return "A name is empty.";
    }
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
        return `A name is longer than ${MAX_NAME_BYTES} bytes.`;
    }
    if (name === "." || name === "..") {
        return "A name cannot be . or ..";
    }
    if (name.includes("\0")) {
        return "A name holds a NUL byte.";
    }
    if (name.includes("/") || (platform === "win32" && name.includes("\\"))) {
        return "A name holds a path separator.";
    }
    return null;
}

const WINDOWS_FORBIDDEN_CHARACTERS = /[:*?"<>|]/;
const WINDOWS_TRAILING_DOT_OR_SPACE = /[. ]$/;
const WINDOWS_NUMBERED_DEVICES = ["COM", "LPT"];
const WINDOWS_DEVICE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Reserved with any extension: `con.txt` and `NUL.tar.gz` are the device too. */
const WINDOWS_DEVICE_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    ...WINDOWS_NUMBERED_DEVICES.flatMap((device) => WINDOWS_DEVICE_NUMBERS.map((number) => `${device}${number}`)),
]);
const EXTENSION_SEPARATOR = ".";

/**
 * Null when `name` follows Windows' naming rules. Letter case does not matter to them, so `con` is `CON`.
 *
 * @param subject how the messages name it: "A folder name" for `mkdir`, "A name" for the last part of
 *   `destination_path`
 */
export function windowsNameProblem(name: string, subject = "A folder name"): string | null {
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(name)) {
        return `${subject} on Windows cannot hold : * ? " < > |`;
    }
    if (WINDOWS_TRAILING_DOT_OR_SPACE.test(name)) {
        return `${subject} on Windows cannot end with a dot or a space.`;
    }
    const stem = name.split(EXTENSION_SEPARATOR)[0].toUpperCase();
    if (WINDOWS_DEVICE_NAMES.has(stem)) {
        return `${stem} is a device name on Windows.`;
    }
    return null;
}

/** A filesystem root: `/`, `C:\`, `\\server\share\`. It has no parent folder and no name. */
export function isRoot(resolved: string, paths: path.PlatformPath): boolean {
    return paths.dirname(resolved) === resolved;
}

/** 1 path a request names, resolved, with the folder it is in and its own name. Both are internal to 1 request. */
export interface ResolvedItem {
    path: string;
    /** The folder `path` is in. At a root, the root itself. */
    parent: string;
    /** The last part of `path`. Empty at a root. */
    name: string;
}

/** `requested` resolved and split. Check it with {@link pathProblem} first. */
export function resolvedItem(requested: string, paths: path.PlatformPath): ResolvedItem {
    const resolved = paths.resolve(requested);
    return { path: resolved, parent: paths.dirname(resolved), name: paths.basename(resolved) };
}

/** `mkdir`, and `copy` when a name is taken after its check: nothing was overwritten. */
export const MESSAGE_NAME_TAKEN = "A file or folder with this name already exists.";

export function errorCodeOf(err: unknown): string | undefined {
    return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
        ? err.code : undefined;
}

/** Node's own message, which names the path, with control characters dropped and cut to 256. */
export function failureMessage(err: unknown, fallback: string): string {
    return sanitizeErrorMessage(err instanceof Error ? err.message : String(err)) ?? fallback;
}

export function entryTypeOf(stats: fs.Stats): FileKnownType {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

export function targetTypeOf(stats: fs.Stats): FileTargetType {
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

export function epochSeconds(millis: number): number {
    return Math.floor(millis / MILLIS_PER_SECOND);
}

export function utf8Bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** What a symlink holds and what it points at. Each part is left off when it cannot be read. */
export interface LinkTarget {
    linkTarget?: string;
    targetType?: FileTargetType;
    /** The target's own stats, when the target exists. */
    targetStats?: fs.Stats;
}

/**
 * `readlink` for what the link holds, as stored, and `stat` for what it points at. A target that is
 * gone, or sits under a file, is `missing`. Any other failure, a loop for example, leaves the type off.
 */
export async function readLinkTarget(linkPath: string, reader: FileSystemReader): Promise<LinkTarget> {
    const target: LinkTarget = {};
    try {
        target.linkTarget = await reader.readlink(linkPath);
    } catch {
        // A link that cannot be read is still described, without what it holds.
    }
    try {
        target.targetStats = await reader.stat(linkPath);
        target.targetType = targetTypeOf(target.targetStats);
    } catch (err) {
        const code = errorCodeOf(err);
        if (code === "ENOENT" || code === "ENOTDIR") {
            target.targetType = "missing";
        }
    }
    return target;
}

/** A filesystem call that took longer than its limit. The call is abandoned, not killed: Node cannot stop it. */
export class FileCallTimeoutError extends Error {}

/** "A filesystem call took longer than 20 s." */
export function callTimeoutError(millis: number): FileCallTimeoutError {
    const seconds = Math.round(millis / MILLIS_PER_SECOND);
    return new FileCallTimeoutError(`A filesystem call took longer than ${seconds} s.`);
}

/** `work`'s outcome, or a {@link FileCallTimeoutError} once `millis` pass first. A late outcome is dropped. */
export function callWithTimeout<T>(work: Promise<T>, millis: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(callTimeoutError(millis)), millis);
        work.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err: unknown) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/** `work`'s value, or `fallback` once `millis` pass first. A late value, or a rejection, is dropped for `fallback`. */
export function withTimeout<T>(work: Promise<T>, millis: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), millis);
        work.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, () => {
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}
