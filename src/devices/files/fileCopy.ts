import crypto from "crypto";
import fs from "fs";
import path from "path";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import {
    ERROR_FILE_EXISTS, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_DESTINATION, ERROR_INVALID_NAME,
    ERROR_INVALID_PATH, ERROR_INVALID_PAYLOAD, ERROR_MOUNT_POINT, ERROR_NOT_A_DIRECTORY, ERROR_NO_SPACE,
    ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, ERROR_PROTECTED_PATH, ERROR_SPECIAL_FILE, FileCopyRequest,
    FileCopyResult, FileError, FileFailure, FileOnConflict, FileProgress, MAX_NAME_BYTES, ON_CONFLICT_FAIL,
    ON_CONFLICT_KEEP_BOTH, ON_CONFLICT_REPLACE, ON_CONFLICT_SKIP, fileError,
} from "./file_schema.js";
import { DeleteDependencies, deleteFailure, removeTree } from "./fileDelete.js";
import {
    MESSAGE_ACCOUNT_FOLDER, MESSAGE_PINGGY_FOLDER, ProtectedSet, ProtectedSources, identityOf, isInsideConfigFolder,
    readProtectedSet, selfAndAncestors,
} from "./fileProtectedPaths.js";
import {
    FileCallTimeoutError, FileSystemCopier, FileSystemRemover, LinkType, MESSAGE_NAME_TAKEN, ResolvedItem,
    errorCodeOf, failureMessage, isRoot, nameProblem, pathProblem, pathsFor, resolvedItem, windowsNameProblem,
} from "./fileSystem.js";

/**
 * `file/copy`: 1 file or folder at `source_path`, copied to `destination_path` on the same device. A folder copies
 * whole. The folder `destination_path` is in must exist, and the last part of `destination_path` is the copy's name.
 *
 * 2 steps, so the handler sends the first `progress` only once the copy runs. `prepareCopy` checks the request: a
 * root as either path, a folder into itself, a target already taken under `on_conflict: fail`, and for `replace` a
 * target that is the source or holds it, and the protected folders. A refusal there has copied nothing. `runCopy`
 * counts what the item holds, refuses with `no_space` when the destination disk lacks the room, then copies it. The
 * first error ends the copy: the files it finished stay, and the file it was writing is removed.
 *
 * The into-itself check gets the folder the copy lands in, never the copy's own path: a folder counts as holding
 * itself, so a folder copied onto its own path is a taken target, which `keep_both` copies as `web (1)`.
 *
 * A walk written by hand, not `fs.cp`: each of its calls goes through the handler's gate with a time limit, a
 * file copies in pieces so a large one reports bytes and a dead drive fails within the limit, and every entry
 * is made only if its name is free, so nothing is overwritten.
 *
 * What a copy keeps: the permission bits less setuid, setgid and sticky, and the access and modified times,
 * each set once the entry's contents are in, and skipped where the disk cannot store them. The owner is the
 * agent's user. A link is copied as a link with the same text. A disk mounted inside a folder is copied too.
 * A socket, a named pipe or a device file is left out, and the copy then fails `special_file`.
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

const MESSAGE_FOLDER_UNREADABLE = "The folder could not be read.";
const MESSAGE_NOT_A_FOLDER = "The path is not a folder.";
const MESSAGE_ROOT = "A drive or filesystem root cannot be copied or moved.";
const MESSAGE_INTO_ITSELF = "A folder cannot be copied into itself.";
export const MESSAGE_REPLACE_ITSELF = "An item cannot replace itself.";
const MESSAGE_REPLACE_HOLDER = "An item cannot replace a folder that holds it.";
/** `fail`, the default, finds the target taken before anything is copied or moved. */
const MESSAGE_TARGET_TAKEN = "1 item already exists in the destination.";
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
    /** For `replace`: the protected folders, and the old item removed as a delete removes its item. */
    remover: FileSystemRemover;
    /** Picks the path rules, and the Windows rules for the target's name. */
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
    /** The item is protected: the folder is the config folder or inside it. */
    insideConfigFolder: boolean;
    /** The item is an account's home: the folder is the accounts folder. */
    inAccountsFolder: boolean;
}

/** A request that passed every check. */
export interface PreparedCopy {
    /** The item to copy, resolved. */
    source: string;
    /** The source's `lstat`: a link is copied as itself. */
    sourceStats: fs.BigIntStats;
    /** The source's own name, for `progress`. */
    sourceName: string;
    /** The folder the copy lands in, resolved. */
    destinationDirectory: string;
    /** The copy's name in it: the last part of `destination_path`. */
    targetName: string;
    onConflict: FileOnConflict;
    /** A `replace` target on another device is a mounted disk. */
    destinationDevice: bigint;
    /** `replace` only. */
    replaceGuard: RemovalGuard | null;
}

/** A copy's `progress`, with the byte count it always carries. */
export type CopyProgress = FileProgress & { bytes_done: number };

/** The walk's shared state for 1 item. */
export interface CopyWalk {
    copier: FileSystemCopier;
    paths: path.PlatformPath;
    platform: NodeJS.Platform;
    progress: CopyProgress;
    /** Sockets, named pipes and device files met inside the item and left out. */
    specialFilesLeftOut: number;
}

/** The target the request asked for is taken. `on_conflict` decides what follows. */
export class TakenError extends Error {}

/** A refusal of the request, thrown out of the checks. */
export class RequestRefusal extends Error {
    constructor(readonly refusal: FileError) {
        super(refusal.error.message);
    }
}

/** Why the item failed once the copy or the move ran. */
export type ItemFailure = FileFailure;

export const SKIPPED = "skipped";
/** Done: null. Left alone by `skip`: {@link SKIPPED}. Else the failure. */
export type ItemOutcome = typeof SKIPPED | ItemFailure | null;

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
 */
export async function prepareCopy(request: FileCopyRequest, dependencies: CopyDependencies):
    Promise<PreparedCopy | FileError> {
    try {
        return await checkedCopy(request, dependencies);
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

async function checkedCopy(request: FileCopyRequest, dependencies: CopyDependencies): Promise<PreparedCopy> {
    const { copier, platform } = dependencies;
    const paths = pathsFor(platform);
    const { source, destination } = resolvedItems(request, paths);
    checkTargetName(destination.name, platform);
    const sourceStats = await sourceItemStats(source.path, copier, MESSAGE_COPY_FAILED);
    if (isSpecial(sourceStats)) {
        throw new RequestRefusal(fileError(ERROR_SPECIAL_FILE, MESSAGE_SPECIAL_SELECTED));
    }
    const destinationStats = await folderStats(destination.parent, copier);
    await refuseIntoItself(sourceStats, destination.parent, dependencies, MESSAGE_INTO_ITSELF);

    const onConflict = request.on_conflict ?? ON_CONFLICT_FAIL;
    if (onConflict === ON_CONFLICT_FAIL || onConflict === ON_CONFLICT_REPLACE) {
        const target = await lstatOrNull(destination.path, copier);
        if (onConflict === ON_CONFLICT_FAIL && target !== null) {
            throw new RequestRefusal(targetTakenRefusal());
        }
        if (onConflict === ON_CONFLICT_REPLACE && target !== null && identityOf(target) === identityOf(sourceStats)) {
            throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_ITSELF));
        }
        if (onConflict === ON_CONFLICT_REPLACE) {
            await refuseReplacingAHolder(target, source.parent, dependencies);
        }
    }

    const replaceGuard = onConflict === ON_CONFLICT_REPLACE
        ? await removalGuard(destination.parent, destinationStats, await readProtectedFolders(dependencies),
            dependencies)
        : null;
    return {
        source: source.path, sourceStats, sourceName: source.name, destinationDirectory: destination.parent,
        targetName: destination.name, onConflict, destinationDevice: destinationStats.dev, replaceGuard,
    };
}

/**
 * Both paths, checked by `delete`'s path rule, resolved and split. A root as either one is refused: it has no name
 * to copy or move it under, and none to give the copy.
 */
export function resolvedItems(request: FileCopyRequest, paths: path.PlatformPath):
    { source: ResolvedItem; destination: ResolvedItem } {
    for (const requested of [request.source_path, request.destination_path]) {
        const issue = pathProblem(requested, paths);
        if (issue) {
            throw new RequestRefusal(fileError(ERROR_INVALID_PATH, issue));
        }
    }
    const source = resolvedItem(request.source_path, paths);
    const destination = resolvedItem(request.destination_path, paths);
    if (isRoot(source.path, paths) || isRoot(destination.path, paths)) {
        throw new RequestRefusal(fileError(ERROR_INVALID_PATH, MESSAGE_ROOT));
    }
    return { source, destination };
}

/** The target's name by {@link nameProblem}, with Windows' rules on Windows. */
export function checkTargetName(targetName: string, platform: NodeJS.Platform): void {
    const nameIssue = nameProblem(targetName, platform);
    if (nameIssue) {
        throw new RequestRefusal(fileError(ERROR_INVALID_PAYLOAD, nameIssue));
    }
    const windowsIssue = platform === "win32" ? windowsNameProblem(targetName, "A name") : null;
    if (windowsIssue) {
        throw new RequestRefusal(fileError(ERROR_INVALID_NAME, windowsIssue));
    }
}

/** The source's `lstat`. A source that is gone or cannot be read refuses the request, by {@link copyFailure}. */
export async function sourceItemStats(source: string, copier: FileSystemCopier,
                                      fallbackMessage: string): Promise<fs.BigIntStats> {
    try {
        return await copier.lstat(source);
    } catch (err) {
        throw new RequestRefusal({ error: copyFailure(err, fallbackMessage) });
    }
}

/** `stat` of a folder the request lands in or leaves. Refuses a folder that is gone, unreadable or a file. */
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
 * A source folder that is `destinationDirectory`, the folder its copy lands in, or a folder above it. The
 * destination's real path is read first, so a link that leads inside the folder is caught, and each folder above it
 * is matched by `(dev, ino)`.
 */
export async function refuseIntoItself(source: fs.BigIntStats, destinationDirectory: string,
                                       dependencies: CopyDependencies, message: string): Promise<void> {
    if (await folderHolds(source, destinationDirectory, dependencies)) {
        throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, message));
    }
}

/**
 * A `replace` target that is `sourceDirectory`, the folder the source is in, or a folder above it. The swap would
 * delete the old target, and with it the source: a copy never removes what it copies. A target that is a link is
 * replaced as a link, and the folder it leads to stays, so `lstat`'s identity is the one matched.
 */
export async function refuseReplacingAHolder(target: fs.BigIntStats | null, sourceDirectory: string,
                                             dependencies: CopyDependencies): Promise<void> {
    if (await folderHolds(target, sourceDirectory, dependencies)) {
        throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_HOLDER));
    }
}

/**
 * True when `candidate` is a folder, and is `folder` or a folder above it. `folder`'s real path is read first, so a
 * link on the way is followed, and each folder above it is matched by `(dev, ino)`.
 */
async function folderHolds(candidate: fs.BigIntStats | null, folder: string,
                           dependencies: CopyDependencies): Promise<boolean> {
    if (candidate === null || !candidate.isDirectory()) {
        return false;
    }
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const realFolder = await copier.realpath(folder);
    const chain = new Set(await Promise.all(selfAndAncestors(realFolder, paths).map((each) =>
        identityOrNull(copier.stat(each)))));
    return chain.has(identityOf(candidate));
}

/** `file_exists` under `fail`, before anything is copied or moved. */
export function targetTakenRefusal(): FileError {
    return fileError(ERROR_FILE_EXISTS, MESSAGE_TARGET_TAKEN);
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

/** What an item in `folder`, whose `stat` is `stats`, is checked against before it is removed or replaced. */
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
 * Counts what the item holds, checks the destination's free space, then copies it, counting into `progress` as it
 * goes. Never throws: every failure is the error answer.
 */
export async function runCopy(prepared: PreparedCopy, progress: FileProgress,
                              dependencies: CopyDependencies): Promise<FileCopyResult> {
    const counted: CopyProgress = Object.assign(progress, { bytes_done: progress.bytes_done ?? 0 });
    const totals = await countSource(prepared, dependencies);
    counted.files_total = totals.files;
    counted.bytes_total = totals.bytes;
    const noSpace = await noSpaceRefusal(totals.bytes, prepared.destinationDirectory, dependencies.copier);
    if (noSpace) {
        return noSpace;
    }
    const walk: CopyWalk = {
        copier: dependencies.copier, paths: pathsFor(dependencies.platform), platform: dependencies.platform,
        progress: counted, specialFilesLeftOut: 0,
    };
    const outcome = await copyItem(prepared, walk, dependencies);
    counted.items_done += 1;
    return outcomeAnswer(outcome);
}

/** `{}` when done, `{ skipped: true }` when `skip` left a taken target alone, else the failure as the error. */
export function outcomeAnswer(outcome: ItemOutcome): FileCopyResult {
    if (outcome === SKIPPED) {
        return { skipped: true };
    }
    return outcome === null ? {} : { error: outcome };
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
 * Files, folders and links in the item, and the bytes of the files. An entry that cannot be read is left out: the
 * copy meets it again and fails there. Under `skip`, a target taken now counts nothing: the item is left alone.
 */
async function countSource(prepared: PreparedCopy, dependencies: CopyDependencies): Promise<CountTotals> {
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const totals = newCountTotals();
    const target = paths.join(prepared.destinationDirectory, prepared.targetName);
    if (prepared.onConflict === ON_CONFLICT_SKIP && await lstatOrNull(target, copier).catch(() => null)) {
        return totals;
    }
    await countEntry(prepared.source, totals, copier, paths, null);
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

/** Copies the item to its target, as `on_conflict` says. */
async function copyItem(prepared: PreparedCopy, walk: CopyWalk, dependencies: CopyDependencies):
    Promise<ItemOutcome> {
    try {
        if (prepared.onConflict === ON_CONFLICT_REPLACE) {
            const refusal = await replaceTarget(prepared, walk, dependencies);
            if (refusal) {
                return refusal;
            }
        } else if (await copyToFreeName(prepared.source, prepared.sourceStats, prepared.targetName, prepared,
            walk) === SKIPPED) {
            return SKIPPED;
        }
    } catch (err) {
        return copyFailure(err, MESSAGE_COPY_FAILED);
    }
    return walk.specialFilesLeftOut > 0 ? specialFilesLeftOut(walk.specialFilesLeftOut) : null;
}

/**
 * Copies to the target name, or, when it is taken, as `on_conflict` says: `skip` leaves it, `keep_both` tries
 * `name (1).ext`, `name (2).ext` and so on, and `fail` fails the copy with `file_exists`.
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
async function replaceTarget(prepared: PreparedCopy, walk: CopyWalk,
                             dependencies: CopyDependencies): Promise<ItemFailure | null> {
    const { copier, paths } = walk;
    const { source, sourceStats: stats, targetName } = prepared;
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
                               guard: RemovalGuard): ItemFailure | null {
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
                                 mountMessage: string): ItemFailure | null {
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
                                inPlaceMessage: string): Promise<ItemFailure | null> {
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
 * Makes `target` as a copy of `source`, whose `lstat` is `stats`. `top` marks the item itself: its target
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

/** `making`, with a taken name turned into a {@link TakenError} when it is the item itself. */
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

function specialFilesLeftOut(count: number): ItemFailure {
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

/** A failed copy, as the error answer. `fallbackMessage` stands in for an error with no message. */
export function copyFailure(err: unknown, fallbackMessage: string): ItemFailure {
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
