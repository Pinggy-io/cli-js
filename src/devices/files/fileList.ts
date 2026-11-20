import fs from "fs";
import path from "path";
import {
    DEFAULT_LIST_LIMIT, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PATH, ERROR_NOT_A_DIRECTORY,
    ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, FileEntry, FileListAnswer, FileListRequest, FileListResult,
    SORT_BY_CREATED, SORT_BY_MODIFIED, SORT_BY_NAME, SORT_BY_SIZE, SORT_ORDER_DESC, fileError,
} from "./file_schema.js";
import {
    FileCallTimeoutError, FileSystemDependencies, HIDDEN_NAME_PREFIX, entryTypeOf, epochSeconds, errorCodeOf,
    failureMessage, machineFileSystemDependencies, pathProblem, pathsFor, readLinkTarget, utf8Bytes, withTimeout,
} from "./fileSystem.js";

/**
 * `file/list`: 1 page of 1 folder.
 *
 * 1 `readdir` gives every name with its type, without opening the entries. Sorting by name needs
 * nothing more, so only the entries on the page are `lstat`ed. Sorting by size, modified time or
 * created time `lstat`s the whole folder first, which costs more on a large one.
 *
 * The page is cut twice: at `limit`, and before the entry that would push the answer past the frame
 * budget. `next_offset` is where the next page starts, so a page cut short by long names is never
 * skipped past.
 *
 * The path the user walked is kept: a symlinked folder is listed under the link's path, not its
 * target's. Nothing here logs a path.
 */

/** A drive that does not answer this fast is left out of `roots`, so 1 dead network drive cannot stall the open. */
const ROOT_PROBE_TIMEOUT_MILLIS = 2_000;

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const POSIX_ROOT = "/";

/**
 * Stands in for `next_offset` while the frame budget is measured, so the real value, whatever its
 * digits, never makes the answer larger than measured.
 */
const WIDEST_NEXT_OFFSET = Number.MAX_SAFE_INTEGER;

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const MESSAGE_LIST_FAILED = "The folder could not be read.";

/** A failed folder read, by its errno. The message is Node's own, which names the path, cleaned and cut. */
function folderReadFailure(err: unknown): FileListResult {
    const message = failureMessage(err, MESSAGE_LIST_FAILED);
    if (err instanceof FileCallTimeoutError) {
        return fileError(ERROR_FILE_TIMEOUT, message);
    }
    switch (errorCodeOf(err)) {
        case "ENOENT":
            return fileError(ERROR_PATH_NOT_FOUND, message);
        case "ENOTDIR":
            return fileError(ERROR_NOT_A_DIRECTORY, message);
        case "EACCES":
        case "EPERM":
            return fileError(ERROR_PERMISSION_DENIED, message);
        default:
            return fileError(ERROR_FILE_OPERATION_FAILED, message);
    }
}

/** Case-insensitive, numbers in natural order (`file2` before `file10`). Exact order breaks a tie, so 1 order holds. */
function compareNames(left: string, right: string): number {
    const byCollator = NAME_COLLATOR.compare(left, right);
    if (byCollator !== 0) return byCollator;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

interface SortKeys {
    /** 0 for anything that is not a file, and for an entry `lstat` could not read. */
    sizeBytes: number;
    modifiedMillis: number;
    /** 0 where the filesystem records no birth time, as for an unreadable entry: both sort as the oldest. */
    createdMillis: number;
}

async function readSortKeys(folder: string, dirents: fs.Dirent[], dependencies: FileSystemDependencies,
                            paths: path.PlatformPath): Promise<Map<string, SortKeys>> {
    const keys = new Map<string, SortKeys>();
    await Promise.all(dirents.map(async (dirent) => {
        try {
            const stats = await dependencies.fs.lstat(paths.join(folder, dirent.name));
            keys.set(dirent.name, {
                sizeBytes: stats.isFile() ? stats.size : 0,
                modifiedMillis: stats.mtimeMs,
                createdMillis: stats.birthtimeMs,
            });
        } catch {
            keys.set(dirent.name, { sizeBytes: 0, modifiedMillis: 0, createdMillis: 0 });
        }
    }));
    return keys;
}

/**
 * Folders first, always. Then the chosen key, with the name breaking every tie. A folder has no size,
 * so by size the folders sort by name. A symlink counts as a non-folder, so sorting needs no read of
 * its target. `desc` reverses inside each group, the name order included.
 */
function sortDirents(dirents: fs.Dirent[], sortBy: string, descending: boolean,
                     keys: Map<string, SortKeys> | null): fs.Dirent[] {
    const direction = descending ? -1 : 1;
    return [...dirents].sort((left, right) => {
        const leftIsFolder = left.isDirectory();
        if (leftIsFolder !== right.isDirectory()) {
            return leftIsFolder ? -1 : 1;
        }
        let order = 0;
        if (keys && sortBy === SORT_BY_SIZE && !leftIsFolder) {
            order = keys.get(left.name)!.sizeBytes - keys.get(right.name)!.sizeBytes;
        } else if (keys && sortBy === SORT_BY_MODIFIED) {
            order = keys.get(left.name)!.modifiedMillis - keys.get(right.name)!.modifiedMillis;
        } else if (keys && sortBy === SORT_BY_CREATED) {
            order = keys.get(left.name)!.createdMillis - keys.get(right.name)!.createdMillis;
        }
        if (order === 0) {
            order = compareNames(left.name, right.name);
        }
        return order * direction;
    });
}

/**
 * 1 row. An entry `lstat` cannot read, a locked Windows system file for example, keeps its name and
 * becomes `unknown`. A symlink's target is read without following it further than `stat` does.
 */
async function describeEntry(folder: string, dirent: fs.Dirent, dependencies: FileSystemDependencies,
                             paths: path.PlatformPath): Promise<FileEntry> {
    const fullPath = paths.join(folder, dirent.name);
    let stats: fs.Stats;
    try {
        stats = await dependencies.fs.lstat(fullPath);
    } catch {
        return { name: dirent.name, type: "unknown" };
    }

    const type = entryTypeOf(stats);
    const entry: FileEntry = { name: dirent.name, type, modified_at: epochSeconds(stats.mtimeMs) };
    if (stats.birthtimeMs > 0) {
        entry.created_at = epochSeconds(stats.birthtimeMs);
    }
    if (type === "file") {
        entry.size_bytes = stats.size;
    }
    if (dirent.name.startsWith(HIDDEN_NAME_PREFIX)) {
        entry.hidden = true;
    }
    if (type === "symlink") {
        const { linkTarget, targetType } = await readLinkTarget(fullPath, dependencies.fs);
        if (linkTarget !== undefined) {
            entry.link_target = linkTarget;
        }
        if (targetType !== undefined) {
            entry.target_type = targetType;
        }
    }
    return entry;
}

/** `["/"]` on POSIX. On Windows, the drive letters whose root answers within {@link ROOT_PROBE_TIMEOUT_MILLIS}. */
async function listRoots(dependencies: FileSystemDependencies): Promise<string[]> {
    if (dependencies.platform !== "win32") {
        return [POSIX_ROOT];
    }
    const drives = [...WINDOWS_DRIVE_LETTERS].map((letter) => `${letter}:\\`);
    const answers = await Promise.all(drives.map((drive) => withTimeout(
        dependencies.fs.access(drive).then(() => true), ROOT_PROBE_TIMEOUT_MILLIS, false)));
    return drives.filter((_drive, index) => answers[index]);
}

/**
 * Carries out 1 `file/list`. Never throws: every failure is an error answer.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function listFolder(request: FileListRequest, maxPayloadBytes: number,
                                 dependencies: FileSystemDependencies = machineFileSystemDependencies):
    Promise<FileListResult> {
    try {
        return await listFolderOrThrow(request, maxPayloadBytes, dependencies);
    } catch (err) {
        return folderReadFailure(err);
    }
}

async function listFolderOrThrow(request: FileListRequest, maxPayloadBytes: number,
                                 dependencies: FileSystemDependencies): Promise<FileListResult> {
    const paths = pathsFor(dependencies.platform);
    const firstOpen = request.path === undefined;

    let folder: string;
    if (request.path === undefined) {
        folder = paths.resolve(dependencies.fs.homedir());
    } else {
        const problem = pathProblem(request.path, paths);
        if (problem) {
            return fileError(ERROR_INVALID_PATH, problem);
        }
        folder = paths.resolve(request.path);
    }

    let dirents: fs.Dirent[];
    try {
        dirents = await dependencies.fs.readdir(folder);
    } catch (err) {
        return folderReadFailure(err);
    }

    const visible = request.include_hidden
        ? dirents
        : dirents.filter((dirent) => !dirent.name.startsWith(HIDDEN_NAME_PREFIX));
    const sortBy = request.sort_by ?? SORT_BY_NAME;
    const keys = sortBy === SORT_BY_NAME ? null : await readSortKeys(folder, visible, dependencies, paths);
    const sorted = sortDirents(visible, sortBy, request.sort_order === SORT_ORDER_DESC, keys);

    const offset = request.offset ?? 0;
    const limit = request.limit ?? DEFAULT_LIST_LIMIT;
    const page = sorted.slice(offset, offset + limit);
    const described = await Promise.all(page.map((dirent) => describeEntry(folder, dirent, dependencies, paths)));

    const parent = paths.dirname(folder);
    const answer: FileListAnswer = {
        path: folder,
        ...(parent !== folder ? { parent } : {}),
        separator: paths.sep,
        total: visible.length,
        offset,
        entries: [],
    };
    if (firstOpen) {
        answer.home = folder;
        answer.roots = await listRoots(dependencies);
    }

    // The page so far is the empty answer plus each entry and the comma before it.
    let payloadBytes = utf8Bytes({ ...answer, next_offset: WIDEST_NEXT_OFFSET });
    for (const entry of described) {
        const entryBytes = utf8Bytes(entry) + (answer.entries.length > 0 ? 1 : 0);
        if (payloadBytes + entryBytes > maxPayloadBytes) {
            break;
        }
        answer.entries.push(entry);
        payloadBytes += entryBytes;
    }

    // A name is at most 255 bytes, so only a tiny frame cap gets here. Answering a page with no entries
    // and the same offset would have the browser ask for it again forever.
    if (described.length > 0 && answer.entries.length === 0) {
        return fileError(ERROR_FILE_OPERATION_FAILED, "The next entry does not fit in 1 frame.");
    }

    const nextOffset = offset + answer.entries.length;
    if (nextOffset < visible.length) {
        answer.next_offset = nextOffset;
    }
    return answer;
}
