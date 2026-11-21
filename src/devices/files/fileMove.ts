import fs from "fs";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import {
    ERROR_FILE_EXISTS, ERROR_INVALID_DESTINATION, ERROR_INVALID_PATH, ERROR_MOUNT_POINT, ERROR_PERMISSION_DENIED,
    ERROR_SPECIAL_FILE, FileCopyRequest, FileCopyResult, FileError, FileOnConflict, FileOperationFailure,
    FileProgress, ON_CONFLICT_FAIL, ON_CONFLICT_KEEP_BOTH, ON_CONFLICT_REPLACE, ON_CONFLICT_SKIP, fileError,
} from "./file_schema.js";
import {
    CopyDependencies, CopyProgress, CopyWalk, CountTotals, MAX_KEEP_BOTH_NUMBER, MESSAGE_REPLACE_ITSELF, NameFailure,
    NameOutcome, REASON_MOUNT_INSIDE, RemovalGuard, RequestRefusal, SKIPPED, TakenError, checkNames, conflictRefusal,
    copyEntry, copyFailure, countEntry, deleteDependencies, folderStats, hiddenName, isSpecial, keepBothName,
    lstatOrNull, newCountTotals, noSpaceRefusal, protectedRefusal, readProtectedFolders, refusalOf, refuseIntoItself,
    refuseReplacingAHolder, removalGuard, removeOld, removeQuietly, replaceRefusal, resolvedFolders, swapIn,
} from "./fileCopy.js";
import { deleteFailure, operationAnswer, removeTree } from "./fileDelete.js";
import { ProtectedSet, identityOf } from "./fileProtectedPaths.js";
import { MESSAGE_NAME_TAKEN, errorCodeOf, failureMessage, pathProblem, pathsFor } from "./fileSystem.js";

/**
 * `file/move`: 1 or more names from 1 folder into another folder on the same device, or 1 name under `new_name`. A
 * rename is a move of 1 name into its own folder with `new_name`. The request, the answer, `progress` and
 * `on_conflict` are `copy`'s.
 *
 * 2 steps, as for `copy`. `prepareMove` runs `copy`'s checks, refuses a move into the folder the names are in, and
 * reads `delete`'s protected folders. A refusal there has moved nothing. `runMove` checks each name as `delete`
 * checks a name before it removes it, then moves each name in order. A failure ends that name only.
 *
 * On 1 disk a name moves in 1 `rename`, so it keeps everything: owner, permissions, links, and what a folder holds,
 * a socket or a mounted disk included. Node's `rename` replaces a file or an empty folder at its target with no
 * error, and has no switch to refuse. So each rename comes right after an `lstat` of its target: another program
 * would have to take that name in between.
 *
 * Across 2 disks `rename` cannot work. The names are counted first, as for `copy`, and a name that holds a mounted
 * disk or a socket, pipe or device file fails there: a copy cannot bring them, and `delete` would leave them behind.
 * Then `no_space`, then each name in order: copied by `copy`'s walk to a hidden name beside its target, put in place
 * with 1 rename once whole, and only then removed from where it was by `delete`'s walk. A copy that fails is
 * removed, so the original stays whole. A `rename` that answers `EXDEV` with both folders on 1 device, as across a
 * bind mount, takes this path for that name, with no space check.
 *
 * `replace` swaps as for `copy`: the old item to a hidden name, the moved one into place, the old one removed by
 * `delete`'s walk. Nothing here logs a path.
 */

const HIDDEN_MOVE_MARK = "move";

const MESSAGE_INTO_ITSELF = "A folder cannot be moved into itself.";
const MESSAGE_ALREADY_HERE = "The item is already in this folder.";
const MESSAGE_ALREADY_HERE_MANY = "The items are already in this folder.";
const MESSAGE_SELECTED_MOUNT = "This folder is a mounted disk. Open it to move what is inside.";
const MESSAGE_MOUNT_INSIDE = "Another disk is mounted inside. Pinggy does not move it to another disk.";
const MESSAGE_SPECIAL_SELECTED = "This is a socket, pipe or device file. Pinggy cannot move it to another disk.";
const MESSAGE_MOVED_IN_PLACE = "The item is in place. The old one stays as";
const MESSAGE_ORIGINAL_STAYS = "The item is in its new place. The original could not be fully removed:";
const MESSAGE_MOVE_FAILED = "The item could not be moved.";

/** A request that passed every check. */
export interface PreparedMove {
    sourceDirectory: string;
    destinationDirectory: string;
    names: string[];
    newName?: string;
    onConflict: FileOnConflict;
    /** A selected name on another device than its folder is a mounted disk. */
    sourceDevice: bigint;
    /** A `replace` target on another device than its folder is a mounted disk. */
    destinationDevice: bigint;
    /** Both folders are 1 folder, so a target in another letter case can be the source itself. */
    sameFolder: boolean;
    /** The 2 folders are on 2 devices: each name is copied, then removed. */
    acrossDisks: boolean;
    /** Each name is checked against it before it leaves `sourceDirectory`. */
    sourceGuard: RemovalGuard;
    /** `replace` only. */
    replaceGuard: RemovalGuard | null;
}

/** 1 name whose source passed `delete`'s checks. */
interface MoveItem {
    name: string;
    targetName: string;
    source: string;
    stats: fs.BigIntStats;
}

/** Where a name went. Placed, perhaps with the old item it replaced left behind, or not placed at all. */
type Placement =
    | { placed: true; oldStays: NameFailure | null }
    | { placed: false; outcome: typeof SKIPPED | NameFailure };

const PLACED: Placement = { placed: true, oldStays: null };

/**
 * Checks the request and reads what the move matches against. Never throws: every refusal is an error answer, and
 * none has moved anything.
 *
 * @param maxPayloadBytes the most a refusal's payload may take, so `conflicts` fits the frame
 */
export async function prepareMove(request: FileCopyRequest, dependencies: CopyDependencies,
                                  maxPayloadBytes: number): Promise<PreparedMove | FileError> {
    try {
        return await checkedMove(request, dependencies, maxPayloadBytes);
    } catch (err) {
        return refusalOf(err);
    }
}

async function checkedMove(request: FileCopyRequest, dependencies: CopyDependencies,
                           maxPayloadBytes: number): Promise<PreparedMove> {
    const { copier, platform } = dependencies;
    checkNames(request, platform);
    const paths = pathsFor(platform);
    const { sourceDirectory, destinationDirectory } = resolvedFolders(request, paths);
    const sourceStats = await folderStats(sourceDirectory, copier);
    const destinationStats = await folderStats(destinationDirectory, copier);
    const sameFolder = identityOf(sourceStats) === identityOf(destinationStats);

    const sources = await Promise.all(request.names.map((name) =>
        lstatOrNull(paths.join(sourceDirectory, name), copier)));
    await refuseIntoItself(sources, destinationDirectory, dependencies, MESSAGE_INTO_ITSELF);
    if (sameFolder && (request.new_name === undefined || request.new_name === request.names[0])) {
        const message = request.names.length === 1 ? MESSAGE_ALREADY_HERE : MESSAGE_ALREADY_HERE_MANY;
        throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, message));
    }

    const protectedSet = await readProtectedFolders(dependencies);
    const sourceGuard = await removalGuard(sourceDirectory, sourceStats, protectedSet, dependencies);
    const onConflict = request.on_conflict ?? ON_CONFLICT_FAIL;
    if (onConflict === ON_CONFLICT_FAIL || onConflict === ON_CONFLICT_REPLACE) {
        await checkTargets(request, onConflict, sources, sourceDirectory, destinationDirectory, sameFolder,
            dependencies, maxPayloadBytes);
    }
    const replaceGuard = onConflict === ON_CONFLICT_REPLACE
        ? await removalGuard(destinationDirectory, destinationStats, protectedSet, dependencies) : null;
    return {
        sourceDirectory, destinationDirectory, names: request.names, newName: request.new_name, onConflict,
        sourceDevice: sourceStats.dev, destinationDevice: destinationStats.dev, sameFolder,
        acrossDisks: sourceStats.dev !== destinationStats.dev, sourceGuard, replaceGuard,
    };
}

/**
 * `replace` onto the source itself or onto a folder that holds it, then every clash under `fail`. A case-only rename
 * is not a clash: its target is the source.
 */
async function checkTargets(request: FileCopyRequest, onConflict: FileOnConflict,
                            sources: Array<fs.BigIntStats | null>, sourceDirectory: string,
                            destinationDirectory: string, sameFolder: boolean, dependencies: CopyDependencies,
                            maxPayloadBytes: number): Promise<void> {
    const paths = pathsFor(dependencies.platform);
    const targetNames = request.new_name === undefined ? request.names : [request.new_name];
    const targets = await Promise.all(targetNames.map((name) =>
        lstatOrNull(paths.join(destinationDirectory, name), dependencies.copier)));
    const clashes = targets.map((target, index) => target !== null
        && !isCaseOnlyRename(sameFolder, request.names[index], targetNames[index], sources[index], target)
        ? target : null);
    if (onConflict === ON_CONFLICT_REPLACE) {
        if (clashes.some((target, index) => target !== null && sources[index] !== null
            && identityOf(target) === identityOf(sources[index]!))) {
            throw new RequestRefusal(fileError(ERROR_INVALID_DESTINATION, MESSAGE_REPLACE_ITSELF));
        }
        await refuseReplacingAHolder(clashes, sourceDirectory, dependencies);
        return;
    }
    const conflicts = request.names.filter((_name, index) => clashes[index] !== null);
    if (conflicts.length > 0) {
        throw new RequestRefusal(conflictRefusal(conflicts, maxPayloadBytes));
    }
}

/**
 * `Notes.txt` to `notes.txt` on a disk that ignores letter case: the target "exists", and is the source itself. A
 * hard link of the source under another name is a clash, so the 2 names must differ by case alone.
 */
function isCaseOnlyRename(sameFolder: boolean, name: string, targetName: string, source: fs.BigIntStats | null,
                          target: fs.BigIntStats): boolean {
    return sameFolder && source !== null && name !== targetName && foldedName(name) === foldedName(targetName)
        && identityOf(source) === identityOf(target);
}

/** How APFS and NTFS compare 2 names, near enough: Unicode composed, then lower case. */
function foldedName(name: string): string {
    return name.normalize("NFC").toLowerCase();
}

/** The first `progress`. On 1 disk there is nothing to count: 1 rename for each name, and no bytes. */
export function moveProgress(prepared: PreparedMove): FileProgress {
    const progress: FileProgress = {
        items_done: 0, items_total: prepared.names.length, files_done: 0, bytes_done: 0,
        current_name: prepared.names[0],
    };
    if (!prepared.acrossDisks) {
        progress.files_total = prepared.names.length;
        progress.bytes_total = 0;
    }
    return progress;
}

/**
 * Checks each name's source, counts across disks, then moves each name in order, counting into `progress` as it goes.
 * Never throws: a failure is 1 entry of `failed`, and the only refusal of the whole request is `no_space`, before
 * anything is moved.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function runMove(prepared: PreparedMove, progress: FileProgress, dependencies: CopyDependencies,
                              maxPayloadBytes: number): Promise<FileCopyResult> {
    const counted: CopyProgress = Object.assign(progress, { bytes_done: progress.bytes_done ?? 0 });
    const items = new Map<string, MoveItem>();
    const settled = new Map<string, NameOutcome>();
    for (const name of prepared.names) {
        const item = await checkedSource(name, prepared, dependencies);
        if ("stats" in item) {
            items.set(name, item);
        } else {
            settled.set(name, item);
        }
    }
    if (prepared.acrossDisks) {
        const noSpace = await countAcross(items, settled, prepared, counted, dependencies);
        if (noSpace) {
            return noSpace;
        }
    }

    let completedCount = 0;
    let skippedCount = 0;
    const failures: FileOperationFailure[] = [];
    for (const name of prepared.names) {
        counted.current_name = name;
        const item = items.get(name);
        const outcome = item === undefined ? settled.get(name)! : await moveItem(item, prepared, counted, dependencies);
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

/** The name's `lstat`, checked as `delete` checks a name before it removes it. */
async function checkedSource(name: string, prepared: PreparedMove,
                             dependencies: CopyDependencies): Promise<MoveItem | NameFailure> {
    const paths = pathsFor(dependencies.platform);
    const source = paths.join(prepared.sourceDirectory, name);
    const targetName = prepared.newName ?? name;
    const targetIssue = pathProblem(paths.join(prepared.destinationDirectory, targetName), paths);
    if (targetIssue) {
        return { code: ERROR_INVALID_PATH, message: targetIssue };
    }
    let stats: fs.BigIntStats;
    try {
        stats = await dependencies.copier.lstat(source);
    } catch (err) {
        return moveFailure(err);
    }
    const refusal = protectedRefusal(stats, prepared.sourceDevice, prepared.sourceGuard, MESSAGE_SELECTED_MOUNT);
    return refusal ?? { name, targetName, source, stats };
}

/**
 * Counts each name into the totals, as `copy` does, and fails a name with a mounted disk or a special file inside.
 * Under `skip`, a name whose target is taken is left out of the count. Then `no_space` when the rest does not fit.
 */
async function countAcross(items: Map<string, MoveItem>, settled: Map<string, NameOutcome>, prepared: PreparedMove,
                           progress: CopyProgress, dependencies: CopyDependencies): Promise<FileError | null> {
    const paths = pathsFor(dependencies.platform);
    let files = 0;
    let bytes = 0;
    for (const item of [...items.values()]) {
        const target = paths.join(prepared.destinationDirectory, item.targetName);
        if (prepared.onConflict === ON_CONFLICT_SKIP
            && await lstatOrNull(target, dependencies.copier).catch(() => null)) {
            continue;
        }
        const totals = await countItem(item, dependencies);
        const refusal = countRefusal(totals, item.stats);
        if (refusal) {
            items.delete(item.name);
            settled.set(item.name, refusal);
            continue;
        }
        files += totals.files;
        bytes += totals.bytes;
    }
    progress.files_total = files;
    progress.bytes_total = bytes;
    return noSpaceRefusal(bytes, prepared.destinationDirectory, dependencies.copier);
}

/** The count stops at another device: a mounted disk inside the name is not read. */
async function countItem(item: MoveItem, dependencies: CopyDependencies): Promise<CountTotals> {
    const totals = newCountTotals();
    await countEntry(item.source, totals, dependencies.copier, pathsFor(dependencies.platform), item.stats.dev);
    return totals;
}

/** What a copy to another disk could not bring along. */
function countRefusal(totals: CountTotals, stats: fs.BigIntStats): NameFailure | null {
    if (totals.mountedDisks > 0) {
        return { code: ERROR_MOUNT_POINT, message: MESSAGE_MOUNT_INSIDE };
    }
    if (isSpecial(stats)) {
        return { code: ERROR_SPECIAL_FILE, message: MESSAGE_SPECIAL_SELECTED };
    }
    return totals.specialFiles > 0 ? specialInside(totals.specialFiles) : null;
}

function specialInside(count: number): NameFailure {
    const message = count === 1
        ? "This folder holds 1 socket, pipe or device file, which cannot be moved to another disk."
        : `This folder holds ${count} sockets, pipes or device files, which cannot be moved to another disk.`;
    return { code: ERROR_SPECIAL_FILE, message };
}

/** On 1 disk, 1 rename. On 2 disks, or a rename that answers `EXDEV`, a copy and then a removal. */
async function moveItem(item: MoveItem, prepared: PreparedMove, progress: CopyProgress,
                        dependencies: CopyDependencies): Promise<NameOutcome> {
    if (prepared.acrossDisks) {
        return moveAcross(item, prepared, progress, dependencies);
    }
    try {
        const placement = await placeAt(item.source, item, prepared, dependencies, dependencies.hiddenNameSuffix());
        if (!placement.placed) {
            return placement.outcome;
        }
        progress.files_done += 1;
        return placement.oldStays;
    } catch (err) {
        if (errorCodeOf(err) !== "EXDEV") {
            return moveFailure(err);
        }
    }
    // 1 device, yet 2 filesystems to `rename`. The name already counts as 1 in `files_total`.
    const totals = await countItem(item, dependencies);
    const refusal = countRefusal(totals, item.stats);
    if (refusal) {
        return refusal;
    }
    progress.files_total = (progress.files_total ?? 0) + totals.files - 1;
    progress.bytes_total = (progress.bytes_total ?? 0) + totals.bytes;
    return moveAcross(item, prepared, progress, dependencies);
}

/**
 * Copies the name to a hidden name beside its target, puts the copy in place, then removes the original. The
 * original is not touched before its copy is whole and in place. A copy that fails is removed.
 */
async function moveAcross(item: MoveItem, prepared: PreparedMove, progress: CopyProgress,
                          dependencies: CopyDependencies): Promise<NameOutcome> {
    const { copier, platform } = dependencies;
    const paths = pathsFor(platform);
    const { protectedSet } = prepared.sourceGuard;
    try {
        const settledFirst = await targetBeforeCopy(item, prepared, dependencies);
        if (settledFirst) {
            return settledFirst;
        }
    } catch (err) {
        return moveFailure(err);
    }

    const suffix = dependencies.hiddenNameSuffix();
    const hiddenCopy = paths.join(prepared.destinationDirectory, hiddenName(item.targetName, HIDDEN_MOVE_MARK, suffix));
    const walk: CopyWalk = { copier, paths, platform, progress, specialFilesLeftOut: 0 };
    let placement: Placement;
    try {
        await copyEntry(item.source, item.stats, hiddenCopy, walk, true);
        if (walk.specialFilesLeftOut > 0) {
            // Made while the copy ran. Without them the copy is not whole, so the original stays.
            await removeQuietly(hiddenCopy, protectedSet, dependencies);
            return specialInside(walk.specialFilesLeftOut);
        }
        placement = await placeAt(hiddenCopy, item, prepared, dependencies, suffix);
    } catch (err) {
        if (!(err instanceof TakenError)) {
            await removeQuietly(hiddenCopy, protectedSet, dependencies);
        }
        return moveFailure(err);
    }
    if (!placement.placed) {
        await removeQuietly(hiddenCopy, protectedSet, dependencies);
        return placement.outcome;
    }
    return await removeOriginal(item, protectedSet, dependencies) ?? placement.oldStays;
}

/**
 * Under `fail`, `skip` and `replace`, a target already taken settles the name before anything is copied, so a
 * 12 GB copy is not made only to fail. `keep_both` picks its free name once the copy is whole.
 */
async function targetBeforeCopy(item: MoveItem, prepared: PreparedMove,
                                dependencies: CopyDependencies): Promise<typeof SKIPPED | NameFailure | null> {
    if (prepared.onConflict === ON_CONFLICT_KEEP_BOTH) {
        return null;
    }
    const paths = pathsFor(dependencies.platform);
    const existing = await lstatOrNull(paths.join(prepared.destinationDirectory, item.targetName),
        dependencies.copier);
    if (existing === null) {
        return null;
    }
    switch (prepared.onConflict) {
        case ON_CONFLICT_SKIP:
            return SKIPPED;
        case ON_CONFLICT_REPLACE:
            return replaceRefusal(existing, item.stats, prepared.destinationDevice, prepared.replaceGuard!);
        default:
            return { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN };
    }
}

/**
 * Puts `incoming`, the source itself or its whole copy, at the item's target name, as `on_conflict` says. A failed
 * rename is thrown, with nothing placed and the old item where it was.
 */
async function placeAt(incoming: string, item: MoveItem, prepared: PreparedMove, dependencies: CopyDependencies,
                       suffix: string): Promise<Placement> {
    const { copier } = dependencies;
    const paths = pathsFor(dependencies.platform);
    const target = paths.join(prepared.destinationDirectory, item.targetName);
    const existing = await lstatOrNull(target, copier);
    if (existing === null || isCaseOnlyRename(prepared.sameFolder, item.name, item.targetName, item.stats, existing)) {
        await copier.rename(incoming, target);
        return PLACED;
    }
    switch (prepared.onConflict) {
        case ON_CONFLICT_SKIP:
            return { placed: false, outcome: SKIPPED };
        case ON_CONFLICT_KEEP_BOTH:
            return placeUnderFreeName(incoming, item, prepared, dependencies);
        case ON_CONFLICT_REPLACE:
            return replaceAt(incoming, existing, item, prepared, dependencies, suffix);
        default:
            return { placed: false, outcome: { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN } };
    }
}

/** `name (1).ext`, `name (2).ext` and so on: the first that is free. */
async function placeUnderFreeName(incoming: string, item: MoveItem, prepared: PreparedMove,
                                  dependencies: CopyDependencies): Promise<Placement> {
    const paths = pathsFor(dependencies.platform);
    for (let number = 1; number <= MAX_KEEP_BOTH_NUMBER; number++) {
        const candidate = paths.join(prepared.destinationDirectory,
            keepBothName(item.targetName, item.stats.isDirectory(), number));
        if (await lstatOrNull(candidate, dependencies.copier) === null) {
            await dependencies.copier.rename(incoming, candidate);
            return PLACED;
        }
    }
    return { placed: false, outcome: { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN } };
}

/** The swap of `copy`'s `replace`, then the old item removed by `delete`'s walk. */
async function replaceAt(incoming: string, existing: fs.BigIntStats, item: MoveItem, prepared: PreparedMove,
                         dependencies: CopyDependencies, suffix: string): Promise<Placement> {
    const guard = prepared.replaceGuard!;
    const refusal = replaceRefusal(existing, item.stats, prepared.destinationDevice, guard);
    if (refusal) {
        return { placed: false, outcome: refusal };
    }
    const paths = pathsFor(dependencies.platform);
    const oldName = await swapIn(incoming, prepared.destinationDirectory, item.targetName, existing,
        item.stats.isDirectory(), suffix, dependencies.copier, paths);
    if (oldName === null) {
        return PLACED;
    }
    const oldStays = await removeOld(paths.join(prepared.destinationDirectory, oldName), oldName, existing,
        guard.protectedSet, dependencies, MESSAGE_MOVED_IN_PLACE);
    return { placed: true, oldStays };
}

/** The original, once its copy is in place, by `delete`'s walk. A failure leaves the rest of it, and says so. */
async function removeOriginal(item: MoveItem, protectedSet: ProtectedSet,
                              dependencies: CopyDependencies): Promise<NameFailure | null> {
    try {
        if (await removeTree(item.source, item.stats, protectedSet, deleteDependencies(dependencies))) {
            return null;
        }
        return { code: ERROR_MOUNT_POINT, message: `${MESSAGE_ORIGINAL_STAYS} ${REASON_MOUNT_INSIDE}` };
    } catch (err) {
        const failure = deleteFailure(err);
        const message = sanitizeErrorMessage(`${MESSAGE_ORIGINAL_STAYS} ${failure.message}`) ?? failure.message;
        return { code: failure.code, message };
    }
}

/** A failed move, as 1 entry of `failed`. */
function moveFailure(err: unknown): NameFailure {
    switch (errorCodeOf(err)) {
        case "EBUSY":
            // Windows: another program holds the file open.
            return { code: ERROR_PERMISSION_DENIED, message: failureMessage(err, MESSAGE_MOVE_FAILED) };
        case "ENOTEMPTY":
        case "EISDIR":
            // The target was taken between its check and the rename.
            return { code: ERROR_FILE_EXISTS, message: MESSAGE_NAME_TAKEN };
        default:
            return copyFailure(err, MESSAGE_MOVE_FAILED);
    }
}
