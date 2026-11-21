import crypto from "crypto";
import fs from "fs";
import path from "path";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import {
    ERROR_FILE_EXISTS, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_DESTINATION, ERROR_INVALID_NAME,
    ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_NOT_A_DIRECTORY, ERROR_NO_SPACE,
    ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, ERROR_SPECIAL_FILE, FileCopyRequest,
    FileCopyResult, FileError, FileOnConflict, FileOperationFailure, FileProgress, MAX_CONFLICTS_LISTED,
    MAX_NAME_BYTES, ON_CONFLICT_FAIL, ON_CONFLICT_KEEP_BOTH, ON_CONFLICT_REPLACE, ON_CONFLICT_SKIP, fileError,
} from "./file_schema.js";
import { DeleteDependencies, deleteFailure, operationAnswer, removeTree } from "./fileDelete.js";
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, ProtectedSet, ProtectedSources, identityOf, isInsideConfigFolder,
    readProtectedSet, selfAndAncestors,
} from "./fileProtectedPaths.js";
import {
    FileCallTimeoutError, FileSystemCopier, FileSystemRemover, LinkType, MESSAGE_NAME_TAKEN, errorCodeOf,
    failureMessage, nameProblem, namesProblem, pathProblem, pathsFor, utf8Bytes, windowsNameProblem,
} from "./fileSystem.js";

/**
 * `file/copy`: 1 or more names from 1 folder into another folder on the same device, or 1 name under
 * `new_name`. A folder copies whole.
 *
 * 2 steps, so the handler sends the first `progress` only once the copy runs. `prepareCopy` checks the
 * request: a folder into itself, every name taken under `on_conflict: fail`, and for `replace` the protected
 * folders. A refusal there has copied nothing. `runCopy` counts what the names hold, refuses with `no_space`
 * when the destination disk lacks the room, then copies each name in order. The first error ends that name:
 * the files it finished stay, and the file it was writing is removed. The next name goes on.
 *
 * A walk written by hand, not `fs.cp`: each of its calls goes through the handler's gate with a time limit, a
 * file copies in pieces so a large one reports bytes and a dead drive fails within the limit, and every entry
 * is made only if its name is free, so nothing is overwritten.
 *
 * What a copy keeps: the permission bits less setuid, setgid and sticky, and the access and modified times,
 * each set once the entry's contents are in, and skipped where the disk cannot store them. The owner is the
 * agent's user. A link is copied as a link with the same text. A disk mounted inside a folder is copied too.
 * A socket, a named pipe or a device file is left out, and its name then fails `special_file`.
 *
 * `replace` copies to a hidden name beside the target first, so a copy that fails leaves the old item as it
 * was. A file then takes the old one's place in 1 rename. A folder takes 2: the old one to a second hidden
 * name, the copy into place. The old one is then removed by `delete`'s walk, under `delete`'s protected
 * folders. Nothing here logs a path.
 */

/** 1 read and 1 write: a dead drive fails within 1 call's limit, and `bytes_done` moves inside a large file. */
const COPY_PIECE_BYTES = 1024 * 1024;
/** A file whose size reads 0 can still hold bytes, as files in `/proc` do. */
const SMALL_PIECE_BYTES = 4096;
/** The bits a copy takes from its source. setuid, setgid and sticky are left off. */
const PERMISSION_BITS = 0o777n;
/** `keep_both` stops looking for a free name after this many. */
const MAX_KEEP_BOTH_NUMBER = 1000;
const EXTENSION_SEPARATOR = ".";
const HIDDEN_NAME_PREFIX = ".";
const HIDDEN_COPY_MARK = "copy";
const HIDDEN_OLD_MARK = "old";
const HIDDEN_SUFFIX_BYTES = 4;
const LINK_TYPE_FILE: LinkType = "file";
const LINK_TYPE_FOLDER: LinkType = "dir";
const BYTES_PER_UNIT = 1000;
const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"];
const BYTE_UNIT_SINGULAR = "byte";

const MESSAGE_NEW_NAME_NEEDS_1 = "A new name needs exactly 1 name.";
const MESSAGE_FOLDER_UNREADABLE = "The folder could not be read.";
const MESSAGE_NOT_A_FOLDER = "The path is not a folder.";
const MESSAGE_INTO_ITSELF = "A folder cannot be copied into itself.";
const MESSAGE_REPLACE_ITSELF = "An item cannot replace itself.";
const MESSAGE_PROTECTED_UNREAD = "The protected folders could not be read in time.";
const MESSAGE_SPECIAL_SELECTED = "This is a socket, pipe or device file. Pinggy cannot copy it.";
const MESSAGE_REPLACE_MOUNT = "This item is a mounted disk. Pinggy does not replace it.";
const MESSAGE_COPY_FAILED = "The item could not be copied.";
const MESSAGE_COPY_IN_PLACE = "The copy is in place. The old one stays as";
const MESSAGE_MOUNT_INSIDE_OLD = "a disk is mounted inside it.";

export interface CopyDependencies {
    /** Each call already limited in time by the handler's gate. */
    copier: FileSystemCopier;
    /** For `replace`: the protected folders, and the old item removed as a delete removes a name. */
    remover: FileSystemRemover;
    /** Picks the path rules, and the Windows rules for `new_name`. */
    platform: NodeJS.Platform;
    protectedSources: ProtectedSources;
    /** The limit on each protected-folder read. */
    callTimeoutMillis: number;
    /** 8 hex digits for `replace`'s hidden names. */
    hiddenNameSuffix: () => string;
}

/** What `replace` checks each target against. */
interface ReplaceGuard {
    protectedSet: ProtectedSet;
    /** Every target is protected: the destination is the config folder or inside it. */
    insideConfigFolder: boolean;
    /** Every target is an account's home: the destination is the accounts folder. */
    inAccountsFolder: boolean;
}

/** A request that passed every check. */
export interface PreparedCopy {
    sourceDirectory: string;
    destinationDirectory: string;
    names: string[];
    newName?: string;
    onConflict: FileOnConflict;
    /** A `replace` target on another device is a mounted disk. */
    destinationDevice: bigint;
    /** `replace` only. */
    replaceGuard: ReplaceGuard | null;
}

/** A copy's `progress`, with the byte count it always carries. */
type CopyProgress = FileProgress & { bytes_done: number };

/** The walk's shared state for 1 name. */
interface CopyWalk {
    copier: FileSystemCopier;
    paths: path.PlatformPath;
    platform: NodeJS.Platform;
    progress: CopyProgress;
    /** Sockets, named pipes and device files met inside the name and left out. */
    specialFilesLeftOut: number;
}

/** The name the request asked for is taken. `on_conflict` decides what follows. */
class TakenError extends Error {}

/** A refusal of the whole request, thrown out of the checks. */
class CopyRefusal extends Error {
    constructor(readonly refusal: FileError) {
        super(refusal.error.message);
    }
}

/** Why 1 name failed, as 1 entry of `failed`. */
type NameFailure = FileOperationFailure["error"];

const SKIPPED = "skipped";
type NameOutcome = typeof SKIPPED | NameFailure | null;

export function randomHiddenNameSuffix(): string {
    return crypto.randomBytes(HIDDEN_SUFFIX_BYTES).toString("hex");
}

/**
 * Checks the request and reads what the copy matches against. Never throws: every refusal is an error answer,
 * and none has copied anything.
 *
 * @param maxPayloadBytes the most a refusal's payload may take, so `conflicts` fits the frame
 */
export async function prepareCopy(request: FileCopyRequest, dependencies: CopyDependencies,
                                  maxPayloadBytes: number): Promise<PreparedCopy | FileError> {
    try {
        return await checkedCopy(request, dependencies, maxPayloadBytes);
    } catch (err) {
        if (err instanceof CopyRefusal) {
            return err.refusal;
        }
        const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
        return fileError(code, failureMessage(err, MESSAGE_FOLDER_UNREADABLE));
    }
}

async function checkedCopy(request: FileCopyRequest, dependencies: CopyDependencies,
                           maxPayloadBytes: number): Promise<PreparedCopy> {
    const { copier, platform } = dependencies;
    checkNames(request, platform);
    const paths = pathsFor(platform);
    for (const folder of [request.source_directory, request.destination_directory]) {
        const issue = pathProblem(folder, paths);
        if (issue) {
            throw new CopyRefusal(fileError(ERROR_INVALID_PATH, issue));
        }
    }
    const sourceDirectory = paths.resolve(request.source_directory);
    const destinationDirectory = paths.resolve(request.destination_directory);
    await folderStats(sourceDirectory, copier);
    const destinationStats = await folderStats(destinationDirectory, copier);

    const onConflict = request.on_conflict ?? ON_CONFLICT_FAIL;
    const targetNames = request.new_name === undefined ? request.names : [request.new_name];
    const sources = await Promise.all(request.names.map((name) =>
        lstatOrNull(paths.join(sourceDirectory, name), copier)));
    await refuseIntoItself(sources, destinationDirectory, dependencies);

    if (onConflict === ON_CONFLICT_FAIL || onConflict === ON_CONFLICT_REPLACE) {
        const targets = await Promise.all(targetNames.map((name) =>
            lstatOrNull(paths.join(destinationDirectory, name), copier)));
        if (onConflict === ON_CONFLICT_REPLACE && targets.some((target, index) =>
            target !== null && sources[index] !== null && identityOf(target) === identityOf(sources[index]!))) {
            throw new CopyRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_ITSELF));
        }
        const conflicts = request.names.filter((_name, index) => targets[index] !== null);
        if (onConflict === ON_CONFLICT_FAIL && conflicts.length > 0) {
            throw new CopyRefusal(conflictRefusal(conflicts, maxPayloadBytes));
        }
    }

    const replaceGuard = onConflict === ON_CONFLICT_REPLACE
        ? await readReplaceGuard(destinationDirectory, destinationStats, dependencies) : null;
    return {
        sourceDirectory, destinationDirectory, names: request.names, newName: request.new_name, onConflict,
        destinationDevice: destinationStats.dev, replaceGuard,
    };
}

/** `names` by `delete`'s rule, then `new_name` by `mkdir`'s, with Windows' rules on Windows. */
function checkNames(request: FileCopyRequest, platform: NodeJS.Platform): void {
    const namesIssue = namesProblem(request.names, platform);
    if (namesIssue) {
        throw new CopyRefusal(fileError(ERROR_INVALID_PAYLOAD, namesIssue));
    }
    if (request.new_name === undefined) {
        return;
    }
    if (request.names.length !== 1) {
        throw new CopyRefusal(fileError(ERROR_INVALID_PAYLOAD, MESSAGE_NEW_NAME_NEEDS_1));
    }
    const newNameIssue = nameProblem(request.new_name, platform);
    if (newNameIssue) {
        throw new CopyRefusal(fileError(ERROR_INVALID_PAYLOAD, newNameIssue));
    }
    const windowsIssue = platform === "win32" ? windowsNameProblem(request.new_name, "A name") : null;
    if (windowsIssue) {
        throw new CopyRefusal(fileError(ERROR_INVALID_NAME, windowsIssue));
    }
}

/** `stat` of a folder the request names. Refuses a folder that is gone, unreadable or a file. */
async function folderStats(folder: string, copier: FileSystemCopier): Promise<fs.BigIntStats> {
    let stats: fs.BigIntStats;
    try {
        stats = await copier.stat(folder);
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        throw new CopyRefusal(folderFailure(err));
    }
    if (!stats.isDirectory()) {
        throw new CopyRefusal(fileError(ERROR_NOT_A_DIRECTORY, MESSAGE_NOT_A_FOLDER));
    }
    return stats;
}

function folderFailure(err: unknown): FileError {
    const message = failureMessage(err, MESSAGE_FOLDER_UNREADABLE);
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

/**
 * A selected folder that is the destination or a folder above it. The destination's real path is read first,
 * so a link that leads inside the folder is caught, and each folder above it is matched by `(dev, ino)`.
 */
async function refuseIntoItself(sources: Array<fs.BigIntStats | null>, destinationDirectory: string,
                                dependencies: CopyDependencies): Promise<void> {
    const folders = sources.filter((stats): stats is fs.BigIntStats => stats !== null && stats.isDirectory());
    if (folders.length === 0) {
        return;
    }
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const realDestination = await copier.realpath(destinationDirectory);
    const chain = new Set(await Promise.all(selfAndAncestors(realDestination, paths).map((folder) =>
        identityOrNull(copier.stat(folder)))));
    if (folders.some((stats) => chain.has(identityOf(stats)))) {
        throw new CopyRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_INTO_ITSELF));
    }
}

/** `file_exists` with the taken names as the request sent them: the first 20 that fit the frame. */
function conflictRefusal(conflicts: string[], maxPayloadBytes: number): FileError {
    const message = conflicts.length === 1
        ? "1 item already exists in the destination."
        : `${conflicts.length} items already exist in the destination.`;
    const listed: string[] = [];
    const refusal: FileError = {
        error: { code: ERROR_FILE_EXISTS, message, conflict_count: conflicts.length, conflicts: listed },
    };
    let payloadBytes = utf8Bytes(refusal);
    for (const name of conflicts.slice(0, MAX_CONFLICTS_LISTED)) {
        const nameBytes = utf8Bytes(name) + (listed.length > 0 ? 1 : 0);
        if (payloadBytes + nameBytes > maxPayloadBytes) {
            break;
        }
        listed.push(name);
        payloadBytes += nameBytes;
    }
    return refusal;
}

async function readReplaceGuard(destinationDirectory: string, destinationStats: fs.BigIntStats,
                                dependencies: CopyDependencies): Promise<ReplaceGuard> {
    const { remover, callTimeoutMillis, protectedSources } = dependencies;
    const paths = pathsFor(dependencies.platform);
    try {
        const protectedSet = await readProtectedSet(protectedSources, paths, remover, callTimeoutMillis);
        const insideConfigFolder = await isInsideConfigFolder(destinationDirectory, protectedSet, paths, remover,
            callTimeoutMillis);
        const inAccountsFolder = protectedSet.accountsFolder !== null
            && identityOf(destinationStats) === protectedSet.accountsFolder;
        return { protectedSet, insideConfigFolder, inAccountsFolder };
    } catch (err) {
        // A read that timed out. Without every protected folder read, nothing is safe to replace.
        const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
        throw new CopyRefusal(fileError(code, failureMessage(err, MESSAGE_PROTECTED_UNREAD)));
    }
}

/**
 * Counts what the names hold, checks the destination's free space, then copies each name in order, counting
 * into `progress` as it goes. Never throws: a failure is 1 entry of `failed`, and the only refusal of the whole
 * request is `no_space`, before anything is copied.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function runCopy(prepared: PreparedCopy, progress: FileProgress, dependencies: CopyDependencies,
                              maxPayloadBytes: number): Promise<FileCopyResult> {
    const counted: CopyProgress = Object.assign(progress, { bytes_done: progress.bytes_done ?? 0 });
    const paths = pathsFor(dependencies.platform);
    const totals = await countNames(prepared, dependencies);
    counted.files_total = totals.files;
    counted.bytes_total = totals.bytes;
    const freeBytes = await dependencies.copier.freeBytes(prepared.destinationDirectory).catch(() => null);
    if (freeBytes !== null && BigInt(totals.bytes) > freeBytes) {
        return fileError(ERROR_NO_SPACE, `The copy needs ${formatBytes(totals.bytes)}. `
            + `The destination disk has ${formatBytes(freeBytes)} free.`);
    }

    let completedCount = 0;
    let skippedCount = 0;
    const failures: FileOperationFailure[] = [];
    for (const name of prepared.names) {
        counted.current_name = name;
        const walk: CopyWalk = {
            copier: dependencies.copier, paths, platform: dependencies.platform, progress: counted,
            specialFilesLeftOut: 0,
        };
        const outcome = await copyName(name, prepared, walk, dependencies);
        if (outcome === SKIPPED) {
            skippedCount += 1;
        } else if (outcome === null) {
            completedCount += 1;
        } else {
            failures.push({ name, error: outcome });
        }
        counted.items_done += 1;
    }
    return operationAnswer(completedCount, failures, maxPayloadBytes, skippedCount);
}

/**
 * Files, folders and links in every name, and the bytes of the files. An entry that cannot be read is left out:
 * the copy meets it again and fails there. Under `skip`, a name whose target is taken now is left out too.
 */
async function countNames(prepared: PreparedCopy, dependencies: CopyDependencies):
    Promise<{ files: number; bytes: number }> {
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const totals = { files: 0, bytes: 0 };
    for (const name of prepared.names) {
        const target = paths.join(prepared.destinationDirectory, prepared.newName ?? name);
        if (prepared.onConflict === ON_CONFLICT_SKIP && await lstatOrNull(target, copier).catch(() => null)) {
            continue;
        }
        await countEntry(paths.join(prepared.sourceDirectory, name), totals, copier, paths);
    }
    return totals;
}

async function countEntry(entry: string, totals: { files: number; bytes: number }, copier: FileSystemCopier,
                          paths: path.PlatformPath): Promise<void> {
    let stats: fs.BigIntStats;
    try {
        stats = await copier.lstat(entry);
    } catch {
        return;
    }
    if (isSpecial(stats)) {
        return;
    }
    totals.files += 1;
    if (stats.isFile()) {
        totals.bytes += Number(stats.size);
        return;
    }
    if (!stats.isDirectory()) {
        return;
    }
    let children: string[];
    try {
        children = await copier.readdir(entry);
    } catch {
        return;
    }
    for (const child of children) {
        await countEntry(paths.join(entry, child), totals, copier, paths);
    }
}

/** Copied: null. Left alone by `skip`: {@link SKIPPED}. Else the failure. */
async function copyName(name: string, prepared: PreparedCopy, walk: CopyWalk,
                        dependencies: CopyDependencies): Promise<NameOutcome> {
    const { paths, copier } = walk;
    const source = paths.join(prepared.sourceDirectory, name);
    const targetName = prepared.newName ?? name;
    const target = paths.join(prepared.destinationDirectory, targetName);
    const targetIssue = pathProblem(target, paths);
    if (targetIssue) {
        return { code: ERROR_INVALID_PATH, message: targetIssue };
    }
    try {
        const stats = await copier.lstat(source);
        if (isSpecial(stats)) {
            return { code: ERROR_SPECIAL_FILE, message: MESSAGE_SPECIAL_SELECTED };
        }
        if (prepared.onConflict === ON_CONFLICT_REPLACE) {
            const refusal = await replaceName(source, stats, targetName, prepared, walk, dependencies);
            if (refusal) {
                return refusal;
            }
        } else if (await copyToFreeName(source, stats, targetName, prepared, walk) === SKIPPED) {
            return SKIPPED;
        }
    } catch (err) {
        return copyFailure(err);
    }
    return walk.specialFilesLeftOut > 0 ? specialFilesLeftOut(walk.specialFilesLeftOut) : null;
}

/**
 * Copies to the target name, or, when it is taken, as `on_conflict` says: `skip` leaves it, `keep_both` tries
 * `name (1).ext`, `name (2).ext` and so on, and `fail` fails the name with `file_exists`.
 */
async function copyToFreeName(source: string, stats: fs.BigIntStats, targetName: string, prepared: PreparedCopy,
                              walk: CopyWalk): Promise<typeof SKIPPED | null> {
    let candidate = targetName;
    for (let number = 1; ; number++) {
        try {
            await copyEntry(source, stats, walk.paths.join(prepared.destinationDirectory, candidate), walk, true);
            return null;
        } catch (err) {
            if (!(err instanceof TakenError)) {
                throw err;
            }
            if (prepared.onConflict === ON_CONFLICT_SKIP) {
                return SKIPPED;
            }
            if (prepared.onConflict !== ON_CONFLICT_KEEP_BOTH || number > MAX_KEEP_BOTH_NUMBER) {
                throw err;
            }
            candidate = keepBothName(targetName, stats.isDirectory(), number);
        }
    }
}

/**
 * `replace`: copies beside the target under a hidden name, then swaps. Null when the copy is in place. A
 * refusal of the target, before anything is copied, or a failure to remove the old item afterwards, comes back
 * as the failure. Any other failure is thrown, with the old item as it was.
 */
async function replaceName(source: string, stats: fs.BigIntStats, targetName: string, prepared: PreparedCopy,
                           walk: CopyWalk, dependencies: CopyDependencies): Promise<NameFailure | null> {
    const { copier, paths } = walk;
    const guard = prepared.replaceGuard!;
    const target = paths.join(prepared.destinationDirectory, targetName);
    const existing = await lstatOrNull(target, copier);
    if (existing === null) {
        await copyEntry(source, stats, target, walk, true);
        return null;
    }
    const refusal = replaceRefusal(existing, stats, prepared, guard);
    if (refusal) {
        return refusal;
    }

    const suffix = dependencies.hiddenNameSuffix();
    const hiddenCopy = paths.join(prepared.destinationDirectory, hiddenName(targetName, HIDDEN_COPY_MARK, suffix));
    try {
        await copyEntry(source, stats, hiddenCopy, walk, true);
    } catch (err) {
        if (!(err instanceof TakenError)) {
            await removeQuietly(hiddenCopy, guard, dependencies);
        }
        throw err;
    }
    if (!existing.isDirectory() && !stats.isDirectory()) {
        try {
            await copier.rename(hiddenCopy, target);
        } catch (err) {
            await removeQuietly(hiddenCopy, guard, dependencies);
            throw err;
        }
        return null;
    }

    const oldName = hiddenName(targetName, HIDDEN_OLD_MARK, suffix);
    const hiddenOld = paths.join(prepared.destinationDirectory, oldName);
    try {
        await copier.rename(target, hiddenOld);
    } catch (err) {
        await removeQuietly(hiddenCopy, guard, dependencies);
        throw err;
    }
    try {
        await copier.rename(hiddenCopy, target);
    } catch (err) {
        await copier.rename(hiddenOld, target).catch(() => undefined);
        await removeQuietly(hiddenCopy, guard, dependencies);
        throw err;
    }
    return removeOld(hiddenOld, oldName, existing, guard, dependencies);
}

/** A target `delete` would refuse, or the source itself. */
function replaceRefusal(existing: fs.BigIntStats, source: fs.BigIntStats, prepared: PreparedCopy,
                        guard: ReplaceGuard): NameFailure | null {
    if (identityOf(existing) === identityOf(source)) {
        return { code: ERROR_INVALID_DESTINATION, message: MESSAGE_REPLACE_ITSELF };
    }
    if (guard.insideConfigFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER };
    }
    if (guard.inAccountsFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNT_FOLDER };
    }
    const reason = guard.protectedSet.reasons.get(identityOf(existing));
    if (reason) {
        return { code: ERROR_PROTECTED_PATH, message: reason };
    }
    if (existing.dev !== prepared.destinationDevice) {
        return { code: ERROR_MOUNT_POINT, message: MESSAGE_REPLACE_MOUNT };
    }
    return null;
}

/** Removes the old item once the copy is in its place. A failure leaves it under its hidden name, and says so. */
async function removeOld(hiddenOld: string, oldName: string, existing: fs.BigIntStats, guard: ReplaceGuard,
                         dependencies: CopyDependencies): Promise<NameFailure | null> {
    try {
        if (await removeTree(hiddenOld, existing, guard.protectedSet, deleteDependencies(dependencies))) {
            return null;
        }
        return { code: ERROR_MOUNT_POINT, message: `${MESSAGE_COPY_IN_PLACE} ${oldName}: ${MESSAGE_MOUNT_INSIDE_OLD}` };
    } catch (err) {
        const failure = deleteFailure(err);
        const message = sanitizeErrorMessage(`${MESSAGE_COPY_IN_PLACE} ${oldName}: ${failure.message}`)
            ?? failure.message;
        return { code: failure.code, message };
    }
}

/** A hidden copy this request made, removed after its copy or its swap failed. A failure here leaves it. */
async function removeQuietly(entry: string, guard: ReplaceGuard, dependencies: CopyDependencies): Promise<void> {
    try {
        const stats = await dependencies.remover.lstat(entry);
        await removeTree(entry, stats, guard.protectedSet, deleteDependencies(dependencies));
    } catch {
        // Already gone, or the drive stopped answering: the hidden copy stays, as after an agent stop.
    }
}

function deleteDependencies(dependencies: CopyDependencies): DeleteDependencies {
    const { remover, platform, protectedSources, callTimeoutMillis } = dependencies;
    return { remover, platform, protectedSources, callTimeoutMillis };
}

/**
 * Makes `target` as a copy of `source`, whose `lstat` is `stats`. `top` marks the name itself: its target
 * taken throws a {@link TakenError}, which `on_conflict` reads. Taken inside a folder, it is an error.
 */
async function copyEntry(source: string, stats: fs.BigIntStats, target: string, walk: CopyWalk,
                         top: boolean): Promise<void> {
    if (stats.isSymbolicLink()) {
        await copyLink(source, target, walk, top);
    } else if (stats.isDirectory()) {
        await copyFolder(source, stats, target, walk, top);
    } else if (stats.isFile()) {
        await copyFile(source, stats, target, walk, top);
    } else {
        walk.specialFilesLeftOut += 1;
    }
}

/**
 * The source is opened first, so a file that cannot be read leaves no empty copy. A copy that fails while
 * it writes is removed, so no cut-off file stays under a real name.
 */
async function copyFile(source: string, stats: fs.BigIntStats, target: string, walk: CopyWalk,
                        top: boolean): Promise<void> {
    const { copier, progress } = walk;
    const reader = await copier.openToRead(source);
    let writer: fs.promises.FileHandle;
    try {
        writer = await created(copier.createFile(target), top);
    } catch (err) {
        await closeQuietly(reader, copier);
        throw err;
    }
    // A buffer for this file only: a read abandoned at its time limit can still fill it later.
    const buffer = Buffer.allocUnsafe(Math.min(COPY_PIECE_BYTES, Math.max(SMALL_PIECE_BYTES, Number(stats.size) + 1)));
    try {
        for (;;) {
            const bytesRead = await copier.read(reader, buffer);
            if (bytesRead === 0) {
                break;
            }
            await copier.write(writer, buffer, bytesRead);
            progress.bytes_done += bytesRead;
        }
        // A close that fails can mean the bytes never reached the disk.
        await copier.close(writer);
    } catch (err) {
        await closeQuietly(writer, copier);
        await copier.unlink(target).catch(() => undefined);
        throw err;
    } finally {
        await closeQuietly(reader, copier);
    }
    await keepModeAndTimes(target, stats, copier);
    progress.files_done += 1;
}

/** The folder's own bits and times go on last: a read-only folder can still be filled. */
async function copyFolder(source: string, stats: fs.BigIntStats, target: string, walk: CopyWalk,
                          top: boolean): Promise<void> {
    const { copier, paths } = walk;
    await created(copier.mkdir(target), top);
    walk.progress.files_done += 1;
    for (const child of await copier.readdir(source)) {
        const childSource = paths.join(source, child);
        let childStats: fs.BigIntStats;
        try {
            childStats = await copier.lstat(childSource);
        } catch (err) {
            if (errorCodeOf(err) === "ENOENT") {
                // A running build deleting its own temp files must not fail the copy.
                continue;
            }
            throw err;
        }
        await copyEntry(childSource, childStats, paths.join(target, child), walk, false);
    }
    await keepModeAndTimes(target, stats, copier);
}

/** The same text, so a relative link points where its text leads from its new place. */
async function copyLink(source: string, target: string, walk: CopyWalk, top: boolean): Promise<void> {
    const { copier } = walk;
    const linkText = await copier.readlink(source);
    const type = walk.platform === "win32" ? await linkTypeOf(source, copier) : LINK_TYPE_FILE;
    await created(copier.symlink(linkText, target, type), top);
    walk.progress.files_done += 1;
}

/** Windows makes a link to a folder differently from a link to a file. A broken link counts as a file. */
async function linkTypeOf(link: string, copier: FileSystemCopier): Promise<LinkType> {
    try {
        return (await copier.stat(link)).isDirectory() ? LINK_TYPE_FOLDER : LINK_TYPE_FILE;
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        return LINK_TYPE_FILE;
    }
}

/**
 * The times first: on Windows a read-only bit could block them. A disk that cannot store one, such as FAT32 for the
 * bits, skips it.
 */
async function keepModeAndTimes(target: string, stats: fs.BigIntStats, copier: FileSystemCopier): Promise<void> {
    await copier.utimes(target, stats.atime, stats.mtime).catch(() => undefined);
    await copier.chmod(target, Number(stats.mode & PERMISSION_BITS)).catch(() => undefined);
}

/** `making`, with a taken name turned into a {@link TakenError} when it is the name itself. */
async function created<T>(making: Promise<T>, top: boolean): Promise<T> {
    try {
        return await making;
    } catch (err) {
        if (top && errorCodeOf(err) === "EEXIST") {
            throw new TakenError(MESSAGE_NAME_TAKEN);
        }
        throw err;
    }
}

async function closeQuietly(handle: fs.promises.FileHandle, copier: FileSystemCopier): Promise<void> {
    await copier.close(handle).catch(() => undefined);
}

/**
 * `name (1).ext` for a file, `name (1)` for a folder. The number goes before the last dot. A name that starts
 * with a dot and has no other dot has no extension: `.env (1)`. The part before the number is cut so the name
 * stays within {@link MAX_NAME_BYTES}.
 */
export function keepBothName(name: string, isFolder: boolean, number: number): string {
    const suffix = ` (${number})`;
    const dot = isFolder ? -1 : name.lastIndexOf(EXTENSION_SEPARATOR);
    let stem = dot > 0 ? name.slice(0, dot) : name;
    let extension = dot > 0 ? name.slice(dot) : "";
    if (Buffer.byteLength(suffix + extension, "utf8") >= MAX_NAME_BYTES) {
        stem = name;
        extension = "";
    }
    const room = MAX_NAME_BYTES - Buffer.byteLength(suffix + extension, "utf8");
    return `${cutToBytes(stem, room)}${suffix}${extension}`;
}

/** `.web.pinggy-copy-3f2a9c1e`: hidden on Linux and macOS, and within {@link MAX_NAME_BYTES}. */
function hiddenName(targetName: string, mark: string, suffix: string): string {
    const tail = `.pinggy-${mark}-${suffix}`;
    const room = MAX_NAME_BYTES - Buffer.byteLength(HIDDEN_NAME_PREFIX + tail, "utf8");
    return `${HIDDEN_NAME_PREFIX}${cutToBytes(targetName, room)}${tail}`;
}

/** The longest start of `text` within `maxBytes` of UTF-8, never splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
    let bytes = 0;
    let kept = "";
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        kept += character;
        bytes += characterBytes;
    }
    return kept;
}

/** "12.4 GB", in powers of 1000, as disks are sold. */
export function formatBytes(bytes: number | bigint): string {
    let value = Number(bytes);
    let unit = 0;
    while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
        value /= BYTES_PER_UNIT;
        unit += 1;
    }
    if (unit > 0) {
        return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
    }
    return value === 1 ? `1 ${BYTE_UNIT_SINGULAR}` : `${value} ${BYTE_UNITS[0]}`;
}

/** A socket, a named pipe or a device file: Node can make none of them. */
function isSpecial(stats: fs.BigIntStats): boolean {
    return !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink();
}

function specialFilesLeftOut(count: number): NameFailure {
    const message = count === 1
        ? "1 socket, pipe or device file inside was left out."
        : `${count} sockets, pipes or device files inside were left out.`;
    return { code: ERROR_SPECIAL_FILE, message };
}

/** `lstat`, or null when it fails. A timeout is thrown: a check that could not run must not pass. */
async function lstatOrNull(target: string, copier: FileSystemCopier): Promise<fs.BigIntStats | null> {
    try {
        return await copier.lstat(target);
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        return null;
    }
}

/** The identity `read` gives, or null when it fails. A timeout is thrown. */
async function identityOrNull(read: Promise<fs.BigIntStats>): Promise<string | null> {
    try {
        return identityOf(await read);
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        return null;
    }
}

function copyFailure(err: unknown): NameFailure {
    if (err instanceof TakenError) {
        return { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN };
    }
    if (err instanceof FileCallTimeoutError) {
        return { code: ERROR_FILE_TIMEOUT, message: err.message };
    }
    const message = failureMessage(err, MESSAGE_COPY_FAILED);
    switch (errorCodeOf(err)) {
        case "ENOENT":
        case "ENOTDIR":
            return { code: ERROR_PATH_NOT_FOUND, message };
        case "EEXIST":
            return { code: ERROR_FILE_EXISTS, message };
        case "EACCES":
        case "EPERM":
        case "EROFS":
            return { code: ERROR_PERMISSION_DENIED, message };
        case "ENOSPC":
        case "EDQUOT":
            return { code: ERROR_NO_SPACE, message };
        default:
            return { code: ERROR_FILE_OPERATION_FAILED, message };
    }
}
