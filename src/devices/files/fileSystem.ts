import fs from "fs";
import os from "os";
import path from "path";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import { FileKnownType, FileTargetType, MAX_PATH_BYTES } from "./file_schema.js";

/**
 * What `list` and `stat` share: the filesystem calls they make, the path rules, and the helpers that
 * turn Node's answers into the file channel's words. Both only read. Nothing here logs a path.
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
