import fs from "fs";
import os from "os";
import path from "path";
import { sanitizeErrorMessage } from "../tunnels/tunnelList.js";
import {
    DEFAULT_LIST_LIMIT, ERROR_FILE_OPERATION_FAILED, ERROR_INVALID_PATH, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND,
    ERROR_PERMISSION_DENIED, FileEntry, FileEntryType, FileListAnswer, FileListRequest, FileListResult,
    FileTargetType, MAX_PATH_BYTES, SORT_BY_MODIFIED, SORT_BY_NAME, SORT_BY_SIZE, SORT_ORDER_DESC, fileError,
} from "./file_schema.js";

/**
 * `file/list`: 1 page of 1 folder.
 *
 * 1 `readdir` gives every name with its type, without opening the entries. Sorting by name needs
 * nothing more, so only the entries on the page are `lstat`ed. Sorting by size or modified time
 * `lstat`s the whole folder first, which costs more on a large one.
 *
 * The page is cut twice: at `limit`, and before the entry that would push the answer past the frame
 * budget. `next_offset` is where the next page starts, so a page cut short by long names is never
 * skipped past.
 *
 * The path the user walked is kept: a symlinked folder is listed under the link's path, not its
 * target's. Nothing here logs a path.
 */

/** The filesystem calls `list` makes. A test swaps in a fake to slow, fail or shape 1 of them. */
export interface FileSystemReader {
    readdir(folder: string): Promise<fs.Dirent[]>;
    lstat(target: string): Promise<fs.Stats>;
    stat(target: string): Promise<fs.Stats>;
    readlink(target: string): Promise<string>;
    access(target: string): Promise<void>;
    homedir(): string;
}

export interface FileListDependencies {
    fs: FileSystemReader;
    /** Picks the path rules: `win32` for drive letters and `\`, anything else for POSIX. */
    platform: NodeJS.Platform;
}

export const machineFileSystem: FileSystemReader = {
    readdir: (folder) => fs.promises.readdir(folder, { withFileTypes: true }),
    lstat: (target) => fs.promises.lstat(target),
    stat: (target) => fs.promises.stat(target),
    readlink: (target) => fs.promises.readlink(target),
    access: (target) => fs.promises.access(target),
    homedir: () => os.homedir(),
};

export const machineFileListDependencies: FileListDependencies = {
    fs: machineFileSystem,
    platform: process.platform,
};

/** A drive that does not answer this fast is left out of `roots`, so 1 dead network drive cannot stall the open. */
const ROOT_PROBE_TIMEOUT_MILLIS = 2_000;

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const POSIX_ROOT = "/";
const HIDDEN_NAME_PREFIX = ".";
const MILLIS_PER_SECOND = 1000;

/**
 * Stands in for `next_offset` while the frame budget is measured, so the real value, whatever its
 * digits, never makes the answer larger than measured.
 */
const WIDEST_NEXT_OFFSET = Number.MAX_SAFE_INTEGER;

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const MESSAGE_LIST_FAILED = "The folder could not be read.";

function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
    return platform === "win32" ? path.win32 : path.posix;
}

/** Null when the path is usable. Checked before `resolve`, which turns `""` into the process's own folder. */
function pathProblem(requested: string, paths: path.PlatformPath): string | null {
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

function errorCodeOf(err: unknown): string | undefined {
    return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
        ? err.code : undefined;
}

/** A failed folder read, by its errno. The message is Node's own, which names the path, cleaned and cut. */
function folderReadFailure(err: unknown): FileListResult {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err)) ?? MESSAGE_LIST_FAILED;
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

function entryTypeOf(stats: fs.Stats): FileEntryType {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

function targetTypeOf(stats: fs.Stats): FileTargetType {
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

function epochSeconds(millis: number): number {
    return Math.floor(millis / MILLIS_PER_SECOND);
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
}

async function readSortKeys(folder: string, dirents: fs.Dirent[], dependencies: FileListDependencies,
                            paths: path.PlatformPath): Promise<Map<string, SortKeys>> {
    const keys = new Map<string, SortKeys>();
    await Promise.all(dirents.map(async (dirent) => {
        try {
            const stats = await dependencies.fs.lstat(paths.join(folder, dirent.name));
            keys.set(dirent.name, { sizeBytes: stats.isFile() ? stats.size : 0, modifiedMillis: stats.mtimeMs });
        } catch {
            keys.set(dirent.name, { sizeBytes: 0, modifiedMillis: 0 });
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
async function describeEntry(folder: string, dirent: fs.Dirent, dependencies: FileListDependencies,
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
    if (type === "file") {
        entry.size_bytes = stats.size;
    }
    if (dirent.name.startsWith(HIDDEN_NAME_PREFIX)) {
        entry.hidden = true;
    }
    if (type === "symlink") {
        try {
            entry.link_target = await dependencies.fs.readlink(fullPath);
        } catch {
            // A link that cannot be read keeps its row, without a target.
        }
        try {
            entry.target_type = targetTypeOf(await dependencies.fs.stat(fullPath));
        } catch (err) {
            const code = errorCodeOf(err);
            if (code === "ENOENT" || code === "ENOTDIR") {
                entry.target_type = "missing";
            }
        }
    }
    return entry;
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

/** `["/"]` on POSIX. On Windows, the drive letters whose root answers within {@link ROOT_PROBE_TIMEOUT_MILLIS}. */
async function listRoots(dependencies: FileListDependencies): Promise<string[]> {
    if (dependencies.platform !== "win32") {
        return [POSIX_ROOT];
    }
    const drives = [...WINDOWS_DRIVE_LETTERS].map((letter) => `${letter}:\\`);
    const answers = await Promise.all(drives.map((drive) => withTimeout(
        dependencies.fs.access(drive).then(() => true), ROOT_PROBE_TIMEOUT_MILLIS, false)));
    return drives.filter((_drive, index) => answers[index]);
}

function utf8Bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Carries out 1 `file/list`. Never throws: every failure is an error answer.
 *
 * @param maxPayloadBytes the most the answer's payload may take, so the whole frame fits `max_frame_bytes`
 */
export async function listFolder(request: FileListRequest, maxPayloadBytes: number,
                                 dependencies: FileListDependencies = machineFileListDependencies):
    Promise<FileListResult> {
    try {
        return await listFolderOrThrow(request, maxPayloadBytes, dependencies);
    } catch (err) {
        return folderReadFailure(err);
    }
}

async function listFolderOrThrow(request: FileListRequest, maxPayloadBytes: number,
                                 dependencies: FileListDependencies): Promise<FileListResult> {
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
