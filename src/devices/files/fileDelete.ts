import fs from "fs";
import path from "path";
import {
    ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH, ERROR_MOUNT_POINT, ERROR_PATH_NOT_FOUND,
    ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, FileDeleteRequest, FileDeleteResult, FileError, FileFailure,
    FileProgress, fileError,
} from "./file_schema.js";
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, ProtectedSet, ProtectedSources, identityOf, isInsideConfigFolder,
    readProtectedSet,
} from "./fileProtectedPaths.js";
import {
    FileCallTimeoutError, FileSystemRemover, callWithTimeout, errorCodeOf, failureMessage, pathProblem, pathsFor,
    resolvedItem,
} from "./fileSystem.js";

/**
 * `file/delete`: 1 path, recursively and for good.
 *
 * 2 steps, so the handler sends the first `progress` only once the delete runs. `prepareDelete` checks the item and
 * reads the protected folders: a refusal there has deleted nothing. `runDelete` then removes it. The first error ends
 * the delete, and what it already removed stays removed.
 *
 * The item is removed by a walk, not `fs.rm`, for 4 things `fs.rm` cannot do:
 * - check every entry against the protected folders, not only the item asked for;
 * - give each filesystem call a time limit, so a hung network drive fails the delete and frees the slot;
 * - stay on the disk the item is on: a folder on another device is skipped and left in place;
 * - count each removal for `progress`.
 *
 * The walk tries `rmdir` on a folder before it reads it, as `fs.rm` does. A folder whose parent cannot be
 * written then fails before anything inside it goes. It handles 1 entry at a time, so a delete holds at
 * most 1 of Node's worker threads. An entry that vanishes mid-walk is ignored: a build deleting its own
 * temp files must not fail the delete.
 *
 * The folder the item is in decides 2 checks: in the config folder, or in the accounts folder, the item is
 * protected, and on another device than that folder, the item is a mounted disk. A root is its own folder, and a
 * protected folder.
 *
 * A bind mount of a folder on the same disk has the same device, so the walk goes through it unless it
 * is a protected folder. Nothing here logs a path.
 */

/** What Windows needs before it deletes an entry marked read-only. `fs.rm` uses the same. */
const WINDOWS_WRITABLE_MODE = 0o666;

const MESSAGE_DELETE_FAILED = "The item could not be deleted.";
const MESSAGE_PROTECTED_UNREAD = "The protected folders could not be read in time.";
const MESSAGE_SELECTED_MOUNT = "This folder is a mounted disk. Open it to delete what is inside.";
const MESSAGE_MOUNT_INSIDE = "Another disk is mounted inside. Pinggy left it in place.";

export interface DeleteDependencies {
    remover: FileSystemRemover;
    /** Picks the path rules. */
    platform: NodeJS.Platform;
    protectedSources: ProtectedSources;
    /** The limit on each filesystem call. */
    callTimeoutMillis: number;
}

/** An item that passed every check, with what the walk matches against. */
export interface PreparedDelete {
    /** The item, resolved. */
    target: string;
    /** The item's own name, for `progress`. */
    name: string;
    /** The item's `lstat`: a link is removed as itself. */
    stats: fs.BigIntStats;
    protectedSet: ProtectedSet;
}

/** The walk's shared state for 1 item. */
interface WalkContext {
    /** The item's own device. A folder on another one is a mount, left in place. */
    device: bigint;
    protectedSet: ProtectedSet;
    progress: Pick<FileProgress, "files_done">;
    dependencies: DeleteDependencies;
    paths: path.PlatformPath;
}

/** A protected folder met inside a tree: a bind mount of home, for example. It ends the delete. */
class ProtectedEntryError extends Error {}

/**
 * Checks the item and reads what the walk matches against. Never throws: every refusal is an error answer, and none
 * has deleted anything.
 */
export async function prepareDelete(request: FileDeleteRequest, dependencies: DeleteDependencies):
    Promise<PreparedDelete | FileError> {
    const paths = pathsFor(dependencies.platform);
    const pathIssue = pathProblem(request.path, paths);
    if (pathIssue) {
        return fileError(ERROR_INVALID_PATH, pathIssue);
    }
    const item = resolvedItem(request.path, paths);
    const { remover, callTimeoutMillis } = dependencies;

    let stats: fs.BigIntStats;
    let parentStats: fs.BigIntStats;
    try {
        stats = await callWithTimeout(remover.lstat(item.path), callTimeoutMillis);
        parentStats = await callWithTimeout(remover.stat(item.parent), callTimeoutMillis);
    } catch (err) {
        return { error: deleteFailure(err) };
    }

    let protectedSet: ProtectedSet;
    let insideConfigFolder: boolean;
    try {
        protectedSet = await readProtectedSet(dependencies.protectedSources, paths, remover, callTimeoutMillis);
        insideConfigFolder = await isInsideConfigFolder(item.parent, protectedSet, paths, remover, callTimeoutMillis);
    } catch (err) {
        // A read that timed out. Without every protected folder read, nothing is safe to delete.
        const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
        return fileError(code, failureMessage(err, MESSAGE_PROTECTED_UNREAD));
    }
    if (insideConfigFolder) {
        return fileError(ERROR_PROTECTED_PATH, MESSAGE_PINGGY_FOLDER);
    }
    if (protectedSet.accountsFolder !== null && identityOf(parentStats) === protectedSet.accountsFolder) {
        return fileError(ERROR_PROTECTED_PATH, MESSAGE_ACCOUNT_FOLDER);
    }
    const reason = protectedSet.reasons.get(identityOf(stats));
    if (reason) {
        return fileError(ERROR_PROTECTED_PATH, reason);
    }
    if (stats.dev !== parentStats.dev) {
        return fileError(ERROR_MOUNT_POINT, MESSAGE_SELECTED_MOUNT);
    }
    return { target: item.path, name: item.name, stats, protectedSet };
}

/** Removes the item, and counts into `progress` as it goes. Never throws: a failure is the error answer. */
export async function runDelete(prepared: PreparedDelete, progress: FileProgress,
                                dependencies: DeleteDependencies): Promise<FileDeleteResult> {
    const context: WalkContext = {
        device: prepared.stats.dev, protectedSet: prepared.protectedSet, progress, dependencies,
        paths: pathsFor(dependencies.platform),
    };
    let result: FileDeleteResult = {};
    try {
        if (!(await removeEntry(prepared.target, prepared.stats, context))) {
            result = fileError(ERROR_MOUNT_POINT, MESSAGE_MOUNT_INSIDE);
        }
    } catch (err) {
        result = { error: deleteFailure(err) };
    }
    progress.items_done += 1;
    return result;
}

/**
 * Removes `target`, whose `lstat` is `stats`, by the walk: what a delete does to its item once the item's own
 * checks passed. `copy`'s `replace` removes the old item with it. False when a mounted disk inside was left in
 * place. Throws the first error, which {@link deleteFailure} reads.
 */
export function removeTree(target: string, stats: fs.BigIntStats, protectedSet: ProtectedSet,
                           dependencies: DeleteDependencies): Promise<boolean> {
    const context: WalkContext = {
        device: stats.dev, protectedSet, progress: { files_done: 0 }, dependencies,
        paths: pathsFor(dependencies.platform),
    };
    return removeEntry(target, stats, context);
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
    const reason = context.protectedSet.reasons.get(identityOf(stats));
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

/** A failed removal, as the error answer. */
export function deleteFailure(err: unknown): FileFailure {
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
            // Only the item's own lstat lets these through: inside the walk, a vanished entry is ignored.
            return { code: ERROR_PATH_NOT_FOUND, message };
        case "EACCES":
        case "EPERM":
        case "EROFS":
            return { code: ERROR_PERMISSION_DENIED, message };
        default:
            return { code: ERROR_FILE_OPERATION_FAILED, message };
    }
}
