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
 * 2 steps, so the handler sends the first `progress` only once the copy runs. `prepareCopy` checks the request: a
 * folder into itself, every name taken under `on_conflict: fail`, and for `replace` a target that holds the source and
 * the protected folders. A refusal there has copied nothing. `runCopy` counts what the names hold, refuses with
 * `no_space` when the destination disk lacks the room, then copies each name in order. The first error ends that name:
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
 *
 * `file/move` runs the same checks, the same walk and the same swap, from `fileMove.ts`: what it shares is exported.
 */

/** 1 read and 1 write: a dead drive fails within 1 call's limit, and `bytes_done` moves inside a large file. */
const COPY_PIECE_BYTES = 1024 * 1024;
/** A file whose size reads 0 can still hold bytes, as files in `/proc` do. */
const SMALL_PIECE_BYTES = 4096;
/** The bits a copy takes from its source. setuid, setgid and sticky are left off. */
const PERMISSION_BITS = 0o777n;
/** `keep_both` stops looking for a free name after this many. */
export const MAX_KEEP_BOTH_NUMBER = 1000;
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
export const MESSAGE_REPLACE_ITSELF = "An item cannot replace itself.";
const MESSAGE_REPLACE_HOLDER = "An item cannot replace a folder that holds it.";
const MESSAGE_PROTECTED_UNREAD = "The protected folders could not be read in time.";
const MESSAGE_SPECIAL_SELECTED = "This is a socket, pipe or device file. Pinggy cannot copy it.";
const MESSAGE_REPLACE_MOUNT = "This item is a mounted disk. Pinggy does not replace it.";
const MESSAGE_COPY_FAILED = "The item could not be copied.";
const MESSAGE_COPY_IN_PLACE = "The copy is in place. The old one stays as";
/** Why a removal left an item behind, after a message that names it. */
export const REASON_MOUNT_INSIDE = "a disk is mounted inside it.";

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

/** What an item in 1 folder is checked against before it is removed or replaced: `delete`'s rules. */
export interface RemovalGuard {
    protectedSet: ProtectedSet;
    /** Every item is protected: the folder is the config folder or inside it. */
    insideConfigFolder: boolean;
    /** Every item is an account's home: the folder is the accounts folder. */
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
    replaceGuard: RemovalGuard | null;
}

/** A copy's `progress`, with the byte count it always carries. */
export type CopyProgress = FileProgress & { bytes_done: number };

/** The walk's shared state for 1 name. */
export interface CopyWalk {
    copier: FileSystemCopier;
    paths: path.PlatformPath;
    platform: NodeJS.Platform;
    progress: CopyProgress;
    /** Sockets, named pipes and device files met inside the name and left out. */
    specialFilesLeftOut: number;
}

/** The name the request asked for is taken. `on_conflict` decides what follows. */
export class TakenError extends Error {}

/** A refusal of the whole request, thrown out of the checks. */
export class RequestRefusal extends Error {
    constructor(readonly refusal: FileError) {
        super(refusal.error.message);
    }
}

/** Why 1 name failed, as 1 entry of `failed`. */
export type NameFailure = FileOperationFailure["error"];

export const SKIPPED = "skipped";
/** Done: null. Left alone by `skip`: {@link SKIPPED}. Else the failure. */
export type NameOutcome = typeof SKIPPED | NameFailure | null;

/** What {@link countEntry} adds up. */
export interface CountTotals {
    files: number;
    bytes: number;
    /** Sockets, named pipes and device files met, left out of `files`. */
    specialFiles: number;
    /** Folders on another device than the one the count stops at. */
    mountedDisks: number;
}

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
        return refusalOf(err);
    }
}

/** What the checks threw, as the answer: a {@link RequestRefusal} as it is, a failed read as 1. */
export function refusalOf(err: unknown): FileError {
    if (err instanceof RequestRefusal) {
        return err.refusal;
    }
    const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
    return fileError(code, failureMessage(err, MESSAGE_FOLDER_UNREADABLE));
}

async function checkedCopy(request: FileCopyRequest, dependencies: CopyDependencies,
                           maxPayloadBytes: number): Promise<PreparedCopy> {
    const { copier, platform } = dependencies;
    checkNames(request, platform);
    const paths = pathsFor(platform);
    const { sourceDirectory, destinationDirectory } = resolvedFolders(request, paths);
    await folderStats(sourceDirectory, copier);
    const destinationStats = await folderStats(destinationDirectory, copier);

    const onConflict = request.on_conflict ?? ON_CONFLICT_FAIL;
    const targetNames = request.new_name === undefined ? request.names : [request.new_name];
    const sources = await Promise.all(request.names.map((name) =>
        lstatOrNull(paths.join(sourceDirectory, name), copier)));
    await refuseIntoItself(sources, destinationDirectory, dependencies, MESSAGE_INTO_ITSELF);

    if (onConflict === ON_CONFLICT_FAIL || onConflict === ON_CONFLICT_REPLACE) {
        const targets = await Promise.all(targetNames.map((name) =>
            lstatOrNull(paths.join(destinationDirectory, name), copier)));
        if (onConflict === ON_CONFLICT_REPLACE && targets.some((target, index) =>
            target !== null && sources[index] !== null && identityOf(target) === identityOf(sources[index]!))) {
            throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_ITSELF));
        }
        if (onConflict === ON_CONFLICT_REPLACE) {
            await refuseReplacingAHolder(targets, sourceDirectory, dependencies);
        }
        const conflicts = request.names.filter((_name, index) => targets[index] !== null);
        if (onConflict === ON_CONFLICT_FAIL && conflicts.length > 0) {
            throw new RequestRefusal(conflictRefusal(conflicts, maxPayloadBytes));
        }
    }

    const replaceGuard = onConflict === ON_CONFLICT_REPLACE
        ? await removalGuard(destinationDirectory, destinationStats, await readProtectedFolders(dependencies),
            dependencies)
        : null;
    return {
        sourceDirectory, destinationDirectory, names: request.names, newName: request.new_name, onConflict,
        destinationDevice: destinationStats.dev, replaceGuard,
    };
}

/** `names` by `delete`'s rule, then `new_name` by `mkdir`'s, with Windows' rules on Windows. */
export function checkNames(request: FileCopyRequest, platform: NodeJS.Platform): void {
    const namesIssue = namesProblem(request.names, platform);
    if (namesIssue) {
        throw new RequestRefusal(fileError(ERROR_INVALID_PAYLOAD, namesIssue));
    }
    if (request.new_name === undefined) {
        return;
    }
    if (request.names.length !== 1) {
        throw new RequestRefusal(fileError(ERROR_INVALID_PAYLOAD, MESSAGE_NEW_NAME_NEEDS_1));
    }
    const newNameIssue = nameProblem(request.new_name, platform);
    if (newNameIssue) {
        throw new RequestRefusal(fileError(ERROR_INVALID_PAYLOAD, newNameIssue));
    }
    const windowsIssue = platform === "win32" ? windowsNameProblem(request.new_name, "A name") : null;
    if (windowsIssue) {
        throw new RequestRefusal(fileError(ERROR_INVALID_NAME, windowsIssue));
    }
}

/** Both folders, checked by `delete`'s path rule, then resolved. */
export function resolvedFolders(request: FileCopyRequest, paths: path.PlatformPath):
    { sourceDirectory: string; destinationDirectory: string } {
    for (const folder of [request.source_directory, request.destination_directory]) {
        const issue = pathProblem(folder, paths);
        if (issue) {
            throw new RequestRefusal(fileError(ERROR_INVALID_PATH, issue));
        }
    }
    return {
        sourceDirectory: paths.resolve(request.source_directory),
        destinationDirectory: paths.resolve(request.destination_directory),
    };
}

/** `stat` of a folder the request names. Refuses a folder that is gone, unreadable or a file. */
export async function folderStats(folder: string, copier: FileSystemCopier): Promise<fs.BigIntStats> {
    let stats: fs.BigIntStats;
    try {
        stats = await copier.stat(folder);
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        throw new RequestRefusal(folderFailure(err));
    }
    if (!stats.isDirectory()) {
        throw new RequestRefusal(fileError(ERROR_NOT_A_DIRECTORY, MESSAGE_NOT_A_FOLDER));
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
export async function refuseIntoItself(sources: Array<fs.BigIntStats | null>, destinationDirectory: string,
                                       dependencies: CopyDependencies, message: string): Promise<void> {
    if (await anyFolderHolds(sources, destinationDirectory, dependencies)) {
        throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, message));
    }
}

/**
 * A `replace` target that is the source folder or a folder above it. The swap would delete the old target, and
 * with it the source: a copy never removes what it copies. A target that is a link is replaced as a link, and
 * the folder it leads to stays, so `lstat`'s identity is the one matched.
 */
export async function refuseReplacingAHolder(targets: Array<fs.BigIntStats | null>, sourceDirectory: string,
                                             dependencies: CopyDependencies): Promise<void> {
    if (await anyFolderHolds(targets, sourceDirectory, dependencies)) {
        throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_HOLDER));
    }
}

/**
 * True when 1 of the folders among `candidates` is `folder` or a folder above it. `folder`'s real path is read
 * first, so a link on the way is followed, and each folder above it is matched by `(dev, ino)`.
 */
async function anyFolderHolds(candidates: Array<fs.BigIntStats | null>, folder: string,
                              dependencies: CopyDependencies): Promise<boolean> {
    const folders = candidates.filter((stats): stats is fs.BigIntStats => stats !== null && stats.isDirectory());
    if (folders.length === 0) {
        return false;
    }
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const realFolder = await copier.realpath(folder);
    const chain = new Set(await Promise.all(selfAndAncestors(realFolder, paths).map((each) =>
        identityOrNull(copier.stat(each)))));
    return folders.some((stats) => chain.has(identityOf(stats)));
}

/** `file_exists` with the taken names as the request sent them: the first 20 that fit the frame. */
export function conflictRefusal(conflicts: string[], maxPayloadBytes: number): FileError {
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

/** `delete`'s protected folders, read for this request. */
export async function readProtectedFolders(dependencies: CopyDependencies): Promise<ProtectedSet> {
    const { remover, callTimeoutMillis, protectedSources } = dependencies;
    try {
        return await readProtectedSet(protectedSources, pathsFor(dependencies.platform), remover, callTimeoutMillis);
    } catch (err) {
        throw protectedUnread(err);
    }
}

/** What each item in `folder`, whose `stat` is `stats`, is checked against before it is removed or replaced. */
export async function removalGuard(folder: string, stats: fs.BigIntStats, protectedSet: ProtectedSet,
                                   dependencies: CopyDependencies): Promise<RemovalGuard> {
    const { remover, callTimeoutMillis } = dependencies;
    try {
        const insideConfigFolder = await isInsideConfigFolder(folder, protectedSet, pathsFor(dependencies.platform),
            remover, callTimeoutMillis);
        const inAccountsFolder = protectedSet.accountsFolder !== null
            && identityOf(stats) === protectedSet.accountsFolder;
        return { protectedSet, insideConfigFolder, inAccountsFolder };
    } catch (err) {
        throw protectedUnread(err);
    }
}

/** A read that timed out. Without every protected folder read, nothing is safe to remove or replace. */
function protectedUnread(err: unknown): RequestRefusal {
    const code = err instanceof FileCallTimeoutError ? ERROR_FILE_TIMEOUT : ERROR_FILE_OPERATION_FAILED;
    return new RequestRefusal(fileError(code, failureMessage(err, MESSAGE_PROTECTED_UNREAD)));
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
    const noSpace = await noSpaceRefusal(totals.bytes, prepared.destinationDirectory, dependencies.copier);
    if (noSpace) {
        return noSpace;
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

/** `no_space` when `neededBytes` is more than the destination disk's free bytes. A disk that cannot say passes. */
export async function noSpaceRefusal(neededBytes: number, destinationDirectory: string,
                                     copier: FileSystemCopier): Promise<FileError | null> {
    const freeBytes = await copier.freeBytes(destinationDirectory).catch(() => null);
    if (freeBytes === null || BigInt(neededBytes) <= freeBytes) {
        return null;
    }
    return fileError(ERROR_NO_SPACE, `The copy needs ${formatBytes(neededBytes)}. `
        + `The destination disk has ${formatBytes(freeBytes)} free.`);
}

/**
 * Files, folders and links in every name, and the bytes of the files. An entry that cannot be read is left out:
 * the copy meets it again and fails there. Under `skip`, a name whose target is taken now is left out too.
 */
async function countNames(prepared: PreparedCopy, dependencies: CopyDependencies):
    Promise<CountTotals> {
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const totals = newCountTotals();
    for (const name of prepared.names) {
        const target = paths.join(prepared.destinationDirectory, prepared.newName ?? name);
        if (prepared.onConflict === ON_CONFLICT_SKIP && await lstatOrNull(target, copier).catch(() => null)) {
            continue;
        }
        await countEntry(paths.join(prepared.sourceDirectory, name), totals, copier, paths, null);
    }
    return totals;
}

export function newCountTotals(): CountTotals {
    return { files: 0, bytes: 0, specialFiles: 0, mountedDisks: 0 };
}

/**
 * Adds `entry` and what it holds to `totals`. A folder on another device than `stopAtDevice` is counted as a
 * mounted disk and not read. With null, the count goes on into it, as a copy does.
 */
export async function countEntry(entry: string, totals: CountTotals, copier: FileSystemCopier,
                                 paths: path.PlatformPath, stopAtDevice: bigint | null): Promise<void> {
    let stats: fs.BigIntStats;
    try {
        stats = await copier.lstat(entry);
    } catch {
        return;
    }
    if (isSpecial(stats)) {
        totals.specialFiles += 1;
        return;
    }
    if (stats.isDirectory() && stopAtDevice !== null && stats.dev !== stopAtDevice) {
        totals.mountedDisks += 1;
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
        await countEntry(paths.join(entry, child), totals, copier, paths, stopAtDevice);
    }
}

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
        return copyFailure(err, MESSAGE_COPY_FAILED);
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
    const refusal = replaceRefusal(existing, stats, prepared.destinationDevice, guard);
    if (refusal) {
        return refusal;
    }

    const suffix = dependencies.hiddenNameSuffix();
    const hiddenCopy = paths.join(prepared.destinationDirectory, hiddenName(targetName, HIDDEN_COPY_MARK, suffix));
    try {
        await copyEntry(source, stats, hiddenCopy, walk, true);
    } catch (err) {
        if (!(err instanceof TakenError)) {
            await removeQuietly(hiddenCopy, guard.protectedSet, dependencies);
        }
        throw err;
    }
    let oldName: string | null;
    try {
        oldName = await swapIn(hiddenCopy, prepared.destinationDirectory, targetName, existing, stats.isDirectory(),
            suffix, copier, paths);
    } catch (err) {
        await removeQuietly(hiddenCopy, guard.protectedSet, dependencies);
        throw err;
    }
    if (oldName === null) {
        return null;
    }
    return removeOld(paths.join(prepared.destinationDirectory, oldName), oldName, existing, guard.protectedSet,
        dependencies, MESSAGE_COPY_IN_PLACE);
}

/**
 * Puts `incoming` at `targetName` in `folder`, in place of `existing`. A file or a link over a file or a link takes
 * 1 rename, which replaces it. Anything with a folder takes 2: the old one to a hidden name, then `incoming` into
 * place. Returns that hidden name, or null after 1 rename. A failure puts the old one back and is thrown.
 */
export async function swapIn(incoming: string, folder: string, targetName: string, existing: fs.BigIntStats,
                             incomingIsFolder: boolean, suffix: string, copier: FileSystemCopier,
                             paths: path.PlatformPath): Promise<string | null> {
    const target = paths.join(folder, targetName);
    if (!existing.isDirectory() && !incomingIsFolder) {
        await copier.rename(incoming, target);
        return null;
    }
    const oldName = hiddenName(targetName, HIDDEN_OLD_MARK, suffix);
    const hiddenOld = paths.join(folder, oldName);
    await copier.rename(target, hiddenOld);
    try {
        await copier.rename(incoming, target);
    } catch (err) {
        await copier.rename(hiddenOld, target).catch(() => undefined);
        throw err;
    }
    return oldName;
}

/** A target `delete` would refuse, or the source itself. */
export function replaceRefusal(existing: fs.BigIntStats, source: fs.BigIntStats, destinationDevice: bigint,
                               guard: RemovalGuard): NameFailure | null {
    if (identityOf(existing) === identityOf(source)) {
        return { code: ERROR_INVALID_DESTINATION, message: MESSAGE_REPLACE_ITSELF };
    }
    return protectedRefusal(existing, destinationDevice, guard, MESSAGE_REPLACE_MOUNT);
}

/**
 * An item `delete` would not remove: in the config folder or the accounts folder, protected by its identity, or a
 * mounted disk, which sits on another device than `folderDevice`, the folder it is in.
 */
export function protectedRefusal(stats: fs.BigIntStats, folderDevice: bigint, guard: RemovalGuard,
                                 mountMessage: string): NameFailure | null {
    if (guard.insideConfigFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_PINGGY_FOLDER };
    }
    if (guard.inAccountsFolder) {
        return { code: ERROR_PROTECTED_PATH, message: MESSAGE_ACCOUNT_FOLDER };
    }
    const reason = guard.protectedSet.reasons.get(identityOf(stats));
    if (reason) {
        return { code: ERROR_PROTECTED_PATH, message: reason };
    }
    if (stats.dev !== folderDevice) {
        return { code: ERROR_MOUNT_POINT, message: mountMessage };
    }
    return null;
}

/**
 * Removes the old item once the new one is in its place. A failure leaves it under its hidden name, and says so
 * after `inPlaceMessage`.
 */
export async function removeOld(hiddenOld: string, oldName: string, existing: fs.BigIntStats,
                                protectedSet: ProtectedSet, dependencies: CopyDependencies,
                                inPlaceMessage: string): Promise<NameFailure | null> {
    try {
        if (await removeTree(hiddenOld, existing, protectedSet, deleteDependencies(dependencies))) {
            return null;
        }
        return { code: ERROR_MOUNT_POINT, message: `${inPlaceMessage} ${oldName}: ${REASON_MOUNT_INSIDE}` };
    } catch (err) {
        const failure = deleteFailure(err);
        const message = sanitizeErrorMessage(`${inPlaceMessage} ${oldName}: ${failure.message}`) ?? failure.message;
        return { code: failure.code, message };
    }
}

/** A hidden copy this request made, removed after its copy or its swap failed. A failure here leaves it. */
export async function removeQuietly(entry: string, protectedSet: ProtectedSet,
                                    dependencies: CopyDependencies): Promise<void> {
    try {
        const stats = await dependencies.remover.lstat(entry);
        await removeTree(entry, stats, protectedSet, deleteDependencies(dependencies));
    } catch {
        // Already gone, or the drive stopped answering: the hidden copy stays, as after an agent stop.
    }
}

export function deleteDependencies(dependencies: CopyDependencies): DeleteDependencies {
    const { remover, platform, protectedSources, callTimeoutMillis } = dependencies;
    return { remover, platform, protectedSources, callTimeoutMillis };
}

/**
 * Makes `target` as a copy of `source`, whose `lstat` is `stats`. `top` marks the name itself: its target
 * taken throws a {@link TakenError}, which `on_conflict` reads. Taken inside a folder, it is an error.
 */
export async function copyEntry(source: string, stats: fs.BigIntStats, target: string, walk: CopyWalk,
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
export function hiddenName(targetName: string, mark: string, suffix: string): string {
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
export function isSpecial(stats: fs.BigIntStats): boolean {
    return !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink();
}

function specialFilesLeftOut(count: number): NameFailure {
    const message = count === 1
        ? "1 socket, pipe or device file inside was left out."
        : `${count} sockets, pipes or device files inside were left out.`;
    return { code: ERROR_SPECIAL_FILE, message };
}

/** `lstat`, or null when it fails. A timeout is thrown: a check that could not run must not pass. */
export async function lstatOrNull(target: string, copier: FileSystemCopier): Promise<fs.BigIntStats | null> {
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

/** A failed copy, as 1 entry of `failed`. `fallbackMessage` stands in for an error with no message. */
export function copyFailure(err: unknown, fallbackMessage: string): NameFailure {
    if (err instanceof TakenError) {
        return { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN };
    }
    if (err instanceof FileCallTimeoutError) {
        return { code: ERROR_FILE_TIMEOUT, message: err.message };
    }
    const message = failureMessage(err, fallbackMessage);
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
