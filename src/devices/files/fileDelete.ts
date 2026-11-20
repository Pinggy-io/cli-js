import fs from "fs";
import path from "path";
import {
    ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT,
    ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, FileDeleteRequest,
    FileError, FileOperationAnswer, FileOperationFailure, FileProgress, MAX_FAILURES_LISTED, MAX_NAME_BYTES,
    fileError,
} from "./file_schema.js";
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, ProtectedSet, ProtectedSources, identityOf, isInsideConfigFolder,
    readProtectedSet,
} from "./fileProtectedPaths.js";
import {
    FileCallTimeoutError, FileSystemRemover, callWithTimeout, errorCodeOf, failureMessage, pathProblem, pathsFor,
    utf8Bytes,
} from "./fileSystem.js";

/**
 * `file/delete`: 1 or more names from 1 folder, recursively and for good.
 *
 * 2 steps, so the handler sends the first `progress` only once the delete runs. `prepareDelete` checks
 * the request and reads the protected folders: a refusal there has deleted nothing. `runDelete` then
 * deletes each name in order. The first error ends that name, and what it already removed stays removed.
 * The next name goes on.
 *
 * Each name is removed by a walk, not `fs.rm`, for 4 things `fs.rm` cannot do:
 * - check every entry against the protected folders, not only the names asked for;
 * - give each filesystem call a time limit, so a hung network drive fails 1 name and frees the slot;
 * - stay on the disk the name is on: a folder on another device is skipped and left in place;
 * - count each removal for `progress`.
 *
 * The walk tries `rmdir` on a folder before it reads it, as `fs.rm` does. A folder whose parent cannot be
 * written then fails before anything inside it goes. It handles 1 entry at a time, so a delete holds at
 * most 1 of Node's worker threads. An entry that vanishes mid-walk is ignored: a build deleting its own
 * temp files must not fail the name.
 *
 * A bind mount of a folder on the same disk has the same device, so the walk goes through it unless it
 * is a protected folder. Nothing here logs a path.
 */

/** What Windows needs before it deletes an entry marked read-only. `fs.rm` uses the same. */
const WINDOWS_WRITABLE_MODE = 0o666;

const MESSAGE_DELETE_FAILED = "The item could not be deleted.";
const MESSAGE_FOLDER_UNREADABLE = "The folder could not be read.";
const MESSAGE_PROTECTED_UNREAD = "The protected folders could not be read in time.";
const MESSAGE_SELECTED_MOUNT = "This folder is a mounted disk. Open it to delete what is inside.";
const MESSAGE_MOUNT_INSIDE = "Another disk is mounted inside. Pinggy left it in place.";

export interface DeleteDependencies {
    remover: FileSystemRemover;
    /** Picks the path rules, and whether `\` is a separator in a name. */
    platform: NodeJS.Platform;
    protectedSources: ProtectedSources;
    /** The limit on each filesystem call. */
    callTimeoutMillis: number;
}

/** A request that passed every check, with what the walk matches against. */
export interface PreparedDelete {
    directory: string;
    names: string[];
    /** The device `directory` resolves to. A selected name on another device is a mounted disk. */
    directoryDevice: bigint;
    protectedSet: ProtectedSet;
    /** Every name is protected: `directory` is the config folder or inside it. */
    insideConfigFolder: boolean;
    /** Every name is protected: `directory` is the accounts folder, so each name is an account's home. */
    inAccountsFolder: boolean;
}

/** The walk's shared state for 1 name. */
interface WalkContext {
    /** The name's own device. A folder on another one is a mount, left in place. */
    device: bigint;
    prepared: PreparedDelete;
    progress: FileProgress;
    dependencies: DeleteDependencies;
    paths: path.PlatformPath;
}

/** A protected folder met inside a tree: a bind mount of home, for example. It ends that name. */
class ProtectedEntryError extends Error {}

/** Null when every name is usable. The count, 1 to 200, is the schema's. */
function namesProblem(names: string[], platform: NodeJS.Platform): string | null {
    if (new Set(names).size !== names.length) {
        return "A name is listed twice.";
    }
    for (const name of names) {
        const problem = nameProblem(name, platform);
        if (problem) {
            return problem;
        }
    }
    return null;
}

function nameProblem(name: string, platform: NodeJS.Platform): string | null {
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

/** A failed read of `directory` itself. Nothing was deleted. */
function directoryFailure(err: unknown): FileError {
    const code = errorCodeOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
        return fileError(ERROR_PATH_NOT_FOUND, failureMessage(err, MESSAGE_FOLDER_UNREADABLE));
    }
    return fileError(ERROR_FILE_OPERATION_FAILED, failureMessage(err, MESSAGE_FOLDER_UNREADABLE));
}

/**
 * Checks the request and reads what the walk matches against. Never throws: every refusal is an error
 * answer, and none has deleted anything.
 */
export async function prepareDelete(request: FileDeleteRequest, dependencies: DeleteDependencies):
    Promise<PreparedDelete | FileError> {
    const namesIssue = namesProblem(request.names, dependencies.platform);
    if (namesIssue) {
        return fileError(ERROR_INVALID_PAYLOAD, namesIssue);
    }
    const paths = pathsFor(dependencies.platform);
    const pathIssue = pathProblem(request.directory, paths);
    if (pathIssue) {
        return fileError(ERROR_INVALID_PATH, pathIssue);
    }
    const directory = paths.resolve(request.directory);
    const { remover, callTimeoutMillis } = dependencies;

    let stats: fs.BigIntStats;
    try {
        stats = await callWithTimeout(remover.stat(directory), callTimeoutMillis);
    } catch (err) {
        return directoryFailure(err);
    }
    if (!stats.isDirectory()) {
        return fileError(ERROR_NOT_A_DIRECTORY, "The path is not a folder.");
    }

    let protectedSet: ProtectedSet;
    let insideConfigFolder: boolean;
    try {
        protectedSet = await readProtectedSet(dependencies.protectedSources, paths, remover, callTimeoutMillis);
        insideConfigFolder = await isInsideConfigFolder(directory, protectedSet, paths, remover, callTimeoutMillis);
    } catch (err) {
        // A read that timed out. Without every protected folder read, nothing is safe to delete.
        const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
        return fileError(code, failureMessage(err, MESSAGE_PROTECTED_UNREAD));
    }
    const inAccountsFolder = protectedSet.accountsFolder !== null
        && identityOf(stats) === protectedSet.accountsFolder;
    return {
        directory, names: request.names, directoryDevice: stats.dev, protectedSet, insideConfigFolder, inAccountsFolder,
    };
}

/**
 * Deletes each name in order, and counts into `progress` as it goes. Never throws: a failure is 1 entry
 * of `failed`.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function runDelete(prepared: PreparedDelete, progress: FileProgress,
                                dependencies: DeleteDependencies, maxPayloadBytes: number):
    Promise<FileOperationAnswer> {
    const failures: FileOperationFailure[] = [];
    for (const name of prepared.names) {
        progress.current_name = name;
        const error = await deleteName(name, prepared, progress, dependencies);
        if (error) {
            failures.push({ name, error });
        }
        progress.items_done += 1;
    }
    return answerWithin(prepared.names.length - failures.length, failures, maxPayloadBytes);
}

/** Null when the name is gone. */
async function deleteName(name: string, prepared: PreparedDelete, progress: FileProgress,
                          dependencies: DeleteDependencies): Promise<FileOperationFailure["error"] | null> {
    if (prepared.insideConfigFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER };
    }
    if (prepared.inAccountsFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNT_FOLDER };
    }
    const paths = pathsFor(dependencies.platform);
    const target = paths.join(prepared.directory, name);
    try {
        const stats = await callWithTimeout(dependencies.remover.lstat(target), dependencies.callTimeoutMillis);
        const reason = prepared.protectedSet.reasons.get(identityOf(stats));
        if (reason) {
            return { code: ERROR_PROTECTED_PATH, message: reason };
        }
        if (stats.dev !== prepared.directoryDevice) {
            return { code: ERROR_MOUNT_POINT, message: MESSAGE_SELECTED_MOUNT };
        }
        const context: WalkContext = { device: stats.dev, prepared, progress, dependencies, paths };
        const removed = await removeEntry(target, stats, context);
        return removed ? null : { code: ERROR_MOUNT_POINT, message: MESSAGE_MOUNT_INSIDE };
    } catch (err) {
        return nameFailure(err);
    }
}

/** Removes `target`. False when a mounted disk inside was left in place, so `target` stays. */
async function removeEntry(target: string, stats: fs.BigIntStats, context: WalkContext): Promise<boolean> {
    if (!stats.isDirectory()) {
        if (await removeWith(target, (entry) => context.dependencies.remover.unlink(entry), context)) {
            context.progress.files_done += 1;
        }
        return true;
    }
    return removeFolder(target, context);
}

async function removeFolder(folder: string, context: WalkContext): Promise<boolean> {
    const { remover, callTimeoutMillis } = context.dependencies;
    const removeFolderItself = (entry: string) => remover.rmdir(entry);
    try {
        if (await removeWith(folder, removeFolderItself, context)) {
            context.progress.files_done += 1;
        }
        return true;
    } catch (err) {
        if (!isNotEmpty(err)) {
            throw err;
        }
    }

    let names: string[];
    try {
        names = await callWithTimeout(remover.readdir(folder), callTimeoutMillis);
    } catch (err) {
        if (isGone(err)) {
            return true;
        }
        throw err;
    }
    let removedAll = true;
    for (const name of names) {
        if (!(await removeChild(context.paths.join(folder, name), context))) {
            removedAll = false;
        }
    }
    if (!removedAll) {
        return false;
    }
    if (await removeWith(folder, removeFolderItself, context)) {
        context.progress.files_done += 1;
    }
    return true;
}

/** 1 entry inside a tree. False when it is, or holds, a mounted disk left in place. */
async function removeChild(child: string, context: WalkContext): Promise<boolean> {
    let stats: fs.BigIntStats;
    try {
        stats = await callWithTimeout(context.dependencies.remover.lstat(child),
            context.dependencies.callTimeoutMillis);
    } catch (err) {
        if (isGone(err)) {
            return true;
        }
        throw err;
    }
    const reason = context.prepared.protectedSet.reasons.get(identityOf(stats));
    if (reason) {
        throw new ProtectedEntryError(reason);
    }
    if (stats.isDirectory() && stats.dev !== context.device) {
        return false;
    }
    return removeEntry(child, stats, context);
}

/**
 * 1 `unlink` or `rmdir`. True when it removed the entry, false when the entry was already gone. On
 * Windows a read-only entry answers `EPERM`: the mode is made writable and the call tried once more, as
 * `fs.rm` does.
 */
async function removeWith(target: string, remove: (entry: string) => Promise<void>,
                          context: WalkContext): Promise<boolean> {
    const { remover, callTimeoutMillis, platform } = context.dependencies;
    try {
        await callWithTimeout(remove(target), callTimeoutMillis);
        return true;
    } catch (err) {
        if (isGone(err)) {
            return false;
        }
        if (platform !== "win32" || errorCodeOf(err) !== "EPERM") {
            throw err;
        }
        try {
            await callWithTimeout(remover.chmod(target, WINDOWS_WRITABLE_MODE), callTimeoutMillis);
        } catch {
            throw err;
        }
    }
    try {
        await callWithTimeout(remove(target), callTimeoutMillis);
        return true;
    } catch (err) {
        if (isGone(err)) {
            return false;
        }
        throw err;
    }
}

function isGone(err: unknown): boolean {
    return errorCodeOf(err) === "ENOENT";
}

/** `rmdir` on a folder that still has entries. Some systems answer `EEXIST` for it. */
function isNotEmpty(err: unknown): boolean {
    const code = errorCodeOf(err);
    return code === "ENOTEMPTY" || code === "EEXIST";
}

function nameFailure(err: unknown): FileOperationFailure["error"] {
    if (err instanceof FileCallTimeoutError) {
        return { code: ERROR_FILE_TIMEOUT, message: err.message };
    }
    if (err instanceof ProtectedEntryError) {
        return { code: ERROR_PROTECTED_PATH, message: err.message };
    }
    const message = failureMessage(err, MESSAGE_DELETE_FAILED);
    switch (errorCodeOf(err)) {
        case "ENOENT":
        case "ENOTDIR":
            // Only the name's own lstat lets these through: inside the walk, a vanished entry is ignored.
            return { code: ERROR_PATH_NOT_FOUND, message };
        case "EACCES":
        case "EPERM":
        case "EROFS":
            return { code: ERROR_PERMISSION_DENIED, message };
        default:
            return { code: ERROR_FILE_OPERATION_FAILED, message };
    }
}

/** The counts, and the first failures that fit `maxPayloadBytes`. `failed_count` is always the true number. */
function answerWithin(completedCount: number, failures: FileOperationFailure[],
                      maxPayloadBytes: number): FileOperationAnswer {
    const answer: FileOperationAnswer = { completed_count: completedCount, failed_count: failures.length };
    const listed: FileOperationFailure[] = [];
    let payloadBytes = utf8Bytes({ ...answer, failed: [] });
    for (const failure of failures.slice(0, MAX_FAILURES_LISTED)) {
        const failureBytes = utf8Bytes(failure) + (listed.length > 0 ? 1 : 0);
        if (payloadBytes + failureBytes > maxPayloadBytes) {
            break;
        }
        listed.push(failure);
        payloadBytes += failureBytes;
    }
    if (listed.length > 0) {
        answer.failed = listed;
    }
    return answer;
}
