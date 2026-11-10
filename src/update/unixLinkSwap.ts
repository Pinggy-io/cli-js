/**
 * Installs a version beside the old one on macOS and Linux, then moves 1 symlink.
 *
 *   ~/.pinggy/bin/pinggy -> ~/.pinggy/versions/0.6.5/pinggy   (the link this file moves)
 *   ~/.pinggy/versions/0.6.4/pinggy
 *   ~/.pinggy/versions/0.6.5/pinggy
 *
 * No step touches a running binary. A packaged process reads its snapshot through a file descriptor opened at startup,
 * so it keeps working after its file is unlinked. It cannot start a new process from that path, which is why
 * `getDaemonSpawnArgs()` falls back to the link.
 */
import fs from "node:fs";
import path from "node:path";
import { getDaemonInfo, isProcessAlive } from "../daemon/lifecycle/daemonManager.js";
import { readServiceEntryText } from "../daemon/lifecycle/serviceInstaller.js";
import { UpdateError, UpdateErrorCode } from "./binaryUpdater.js";
import { UnixLayoutPaths } from "./installKind.js";
import { isNewerVersion, parseVersion } from "./latestRelease.js";
import { writeUpdateState } from "./updateState.js";
import { errorMessage } from "../utils/util.js";
import { RollbackResult } from "./windowsSwap.js";

const BINARY_NAME = "pinggy";
const DOWNLOAD_PREFIX = "pinggy.download.";
const CONVERT_PREFIX = "pinggy.convert.";
const LINK_TEMP_PREFIX = "pinggy.link.";
const EXECUTABLE_MODE = 0o755;

export interface UnixSwapEnvironment {
    fsyncFile(filePath: string): void;
    fsyncDirectory(directory: string): void;
    /** The version a live daemon reports, whose file must stay. */
    daemonVersion(): string | undefined;
    serviceEntryText(): string;
    isAlive(pid: number): boolean;
}

function fsyncPath(target: string, flags: string): void {
    const fileDescriptor = fs.openSync(target, flags);
    try {
        fs.fsyncSync(fileDescriptor);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

const realUnixSwapEnvironment: UnixSwapEnvironment = {
    fsyncFile: (filePath) => fsyncPath(filePath, "r+"),
    fsyncDirectory: (directory) => fsyncPath(directory, "r"),
    daemonVersion: () => getDaemonInfo()?.cliVersion,
    serviceEntryText: readServiceEntryText,
    isAlive: isProcessAlive,
};

export function unixDownloadPath(layout: UnixLayoutPaths): string {
    return path.posix.join(layout.versionsDirectory, `${DOWNLOAD_PREFIX}${process.pid}`);
}

function versionDirectory(layout: UnixLayoutPaths, version: string): string {
    return path.posix.join(layout.versionsDirectory, version);
}

export function versionBinaryPath(layout: UnixLayoutPaths, version: string): string {
    return path.posix.join(versionDirectory(layout, version), BINARY_NAME);
}

/** @returns the version the link points at, or null for a plain file or no link */
export function readLinkVersion(layout: UnixLayoutPaths): string | null {
    try {
        const version = path.posix.basename(path.posix.dirname(fs.readlinkSync(layout.link)));
        return parseVersion(version) ? version : null;
    } catch {
        return null;
    }
}

function installedVersions(layout: UnixLayoutPaths): string[] {
    return fs.readdirSync(layout.versionsDirectory).filter((name) => parseVersion(name) !== null);
}

function highestVersionBelow(layout: UnixLayoutPaths, ceiling: string): string | null {
    const lower = installedVersions(layout).filter((version) => isNewerVersion(ceiling, version));
    return lower.reduce<string | null>((best, version) => (best === null || isNewerVersion(version, best) ? version : best), null);
}

/** `ln -sf` is not acceptable here: it removes the old link before it creates the new one. */
function moveLink(layout: UnixLayoutPaths, version: string, environment: UnixSwapEnvironment): void {
    fs.mkdirSync(layout.binDirectory, { recursive: true });
    const temporaryLink = path.posix.join(layout.binDirectory, `${LINK_TEMP_PREFIX}${process.pid}`);
    fs.rmSync(temporaryLink, { force: true });
    fs.symlinkSync(versionBinaryPath(layout, version), temporaryLink);
    fs.renameSync(temporaryLink, layout.link);
    environment.fsyncDirectory(layout.binDirectory);
}

function convertPlainFile(layout: UnixLayoutPaths, execPath: string, runningVersion: string, environment: UnixSwapEnvironment): void {
    const temporaryPath = path.posix.join(layout.versionsDirectory, `${CONVERT_PREFIX}${process.pid}`);
    fs.copyFileSync(execPath, temporaryPath);
    fs.chmodSync(temporaryPath, EXECUTABLE_MODE);
    environment.fsyncFile(temporaryPath);
    fs.mkdirSync(versionDirectory(layout, runningVersion), { recursive: true });
    fs.renameSync(temporaryPath, versionBinaryPath(layout, runningVersion));
    environment.fsyncDirectory(versionDirectory(layout, runningVersion));
}

function isNamedByService(layout: UnixLayoutPaths, version: string, environment: UnixSwapEnvironment): boolean {
    return environment.serviceEntryText().includes(versionBinaryPath(layout, version));
}

function removeDeadProcessTemp(directory: string, prefix: string, environment: UnixSwapEnvironment): void {
    for (const name of fs.readdirSync(directory)) {
        const pidText = name.startsWith(prefix) ? name.slice(prefix.length) : "";
        if (/^\d+$/.test(pidText) && !environment.isAlive(Number(pidText))) {
            fs.rmSync(path.posix.join(directory, name), { force: true });
        }
    }
}

/** A killed updater leaves a 59 MB file behind, and nothing else would remove it. Every failure is ignored. */
export function removeStaleUnixFiles(layout: UnixLayoutPaths, environment: UnixSwapEnvironment = realUnixSwapEnvironment): void {
    const locations: [string, string][] = [
        [layout.versionsDirectory, DOWNLOAD_PREFIX],
        [layout.versionsDirectory, CONVERT_PREFIX],
        [layout.binDirectory, LINK_TEMP_PREFIX],
    ];
    for (const [directory, prefix] of locations) {
        try {
            removeDeadProcessTemp(directory, prefix, environment);
        } catch {
            // The folder does not exist yet, or a file is in use. A later run tries again.
        }
    }
}

/** Keeps the link target, the next highest version, the daemon's version, and any version a service entry names. */
export function pruneVersions(layout: UnixLayoutPaths, environment: UnixSwapEnvironment = realUnixSwapEnvironment): void {
    removeStaleUnixFiles(layout, environment);
    const target = readLinkVersion(layout);
    if (target === null) return;
    const keep = new Set([target, highestVersionBelow(layout, target), environment.daemonVersion()]);
    for (const version of installedVersions(layout)) {
        if (keep.has(version) || isNamedByService(layout, version, environment)) continue;
        fs.rmSync(versionDirectory(layout, version), { recursive: true, force: true });
    }
}

export interface InstallVersionRequest {
    layout: UnixLayoutPaths;
    /** The running plain file at the link path, for a first update from before the layout. */
    plainFileToConvert: string | null;
    runningVersion: string;
    newVersion: string;
}

function replaceFailure(layout: UnixLayoutPaths, error: unknown, running: string): UpdateError {
    return new UpdateError(
        UpdateErrorCode.RenameFailed,
        `Could not replace ${layout.link}: ${errorMessage(error)}. pinggy ${running} is unchanged.`,
    );
}

/** Takes a download that already passed `downloadAndVerify()`. */
export function installVersion(request: InstallVersionRequest, environment: UnixSwapEnvironment = realUnixSwapEnvironment): void {
    const { layout, plainFileToConvert, runningVersion, newVersion } = request;
    try {
        fs.mkdirSync(layout.versionsDirectory, { recursive: true });
        if (plainFileToConvert !== null) convertPlainFile(layout, plainFileToConvert, runningVersion, environment);
        fs.mkdirSync(versionDirectory(layout, newVersion), { recursive: true });
        fs.renameSync(unixDownloadPath(layout), versionBinaryPath(layout, newVersion));
        environment.fsyncDirectory(versionDirectory(layout, newVersion));
        moveLink(layout, newVersion, environment);
    } catch (error) {
        throw replaceFailure(layout, error, runningVersion);
    }
    try {
        pruneVersions(layout, environment);
    } catch {
        // The update is done. A later prune tries again.
    }
}

export function nothingToRollBack(): UpdateError {
    return new UpdateError(UpdateErrorCode.NothingToRollBack, "No previous version to go back to.");
}

function previousVersion(layout: UnixLayoutPaths, current: string): string {
    try {
        const version = highestVersionBelow(layout, current);
        if (version !== null) return version;
    } catch {
        // No versions folder.
    }
    throw nothingToRollBack();
}

/** Removes the version it leaves, so a later update and rollback cannot pick the bad version again. */
export function rollbackUnixVersion(layout: UnixLayoutPaths, environment: UnixSwapEnvironment = realUnixSwapEnvironment): RollbackResult {
    const current = readLinkVersion(layout);
    if (current === null) throw nothingToRollBack();
    const previous = previousVersion(layout, current);
    try {
        moveLink(layout, previous, environment);
    } catch (error) {
        throw replaceFailure(layout, error, current);
    }
    writeUpdateState({ rolledBackFromVersion: current });
    if (environment.daemonVersion() !== current && !isNamedByService(layout, current, environment)) {
        fs.rmSync(versionDirectory(layout, current), { recursive: true, force: true });
    }
    return { from: current, to: previous };
}
