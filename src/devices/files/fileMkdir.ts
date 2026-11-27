import {
    ERROR_FILE_EXISTS, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_NAME, ERROR_INVALID_PATH,
    ERROR_INVALID_PAYLOAD, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, FileError,
    FileMkdirRequest, FileMkdirResult, fileError,
} from "./file_schema.js";
import {
    FileCallTimeoutError, FileSystemMaker, MESSAGE_NAME_TAKEN, callWithTimeout, errorCodeOf, failureMessage, isRoot,
    nameProblem, pathProblem, pathsFor, resolvedItem, windowsNameProblem, withTrimmedName,
} from "./fileSystem.js";

/**
 * `file/mkdir`: 1 new, empty folder at `path`.
 *
 * 1 `mkdir`, not recursive. A missing parent folder is `path_not_found`, and a path already taken, by a file or a
 * folder, is `file_exists` with nothing changed. On macOS and Windows a name that differs only in letter case is
 * taken too. Nothing is protected: making a folder removes nothing, so the OS permissions decide. The folder gets
 * the OS default mode, `0o777` less the umask, and the agent's user as its owner.
 *
 * The last part of `path` loses the white space at both ends (`withTrimmedName`), then follows {@link nameProblem}:
 * `" reports "` makes `reports`, and a name of only spaces is empty. The folders above keep theirs. On Windows, a
 * name holding `: * ? " < > |`, a device name such as `CON` or `con.txt`, or a name ending in a dot is
 * `invalid_name`, before the disk is touched (`windowsNameProblem`). A root has no name, and the OS answers that it
 * exists.
 *
 * Nothing here logs a path.
 */

export interface MkdirDependencies {
    maker: FileSystemMaker;
    /** Picks the path rules and the Windows name rules. */
    platform: NodeJS.Platform;
    callTimeoutMillis: number;
}

const MESSAGE_MKDIR_FAILED = "The folder could not be made.";

/** Carries out 1 `file/mkdir`. Never throws: every failure is an error answer, and none has made a folder. */
export async function makeFolder(request: FileMkdirRequest, dependencies: MkdirDependencies):
    Promise<FileMkdirResult> {
    const { maker, platform, callTimeoutMillis } = dependencies;
    const paths = pathsFor(platform);
    const pathIssue = pathProblem(request.path, paths);
    if (pathIssue) {
        return fileError(ERROR_INVALID_PATH, pathIssue);
    }
    const item = withTrimmedName(resolvedItem(request.path, paths));
    if (!isRoot(item.path, paths)) {
        const nameIssue = nameProblem(item.name, platform);
        if (nameIssue) {
            return fileError(ERROR_INVALID_PAYLOAD, nameIssue);
        }
        const windowsIssue = platform === "win32" ? windowsNameProblem(item.name) : null;
        if (windowsIssue) {
            return fileError(ERROR_INVALID_NAME, windowsIssue);
        }
    }

    try {
        await callWithTimeout(maker.mkdir(item.path), callTimeoutMillis);
    } catch (err) {
        return mkdirFailure(err);
    }
    return { path: item.path };
}

/** A failed `mkdir`, by its errno. The message is Node's own, which names the path, cleaned and cut. */
function mkdirFailure(err: unknown): FileError {
    if (err instanceof FileCallTimeoutError) {
        return fileError(ERROR_FILE_TIMEOUT, err.message);
    }
    const message = failureMessage(err, MESSAGE_MKDIR_FAILED);
    switch (errorCodeOf(err)) {
        case "EEXIST":
            return fileError(ERROR_FILE_EXISTS, MESSAGE_NAME_TAKEN);
        case "ENOENT":
            return fileError(ERROR_PATH_NOT_FOUND, message);
        case "ENOTDIR":
            return fileError(ERROR_NOT_A_DIRECTORY, message);
        case "EACCES":
        case "EPERM":
        case "EROFS":
            return fileError(ERROR_PERMISSION_DENIED, message);
        default:
            return fileError(ERROR_FILE_OPERATION_FAILED, message);
    }
}
