/**
 * Replaces a Windows binary. A running .exe cannot be overwritten, but it can be renamed.
 *
 * Every file stays in the folder of `execPath`, because a rename works only within 1 drive, and the live name comes from
 * `execPath`, so a binary saved under another name keeps it.
 */
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "../daemon/lifecycle/daemonManager.js";
import { PinggyBinaryRunner, readBinaryVersion, UpdateError, UpdateErrorCode } from "./binaryUpdater.js";
import { errorMessage } from "../utils/util.js";

const WINDOWS_PATH = path.win32;
const BACKUP_MARKER = ".prev";
const NEW_FILE_SUFFIX = ".new.exe";
const OLD_FILE_SUFFIX = ".old";
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_INTERVAL_MILLIS = 250;
const RENAME_RETRY_LIMIT_MILLIS = 10_000;
const POST_SWAP_WAIT_MILLIS = 2_000;
const INSTALL_COMMAND = "irm https://pinggy.io/install.ps1 | iex";

export interface WindowsInstallPaths {
    directory: string;
    livePath: string;
    liveName: string;
    backupPath: string;
    runningFromBackup: boolean;
}

export interface WindowsFileOperations {
    exists(filePath: string): boolean;
    copyFile(from: string, to: string): void;
    rename(from: string, to: string): void;
    sleepMillis(millis: number): void;
    nowMillis(): number;
}

export const realWindowsFileOperations: WindowsFileOperations = {
    exists: (filePath) => fs.existsSync(filePath),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    rename: (from, to) => fs.renameSync(from, to),
    // Synchronous, so no other JavaScript runs between the 2 renames of a swap.
    sleepMillis: (millis) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis); },
    nowMillis: () => Date.now(),
};

export function windowsInstallPaths(execPath: string): WindowsInstallPaths {
    const directory = WINDOWS_PATH.dirname(execPath);
    const { name, ext, base } = WINDOWS_PATH.parse(execPath);
    if (name.endsWith(BACKUP_MARKER)) {
        const liveName = `${name.slice(0, -BACKUP_MARKER.length)}${ext}`;
        return { directory, liveName, livePath: WINDOWS_PATH.join(directory, liveName), backupPath: execPath, runningFromBackup: true };
    }
    const backupName = `${name}${BACKUP_MARKER}${ext}`;
    return { directory, liveName: base, livePath: execPath, backupPath: WINDOWS_PATH.join(directory, backupName), runningFromBackup: false };
}

export function windowsDownloadPath(execPath: string): string {
    return `${execPath}.${process.pid}${NEW_FILE_SUFFIX}`;
}

/** A scanner can hold a new .exe open for a moment after it runs. */
function renameWithRetry(operations: WindowsFileOperations, from: string, to: string): void {
    const attempts = Math.ceil(RENAME_RETRY_LIMIT_MILLIS / RENAME_RETRY_INTERVAL_MILLIS);
    for (let attempt = 0; ; attempt++) {
        try {
            operations.rename(from, to);
            return;
        } catch (error) {
            const retryable = RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "");
            if (!retryable || attempt >= attempts) throw error;
            operations.sleepMillis(RENAME_RETRY_INTERVAL_MILLIS);
        }
    }
}

/** Without this the live name stays empty, and no pinggy process can start to repair it. */
function restoreLiveFile(operations: WindowsFileOperations, paths: WindowsInstallPaths, oldPath: string): void {
    try {
        renameWithRetry(operations, oldPath, paths.livePath);
        return;
    } catch {
        // The backup copy does not depend on the .old file.
    }
    try {
        operations.copyFile(paths.backupPath, paths.livePath);
    } catch {
        throw new UpdateError(
            UpdateErrorCode.RestoreFailed,
            `Could not restore ${paths.livePath}. The old binary is at ${oldPath}. Run: ${INSTALL_COMMAND}`,
        );
    }
}

function renameFailure(livePath: string, error: unknown, running: string): UpdateError {
    return new UpdateError(
        UpdateErrorCode.RenameFailed,
        `Could not replace ${livePath}: ${errorMessage(error)}. pinggy ${running} is unchanged.`,
    );
}

function oldFilePath(livePath: string, operations: WindowsFileOperations): string {
    return `${livePath}.${operations.nowMillis()}${OLD_FILE_SUFFIX}`;
}

export interface WindowsSwapRequest {
    execPath: string;
    downloadPath: string;
    newVersion: string;
    runningVersion: string;
}

export async function swapWindowsBinary(
    request: WindowsSwapRequest,
    operations: WindowsFileOperations,
    runBinary: PinggyBinaryRunner,
): Promise<void> {
    const { downloadPath, newVersion, runningVersion } = request;
    const paths = windowsInstallPaths(request.execPath);
    const oldPath = oldFilePath(paths.livePath, operations);

    try {
        operations.copyFile(paths.livePath, paths.backupPath);
        renameWithRetry(operations, paths.livePath, oldPath);
    } catch (error) {
        throw renameFailure(paths.livePath, error, runningVersion);
    }
    try {
        renameWithRetry(operations, downloadPath, paths.livePath);
    } catch (error) {
        restoreLiveFile(operations, paths, oldPath);
        throw renameFailure(paths.livePath, error, runningVersion);
    }

    // A scanner can remove the new file after both renames succeed.
    operations.sleepMillis(POST_SWAP_WAIT_MILLIS);
    const reported = await readBinaryVersion(paths.livePath, runBinary).catch(() => null);
    if (reported !== newVersion) {
        restoreLiveFile(operations, paths, oldPath);
        throw new UpdateError(
            UpdateErrorCode.PostSwapFailed,
            `The new binary did not run after the update. pinggy ${runningVersion} is restored.`,
        );
    }
}

export interface WindowsRollbackRequest {
    execPath: string;
    runningVersion: string;
    /** The fallback for the version being left, when running from the backup and the live file does not run. */
    latestVersion: string | undefined;
}

export interface RollbackResult {
    from: string;
    to: string;
}

async function versionBeingLeft(
    request: WindowsRollbackRequest,
    paths: WindowsInstallPaths,
    runBinary: PinggyBinaryRunner,
): Promise<string> {
    if (!paths.runningFromBackup) return request.runningVersion;
    const reported = await readBinaryVersion(paths.livePath, runBinary).catch(() => null);
    return reported ?? request.latestVersion ?? "the newer version";
}

function nothingToRollBack(): UpdateError {
    return new UpdateError(UpdateErrorCode.NothingToRollBack, "No previous version to go back to.");
}

export async function rollbackWindowsBinary(
    request: WindowsRollbackRequest,
    operations: WindowsFileOperations,
    runBinary: PinggyBinaryRunner,
): Promise<RollbackResult> {
    const paths = windowsInstallPaths(request.execPath);
    if (!operations.exists(paths.backupPath)) throw nothingToRollBack();
    const to = await readBinaryVersion(paths.backupPath, runBinary).catch(() => null);
    if (to === null) throw nothingToRollBack();
    const from = await versionBeingLeft(request, paths, runBinary);

    const oldPath = oldFilePath(paths.livePath, operations);
    const liveExists = operations.exists(paths.livePath);
    try {
        if (liveExists) renameWithRetry(operations, paths.livePath, oldPath);
    } catch (error) {
        throw renameFailure(paths.livePath, error, from);
    }
    try {
        renameWithRetry(operations, paths.backupPath, paths.livePath);
    } catch (error) {
        if (liveExists) renameWithRetry(operations, oldPath, paths.livePath);
        throw renameFailure(paths.livePath, error, from);
    }
    return { from, to };
}

export interface StaleFileOperations {
    list(directory: string): string[];
    remove(filePath: string): void;
    isAlive(pid: number): boolean;
}

const realStaleFileOperations: StaleFileOperations = {
    list: (directory) => fs.readdirSync(directory),
    remove: (filePath) => fs.rmSync(filePath, { force: true }),
    isAlive: isProcessAlive,
};

/**
 * A `.new.exe` goes only when the pid in its name is dead. libuv opens files with FILE_SHARE_DELETE, so without the
 * check a `pinggy ps` deletes a download in progress. Names match by literal prefix and suffix, never a glob, because
 * a live name can be `pinggy (1).exe`.
 */
function isRemovableStaleFile(fileName: string, liveName: string, operations: StaleFileOperations): boolean {
    const prefix = `${liveName}.`;
    if (!fileName.startsWith(prefix)) return false;
    if (fileName.endsWith(OLD_FILE_SUFFIX)) return true;
    if (!fileName.endsWith(NEW_FILE_SUFFIX)) return false;
    const pidText = fileName.slice(prefix.length, -NEW_FILE_SUFFIX.length);
    return /^\d+$/.test(pidText) && !operations.isAlive(Number(pidText));
}

/** A locked file stays until a later start. Every failure is ignored. */
export function removeStaleUpdateFiles(
    execPath: string = process.execPath,
    operations: StaleFileOperations = realStaleFileOperations,
): void {
    const directory = WINDOWS_PATH.dirname(execPath);
    const liveName = WINDOWS_PATH.basename(execPath);
    let fileNames: string[];
    try {
        fileNames = operations.list(directory);
    } catch {
        return;
    }
    for (const fileName of fileNames) {
        try {
            if (isRemovableStaleFile(fileName, liveName, operations)) operations.remove(WINDOWS_PATH.join(directory, fileName));
        } catch {
            // Still locked. A later start tries again.
        }
    }
}
