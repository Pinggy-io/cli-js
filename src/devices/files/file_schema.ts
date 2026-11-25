import { z } from "zod";

/**
 * Frames and payloads for the `file` channel: the file manager on the device page.
 *
 * 6 ops, each answered on the request's own id and op. The agent keeps nothing between 2 requests.
 *
 * - `list`: 1 page of 1 folder. Sorting and the hidden filter run here, over the whole folder, because
 *   the browser only ever holds the pages it asked for.
 * - `stat`: the metadata of 1 path.
 * - `delete`: 1 path, recursively and for good. While it runs, `progress` events go out on the request's id.
 *   A started delete runs to the end: there is no cancel.
 * - `mkdir`: 1 new, empty folder at 1 path. 1 level: its parent folder must exist.
 * - `copy`: 1 file or folder to 1 target path on the same device. Folders copy whole. It sends `progress` as
 *   `delete` does, and runs to the end.
 * - `move`: `copy`'s request, answer and `progress`, but the item leaves where it was. A rename is a move whose
 *   target path has a new last part.
 *
 * Each request names 1 item by its full path, with no current folder. The tab sends a selection of several items
 * as 1 request each.
 */
export const CHANNEL_FILE = "file";

export const OP_LIST = "list";
export const OP_STAT = "stat";
export const OP_DELETE = "delete";
export const OP_MKDIR = "mkdir";
export const OP_COPY = "copy";
export const OP_MOVE = "move";
/** The only event with an id: the request it reports on. Agent to dashboard only. */
export const OP_PROGRESS = "progress";

export const ERROR_INVALID_PAYLOAD = "invalid_payload";
export const ERROR_UNSUPPORTED_OP = "unsupported_op";
/** The last `welcome` did not say `file_manager_enabled: true`. */
export const ERROR_FILE_MANAGER_DISABLED = "file_manager_disabled";
/** device.json says no to file access: the question was answered no, or `--files off` was passed. */
export const ERROR_FILE_ACCESS_OFF = "file_access_off";
/**
 * Relative, a NUL byte, or longer than {@link MAX_PATH_BYTES}. `copy` and `move` also answer it for a filesystem
 * root as either path: a root has no name to copy or move it under.
 */
export const ERROR_INVALID_PATH = "invalid_path";
export const ERROR_PATH_NOT_FOUND = "path_not_found";
/** `list` only: the path is a file. `stat` describes any kind of path, so it never answers this. */
export const ERROR_NOT_A_DIRECTORY = "not_a_directory";
export const ERROR_PERMISSION_DENIED = "permission_denied";
/** The reads took longer than the handler waits, usually a network drive that stopped answering. */
export const ERROR_FILE_TIMEOUT = "file_timeout";
export const ERROR_FILE_OPERATION_FAILED = "file_operation_failed";
/**
 * A root, home, the config folder or what is in it, a folder above them, or an OS system folder: as a delete's path,
 * a move's source or a replaced item.
 */
export const ERROR_PROTECTED_PATH = "protected_path";
/** An item that is a mounted disk, or 1 with a mounted disk inside, left in place. */
export const ERROR_MOUNT_POINT = "mount_point";
/**
 * The device already runs as many copies, moves and deletes as the last `welcome` allows, and as many wait for a
 * slot as it allows.
 */
export const ERROR_FILE_BUSY = "file_busy";
/** A file or folder is at the target path already. Nothing changed. */
export const ERROR_FILE_EXISTS = "file_exists";
/**
 * On Windows, the last part of `mkdir`'s path, or of `copy`'s and `move`'s `destination_path`: a name Windows refuses,
 * before the disk is touched.
 */
export const ERROR_INVALID_NAME = "invalid_name";
/**
 * `copy` and `move`: a folder into itself or a folder inside it, or `replace` of an item by itself or of a folder
 * holding it. `move` only: the item is at its target path already.
 */
export const ERROR_INVALID_DESTINATION = "invalid_destination";
/** `copy`, and `move` to another disk: the destination disk lacks the room, before the copy or during it. */
export const ERROR_NO_SPACE = "no_space";
/**
 * `copy`: a socket, a named pipe or a device file, which Node cannot make, was left out. `move` to another disk: the
 * item is or holds 1, and was not moved.
 */
export const ERROR_SPECIAL_FILE = "special_file";

export const SORT_BY_NAME = "name";
export const SORT_BY_SIZE = "size";
export const SORT_BY_MODIFIED = "modified";
export const SORT_BY_CREATED = "created";
export const SORT_ORDER_ASC = "asc";
export const SORT_ORDER_DESC = "desc";

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 500;
export const MAX_PATH_BYTES = 4096;
export const MAX_NAME_BYTES = 255;

/** What `copy` and `move` do with a target path already taken. Absent means {@link ON_CONFLICT_FAIL}. */
export const ON_CONFLICT_FAIL = "fail";
export const ON_CONFLICT_SKIP = "skip";
export const ON_CONFLICT_KEEP_BOTH = "keep_both";
export const ON_CONFLICT_REPLACE = "replace";

/**
 * Every field is optional, and an absent field takes its default here, never on the dashboard: only
 * this side knows the home folder. A present field must be valid. `path: ""` is a string, so it passes
 * this schema and fails the absolute-path check as `invalid_path`.
 */
export const FileListRequestSchema = z.object({
    path: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    sort_by: z.enum([SORT_BY_NAME, SORT_BY_SIZE, SORT_BY_MODIFIED, SORT_BY_CREATED]).optional(),
    sort_order: z.enum([SORT_ORDER_ASC, SORT_ORDER_DESC]).optional(),
    include_hidden: z.boolean().optional(),
});

export type FileListRequest = z.infer<typeof FileListRequestSchema>;

/**
 * `path` is required: the tab always holds the path it asks about, so there is no home default.
 * `include_hidden` counts dot names in a folder's `entry_count` by `list`'s rule, so the count matches
 * the `total` the tab shows for that folder. Not strict, so the dashboard can add fields.
 */
export const FileStatRequestSchema = z.object({
    path: z.string(),
    include_hidden: z.boolean().optional(),
});

export type FileStatRequest = z.infer<typeof FileStatRequestSchema>;

/**
 * The shape only. The path rules, which depend on the device's OS, are checked by the delete itself. Not strict, so
 * the dashboard can add fields.
 */
export const FileDeleteRequestSchema = z.object({
    path: z.string(),
});

export type FileDeleteRequest = z.infer<typeof FileDeleteRequestSchema>;

/** The shape only, as for `delete`: the rules for the path and its last part depend on the device's OS. Not strict. */
export const FileMkdirRequestSchema = z.object({
    path: z.string(),
});

export type FileMkdirRequest = z.infer<typeof FileMkdirRequestSchema>;

/**
 * `copy` and `move`. The shape only, as for `delete`: the rules for each path depend on the device's OS. The item at
 * `source_path` lands at `destination_path`, whose parent folder must exist. Not strict.
 */
export const FileCopyRequestSchema = z.object({
    source_path: z.string(),
    destination_path: z.string(),
    on_conflict: z.enum([ON_CONFLICT_FAIL, ON_CONFLICT_SKIP, ON_CONFLICT_KEEP_BOTH, ON_CONFLICT_REPLACE]).optional(),
});

export type FileCopyRequest = z.infer<typeof FileCopyRequestSchema>;

export type FileOnConflict = NonNullable<FileCopyRequest["on_conflict"]>;

/** What `lstat` can say a path is. */
export type FileKnownType = "file" | "directory" | "symlink" | "other";

/** `unknown` is a `list` row whose `lstat` failed. */
export type FileEntryType = FileKnownType | "unknown";

/** What a symlink points at. `missing` is a broken link. */
export type FileTargetType = "file" | "directory" | "other" | "missing";

/** 1 row. Only `name` and `type` are always present. A field with no value is left off, never null. */
export interface FileEntry {
    name: string;
    type: FileEntryType;
    modified_at?: number;
    /** The birth time. Absent where the filesystem records none, which Node reports as 0. */
    created_at?: number;
    size_bytes?: number;
    /** A name starting with `.`. Present only when the request asked for hidden entries. */
    hidden?: true;
    link_target?: string;
    target_type?: FileTargetType;
}

export interface FileListAnswer {
    path: string;
    /** Absent at a root. */
    parent?: string;
    separator: string;
    total: number;
    offset: number;
    /** Absent on the last page. */
    next_offset?: number;
    entries: FileEntry[];
    /** First open only: the request had no `path`. */
    home?: string;
    roots?: string[];
}

/**
 * The metadata of 1 path, from `lstat`, so a symlink is described as itself. Only `target_type` and
 * `target_size_bytes` come from what a symlink points at. A field with no value is left off, never null.
 */
export interface FileStatAnswer {
    path: string;
    /** The last part of `path`, or `path` itself at a root: `/`, `C:\`. */
    name: string;
    /** Never `unknown`: a failed `lstat` is an error answer. */
    type: FileKnownType;
    /** Files only. */
    size_bytes?: number;
    modified_at: number;
    accessed_at: number;
    /** Absent when the filesystem reports no birth time. */
    created_at?: number;
    /** A name starting with `.`, whatever `include_hidden` says. */
    hidden?: true;
    /** 4 octal digits of `mode & 07777`, so setuid, setgid and sticky show. Absent on Windows. */
    mode?: string;
    /** Absent on Windows. */
    uid?: number;
    gid?: number;
    /** For the user the agent runs as. Absent on Windows and on a symlink. */
    readable?: boolean;
    writable?: boolean;
    executable?: boolean;
    /** Directories whose names can be read, by `list`'s hidden rule. */
    entry_count?: number;
    /** What the symlink holds, as stored. Absent when it cannot be read or does not fit the frame. */
    link_target?: string;
    target_type?: FileTargetType;
    /** A symlink whose target is a file: that file's size. */
    target_size_bytes?: number;
}

export interface FileError {
    error: FileFailure;
}

/** Why a request failed. */
export interface FileFailure {
    code: string;
    message: string;
}

/**
 * The answer of a delete, a copy or a move that finished: `{}`. A copy or a move whose target was taken under
 * `on_conflict: skip` answers `{ skipped: true }`, with nothing changed. Any failure is a {@link FileError}.
 */
export interface FileOperationAnswer {
    skipped?: true;
}

/** The `progress` payload of the 1 item a delete, a copy or a move works on. */
export interface FileProgress {
    /** 1 once the item is done. */
    items_done: number;
    /** Always 1. */
    items_total: number;
    /** Files, folders and links removed or made so far inside the item. A move on 1 disk: 1 once moved. */
    files_done: number;
    /** A copy or a move only: bytes written so far. 0 for a move on 1 disk. */
    bytes_done?: number;
    /** A copy or a move only, once counted: files, folders and links in the item. A move on 1 disk: 1. */
    files_total?: number;
    /** A copy or a move only, once counted: bytes in the item. 0 for a move on 1 disk. */
    bytes_total?: number;
    /** The item's own name, the last part of its path. */
    current_name: string;
}

/**
 * The `progress` payload of a copy, a move or a delete waiting for a slot. Nothing of the request has run, so it
 * carries no counts.
 */
export interface FileQueuedProgress {
    /** The request's place in line. 1 starts next. */
    queued_position: number;
}

export type FileListResult = FileListAnswer | FileError;

export type FileStatResult = FileStatAnswer | FileError;

export type FileDeleteResult = FileOperationAnswer | FileError;

export type FileCopyResult = FileOperationAnswer | FileError;

/** The new folder's path, resolved with the device's own separator. */
export interface FileMkdirAnswer {
    path: string;
}

export type FileMkdirResult = FileMkdirAnswer | FileError;

export function fileError(code: string, message: string): FileError {
    return { error: { code, message } };
}
