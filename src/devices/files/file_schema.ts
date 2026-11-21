import { z } from "zod";

/**
 * Frames and payloads for the `file` channel: the file manager on the device page.
 *
 * 5 ops, each answered on the request's own id and op. The agent keeps nothing between 2 requests.
 *
 * - `list`: 1 page of 1 folder. Sorting and the hidden filter run here, over the whole folder, because
 *   the browser only ever holds the pages it asked for.
 * - `stat`: the metadata of 1 path.
 * - `delete`: 1 or more names from 1 folder, recursively and for good. While it runs, `progress` events
 *   go out on the request's id. A started delete runs to the end: there is no cancel.
 * - `mkdir`: 1 new, empty folder in 1 folder. 1 level: the name is never a path.
 * - `copy`: 1 or more names from 1 folder into another folder on the same device, or 1 name under a new
 *   name. Folders copy whole. It sends `progress` as `delete` does, and runs to the end.
 */
export const CHANNEL_FILE = "file";

export const OP_LIST = "list";
export const OP_STAT = "stat";
export const OP_DELETE = "delete";
export const OP_MKDIR = "mkdir";
export const OP_COPY = "copy";
/** The only event with an id: the request it reports on. Agent to dashboard only. */
export const OP_PROGRESS = "progress";

export const ERROR_INVALID_PAYLOAD = "invalid_payload";
export const ERROR_UNSUPPORTED_OP = "unsupported_op";
/** The last `welcome` did not say `file_manager_enabled: true`. */
export const ERROR_FILE_MANAGER_DISABLED = "file_manager_disabled";
/** Relative, a NUL byte, or longer than {@link MAX_PATH_BYTES}. */
export const ERROR_INVALID_PATH = "invalid_path";
export const ERROR_PATH_NOT_FOUND = "path_not_found";
/** `list` only: the path is a file. `stat` describes any kind of path, so it never answers this. */
export const ERROR_NOT_A_DIRECTORY = "not_a_directory";
export const ERROR_PERMISSION_DENIED = "permission_denied";
/** The reads took longer than the handler waits, usually a network drive that stopped answering. */
export const ERROR_FILE_TIMEOUT = "file_timeout";
export const ERROR_FILE_OPERATION_FAILED = "file_operation_failed";
/** A root, home, the config folder or what is in it, a folder above them, or an OS system folder. */
export const ERROR_PROTECTED_PATH = "protected_path";
/** A name that is a mounted disk, or 1 with a mounted disk inside, left in place. */
export const ERROR_MOUNT_POINT = "mount_point";
/** The device already runs as many copies and deletes as the last `welcome` allows. */
export const ERROR_FILE_BUSY = "file_busy";
/**
 * A file or folder of that name is there already. Nothing changed. A whole `copy` refused this way adds
 * `conflict_count` and `conflicts`.
 */
export const ERROR_FILE_EXISTS = "file_exists";
/** `mkdir` and `copy`'s `new_name` on Windows: a name Windows does not allow, checked before the disk is touched. */
export const ERROR_INVALID_NAME = "invalid_name";
/** `copy`: a folder into itself or a folder inside it, or `replace` of an item by itself or of a folder holding it. */
export const ERROR_INVALID_DESTINATION = "invalid_destination";
/** `copy`: the destination disk lacks the room, before the copy or during it. */
export const ERROR_NO_SPACE = "no_space";
/** `copy`: a socket, a named pipe or a device file, which Node cannot make, was left out. */
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
export const MAX_DELETE_NAMES = 200;
export const MAX_COPY_NAMES = 200;
/** `failed` lists at most this many, so the answer fits 1 frame. `failed_count` is the true number. */
export const MAX_FAILURES_LISTED = 20;
/** A refused `copy`'s `conflicts` lists at most this many. `conflict_count` is the true number. */
export const MAX_CONFLICTS_LISTED = 20;

/** What `copy` does with a name already taken in the destination. Absent means {@link ON_CONFLICT_FAIL}. */
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
 * The shape only. The rules for each name, which depend on the device's OS, are checked by the delete
 * itself. Not strict, so the dashboard can add fields.
 */
export const FileDeleteRequestSchema = z.object({
    directory: z.string(),
    names: z.array(z.string()).min(1).max(MAX_DELETE_NAMES),
});

export type FileDeleteRequest = z.infer<typeof FileDeleteRequestSchema>;

/** The shape only, as for `delete`: the name's rules depend on the device's OS. Not strict. */
export const FileMkdirRequestSchema = z.object({
    directory: z.string(),
    name: z.string(),
});

export type FileMkdirRequest = z.infer<typeof FileMkdirRequestSchema>;

/**
 * The shape only, as for `delete`: the rules for each name depend on the device's OS. `new_name` with more
 * than 1 name is refused by the copy itself. Not strict.
 */
export const FileCopyRequestSchema = z.object({
    source_directory: z.string(),
    names: z.array(z.string()).min(1).max(MAX_COPY_NAMES),
    destination_directory: z.string(),
    on_conflict: z.enum([ON_CONFLICT_FAIL, ON_CONFLICT_SKIP, ON_CONFLICT_KEEP_BOTH, ON_CONFLICT_REPLACE]).optional(),
    new_name: z.string().optional(),
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
    error: {
        code: string;
        message: string;
        /** A `copy` refused with `file_exists`: how many names are taken. */
        conflict_count?: number;
        /** A `copy` refused with `file_exists`: the first taken names, as the request sent them. */
        conflicts?: string[];
    };
}

/** 1 name a delete or a copy could not finish, and why. */
export interface FileOperationFailure {
    name: string;
    error: { code: string; message: string };
}

/** The answer of a delete or a copy that ran. */
export interface FileOperationAnswer {
    completed_count: number;
    /** A copy only: names left alone by `on_conflict: skip`. */
    skipped_count?: number;
    failed_count: number;
    /** The first failures, at most {@link MAX_FAILURES_LISTED}, cut further to fit the frame. Absent when none. */
    failed?: FileOperationFailure[];
}

/** The `progress` payload. */
export interface FileProgress {
    /** Names from the request finished: deleted, copied, skipped or failed. */
    items_done: number;
    items_total: number;
    /** Files, folders and links removed or made so far, across every name. */
    files_done: number;
    /** A copy only: bytes written so far, across every name. */
    bytes_done?: number;
    /** A copy only, once it has counted: files, folders and links in every name. */
    files_total?: number;
    /** A copy only, once it has counted: bytes in every name. */
    bytes_total?: number;
    /** The name from the request being worked on. */
    current_name: string;
}

export type FileListResult = FileListAnswer | FileError;

export type FileStatResult = FileStatAnswer | FileError;

export type FileDeleteResult = FileOperationAnswer | FileError;

export type FileCopyResult = FileOperationAnswer | FileError;

/** The new folder's path, joined with the device's own separator. */
export interface FileMkdirAnswer {
    path: string;
}

export type FileMkdirResult = FileMkdirAnswer | FileError;

export function fileError(code: string, message: string): FileError {
    return { error: { code, message } };
}
