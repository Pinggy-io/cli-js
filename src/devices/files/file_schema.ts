import { z } from "zod";

/**
 * Frames and payloads for the `file` channel: the file manager on the device page.
 *
 * 1 op, `list`: 1 page of 1 folder, answered on the request's own id and op. The agent keeps nothing
 * between 2 requests. Sorting and the hidden filter run here, over the whole folder, because the
 * browser only ever holds the pages it asked for.
 */
export const CHANNEL_FILE = "file";

export const OP_LIST = "list";

export const ERROR_INVALID_PAYLOAD = "invalid_payload";
export const ERROR_UNSUPPORTED_OP = "unsupported_op";
/** The last `welcome` did not say `file_manager_enabled: true`. */
export const ERROR_FILE_MANAGER_DISABLED = "file_manager_disabled";
/** Relative, a NUL byte, or longer than {@link MAX_PATH_BYTES}. */
export const ERROR_INVALID_PATH = "invalid_path";
export const ERROR_PATH_NOT_FOUND = "path_not_found";
export const ERROR_NOT_A_DIRECTORY = "not_a_directory";
export const ERROR_PERMISSION_DENIED = "permission_denied";
/** The folder read took longer than the handler waits, usually a network drive that stopped answering. */
export const ERROR_FILE_TIMEOUT = "file_timeout";
export const ERROR_FILE_OPERATION_FAILED = "file_operation_failed";

export const SORT_BY_NAME = "name";
export const SORT_BY_SIZE = "size";
export const SORT_BY_MODIFIED = "modified";
export const SORT_ORDER_ASC = "asc";
export const SORT_ORDER_DESC = "desc";

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 500;
export const MAX_PATH_BYTES = 4096;

/**
 * Every field is optional, and an absent field takes its default here, never on the dashboard: only
 * this side knows the home folder. A present field must be valid. `path: ""` is a string, so it passes
 * this schema and fails the absolute-path check as `invalid_path`.
 */
export const FileListRequestSchema = z.object({
    path: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    sort_by: z.enum([SORT_BY_NAME, SORT_BY_SIZE, SORT_BY_MODIFIED]).optional(),
    sort_order: z.enum([SORT_ORDER_ASC, SORT_ORDER_DESC]).optional(),
    include_hidden: z.boolean().optional(),
});

export type FileListRequest = z.infer<typeof FileListRequestSchema>;

export type FileEntryType = "file" | "directory" | "symlink" | "other" | "unknown";

/** What a symlink points at. `missing` is a broken link. */
export type FileTargetType = "file" | "directory" | "other" | "missing";

/** 1 row. Only `name` and `type` are always present. A field with no value is left off, never null. */
export interface FileEntry {
    name: string;
    type: FileEntryType;
    modified_at?: number;
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

export interface FileError {
    error: { code: string; message: string };
}

export type FileListResult = FileListAnswer | FileError;

export function fileError(code: string, message: string): FileError {
    return { error: { code, message } };
}
