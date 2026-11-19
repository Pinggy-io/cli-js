import fs from "fs";
import {
    ERROR_FILE_OPERATION_FAILED, ERROR_INVALID_PATH, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
    FileStatAnswer, FileStatRequest, FileStatResult, fileError,
} from "./file_schema.js";
import {
    FileSystemDependencies, HIDDEN_NAME_PREFIX, entryTypeOf, epochSeconds, errorCodeOf, failureMessage,
    machineFileSystemDependencies, pathProblem, pathsFor, readLinkTarget, utf8Bytes,
} from "./fileSystem.js";

/**
 * `file/stat`: the metadata of 1 path.
 *
 * `lstat`, so a symlink is described as itself: its own times, mode and owner. Only `target_type` and
 * `target_size_bytes` come from what it points at, read with the `stat` the type needs anyway. A
 * symlink earlier in the path is followed as usual. A symlink gets no access flags: `fs.access`
 * follows it, so they would describe the target without saying so.
 *
 * A folder whose names cannot be read still answers, without `entry_count`, since its own metadata
 * needs only its parent. Its `readable: false` says why.
 *
 * `mode`, `uid`, `gid` and the access flags are left off on Windows. It has no mode bits, Node reads
 * no ACLs there, `X_OK` checks nothing, and `W_OK` reads only the read-only attribute.
 *
 * Without `link_target`, the answer always fits a 32 KB frame: a 4096-byte path, even escaped 6 times
 * over, is 24 KB. Only a long link target on top of a long path can push it past, so `link_target` is
 * what gives way. Nothing here logs a path.
 */

/** Setuid, setgid and sticky, then the owner's, the group's and everyone else's read, write, execute. */
const PERMISSION_BITS_MASK = 0o7777;
const OCTAL_RADIX = 8;
const MODE_DIGITS = 4;

const MESSAGE_STAT_FAILED = "The path could not be read.";
/** Only a frame cap far under the dashboard's 32 KB gets here. The error itself always fits. */
const MESSAGE_TOO_LARGE = "The details are too large to send.";

/** A failed `lstat`. `ENOTDIR` means a part of the path before the last is a file, so the path does not exist. */
function lstatFailure(err: unknown): FileStatResult {
    const message = failureMessage(err, MESSAGE_STAT_FAILED);
    switch (errorCodeOf(err)) {
        case "ENOENT":
        case "ENOTDIR":
            return fileError(ERROR_PATH_NOT_FOUND, message);
        case "EACCES":
        case "EPERM":
            return fileError(ERROR_PERMISSION_DENIED, message);
        default:
            return fileError(ERROR_FILE_OPERATION_FAILED, message);
    }
}

/** `0644`, `4755`, `1777`. */
function modeDigits(mode: number): string {
    return (mode & PERMISSION_BITS_MASK).toString(OCTAL_RADIX).padStart(MODE_DIGITS, "0");
}

/** Whether the agent's user has `mode` on `target`. Any failure is false. */
async function hasAccess(target: string, mode: number, dependencies: FileSystemDependencies): Promise<boolean> {
    try {
        await dependencies.fs.access(target, mode);
        return true;
    } catch {
        return false;
    }
}

/** The names directly inside, by `list`'s hidden rule. Undefined when the folder cannot be read. */
async function countEntries(folder: string, includeHidden: boolean,
                            dependencies: FileSystemDependencies): Promise<number | undefined> {
    try {
        const dirents = await dependencies.fs.readdir(folder);
        return includeHidden
            ? dirents.length
            : dirents.filter((dirent) => !dirent.name.startsWith(HIDDEN_NAME_PREFIX)).length;
    } catch {
        return undefined;
    }
}

/**
 * Carries out 1 `file/stat`. Never throws: every failure is an error answer.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function statPath(request: FileStatRequest, maxPayloadBytes: number,
                               dependencies: FileSystemDependencies = machineFileSystemDependencies):
    Promise<FileStatResult> {
    try {
        return await statPathOrThrow(request, maxPayloadBytes, dependencies);
    } catch (err) {
        return fileError(ERROR_FILE_OPERATION_FAILED, failureMessage(err, MESSAGE_STAT_FAILED));
    }
}

async function statPathOrThrow(request: FileStatRequest, maxPayloadBytes: number,
                               dependencies: FileSystemDependencies): Promise<FileStatResult> {
    const paths = pathsFor(dependencies.platform);
    const problem = pathProblem(request.path, paths);
    if (problem) {
        return fileError(ERROR_INVALID_PATH, problem);
    }
    const target = paths.resolve(request.path);

    let stats: fs.Stats;
    try {
        stats = await dependencies.fs.lstat(target);
    } catch (err) {
        return lstatFailure(err);
    }

    const type = entryTypeOf(stats);
    // The last part of a root is empty, so a root is named by its own path.
    const name = paths.basename(target) || target;
    const onWindows = dependencies.platform === "win32";

    const answer: FileStatAnswer = {
        path: target,
        name,
        type,
        ...(type === "file" ? { size_bytes: stats.size } : {}),
        modified_at: epochSeconds(stats.mtimeMs),
        accessed_at: epochSeconds(stats.atimeMs),
        // 0 is a filesystem with no birth time. Some report the change time instead, which cannot be told apart.
        ...(stats.birthtimeMs > 0 ? { created_at: epochSeconds(stats.birthtimeMs) } : {}),
        ...(name.startsWith(HIDDEN_NAME_PREFIX) ? { hidden: true as const } : {}),
    };

    if (!onWindows) {
        answer.mode = modeDigits(stats.mode);
        answer.uid = stats.uid;
        answer.gid = stats.gid;
    }
    if (!onWindows && type !== "symlink") {
        const [readable, writable, executable] = await Promise.all([
            hasAccess(target, fs.constants.R_OK, dependencies),
            hasAccess(target, fs.constants.W_OK, dependencies),
            hasAccess(target, fs.constants.X_OK, dependencies),
        ]);
        Object.assign(answer, { readable, writable, executable });
    }
    if (type === "directory") {
        const entryCount = await countEntries(target, request.include_hidden === true, dependencies);
        if (entryCount !== undefined) {
            answer.entry_count = entryCount;
        }
    }
    if (type === "symlink") {
        const { linkTarget, targetType, targetStats } = await readLinkTarget(target, dependencies.fs);
        if (linkTarget !== undefined) {
            answer.link_target = linkTarget;
        }
        if (targetType !== undefined) {
            answer.target_type = targetType;
        }
        if (targetStats?.isFile()) {
            answer.target_size_bytes = targetStats.size;
        }
    }

    if (utf8Bytes(answer) > maxPayloadBytes) {
        delete answer.link_target;
    }
    if (utf8Bytes(answer) > maxPayloadBytes) {
        return fileError(ERROR_FILE_OPERATION_FAILED, MESSAGE_TOO_LARGE);
    }
    return answer;
}
