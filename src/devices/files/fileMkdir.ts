import {
    ERROR_FILE_EXISTS, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT, ERROR_INVALID_NAME, ERROR_INVALID_PATH,
    ERROR_INVALID_PAYLOAD, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED, FileError,
    FileMkdirRequest, FileMkdirResult, fileError,
} from "./file_schema.js";
import {
    FileCallTimeoutError, FileSystemMaker, callWithTimeout, errorCodeOf, failureMessage, nameProblem, pathProblem,
    pathsFor,
} from "./fileSystem.js";

/**
 * `file/mkdir`: 1 new, empty folder named `name` in `directory`.
 *
 * 1 `mkdir`, not recursive. A missing `directory` is `path_not_found`, and a name already taken, by a file or a
 * folder, is `file_exists` with nothing changed. On macOS and Windows a name that differs only in letter case is
 * taken too. Nothing is protected: making a folder removes nothing, so the OS permissions decide. The folder gets
 * the OS default mode, `0o777` less the umask, and the agent's user as its owner.
 *
 * `name` follows `delete`'s rule for a name, so it is never a path. On Windows, a name holding `: * ? " < > |`,
 * a device name such as `CON` or `con.txt`, or a name ending in a dot or a space is `invalid_name`, before the
 * disk is touched.
 *
 * Nothing here logs a path.
 */

export interface MkdirDependencies {
    maker: FileSystemMaker;
    /** Picks the path rules and the Windows name rules. */
    platform: NodeJS.Platform;
    callTimeoutMillis: number;
}

const WINDOWS_FORBIDDEN_CHARACTERS = /[:*?"<>|]/;
const WINDOWS_TRAILING_DOT_OR_SPACE = /[. ]$/;
const WINDOWS_NUMBERED_DEVICES = ["COM", "LPT"];
const WINDOWS_DEVICE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Reserved with any extension: `con.txt` and `NUL.tar.gz` are the device too. */
const WINDOWS_DEVICE_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    ...WINDOWS_NUMBERED_DEVICES.flatMap((device) => WINDOWS_DEVICE_NUMBERS.map((number) => `${device}${number}`)),
]);
const EXTENSION_SEPARATOR = ".";

const MESSAGE_NAME_TAKEN = "A file or folder with this name already exists.";
const MESSAGE_MKDIR_FAILED = "The folder could not be made.";

/** Null when `name` follows Windows' naming rules. Letter case does not matter to them, so `con` is `CON`. */
export function windowsNameProblem(name: string): string | null {
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(name)) {
        return "A folder name on Windows cannot hold : * ? \" < > |";
    }
    if (WINDOWS_TRAILING_DOT_OR_SPACE.test(name)) {
        return "A folder name on Windows cannot end with a dot or a space.";
    }
    const stem = name.split(EXTENSION_SEPARATOR)[0].toUpperCase();
    if (WINDOWS_DEVICE_NAMES.has(stem)) {
        return `${stem} is a device name on Windows.`;
    }
    return null;
}

/** Carries out 1 `file/mkdir`. Never throws: every failure is an error answer, and none has made a folder. */
export async function makeFolder(request: FileMkdirRequest, dependencies: MkdirDependencies):
    Promise<FileMkdirResult> {
    const { maker, platform, callTimeoutMillis } = dependencies;
    const nameIssue = nameProblem(request.name, platform);
    if (nameIssue) {
        return fileError(ERROR_INVALID_PAYLOAD, nameIssue);
    }
    if (platform === "win32") {
        const windowsIssue = windowsNameProblem(request.name);
        if (windowsIssue) {
            return fileError(ERROR_INVALID_NAME, windowsIssue);
        }
    }
    const paths = pathsFor(platform);
    const directoryIssue = pathProblem(request.directory, paths);
    if (directoryIssue) {
        return fileError(ERROR_INVALID_PATH, directoryIssue);
    }
    const target = paths.join(paths.resolve(request.directory), request.name);
    const targetIssue = pathProblem(target, paths);
    if (targetIssue) {
        return fileError(ERROR_INVALID_PATH, targetIssue);
    }

    try {
        await callWithTimeout(maker.mkdir(target), callTimeoutMillis);
    } catch (err) {
        return mkdirFailure(err);
    }
    return { path: target };
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
