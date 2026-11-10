/**
 * The detached process: checks for a release, downloads it, swaps it in.
 *
 * It has no terminal and prints nothing. Any error goes to update.log and ends the process.
 */
import fs from "node:fs";
import os from "node:os";
import { daemonIpcVersion, getDaemonInfo } from "../daemon/lifecycle/daemonManager.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";
import { ensurePinggyLogDir, getUpdateLogPath } from "../utils/configDir.js";
import { errorMessage, getVersion } from "../utils/util.js";
import { createUpdateTarget, downloadRelease, UpdateTarget } from "./applyUpdate.js";
import { assetNameFor, readBinaryIpcVersion, removeQuietly, runPinggyBinary, UpdateError } from "./binaryUpdater.js";
import { backgroundInstallKind, canReplaceItself, createInstallProbe, detectInstallKind, InstallKind, unixLayoutPaths } from "./installKind.js";
import { isNewerVersion, isReleaseComplete, resolveLatestNpmVersion, resolveLatestTag, versionFromTag } from "./latestRelease.js";
import { removeStaleUnixFiles } from "./unixLinkSwap.js";
import { acquireUpdateLock, isUpdateLockOurs, releaseUpdateLock } from "./updateLock.js";
import { nowEpochSeconds, readUpdateState, recordLatestVersion, UpdateState, writeUpdateState } from "./updateState.js";
import { removeStaleUpdateFiles } from "./windowsSwap.js";

const TIME_LIMIT_MILLIS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MILLIS = 15_000;
const CHECK_INTERVAL_SECONDS = 24 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 3;

export interface UpdateChildEnvironment {
    kind: InstallKind;
    target: UpdateTarget | null;
    runningVersion: string;
    nowEpochSeconds(): number;
    acquireLock(): Promise<boolean>;
    releaseLock(): void;
    isLockOurs(): boolean;
    readState(): UpdateState;
    writeState(patch: UpdateState): boolean;
    recordLatestVersion(version: string): boolean;
    resolveTag(): Promise<string>;
    resolveNpmVersion(): Promise<string>;
    isReleaseComplete(tag: string): Promise<boolean>;
    download(target: UpdateTarget, tag: string): Promise<void>;
    readIpcVersion(binaryPath: string): Promise<number>;
    liveDaemon(): DaemonInfo | null;
    removeStaleFiles(): void;
    removeFile(filePath: string): void;
    startLog(): void;
    log(line: string): void;
    startTimeLimit(onLimit: () => void): () => void;
    exitProcess(): void;
}

function checkedRecently(state: UpdateState, now: number): boolean {
    const last = state.lastCheckEpochSeconds;
    return last !== undefined && last <= now && now - last < CHECK_INTERVAL_SECONDS;
}

function saveCheckTime(environment: UpdateChildEnvironment): void {
    environment.writeState({ lastCheckEpochSeconds: environment.nowEpochSeconds() });
}

/** @returns null after a failed lookup, which writes nothing, so the 1-hour gate sets the next attempt */
async function latestVersionAndTag(environment: UpdateChildEnvironment): Promise<{ tag: string; latest: string } | null> {
    try {
        if (environment.kind === InstallKind.Npm) {
            const latest = await environment.resolveNpmVersion();
            return { tag: `v${latest}`, latest };
        }
        const tag = await environment.resolveTag();
        return { tag, latest: versionFromTag(tag) };
    } catch (error) {
        environment.log(`Could not find the latest version: ${errorMessage(error)}`);
        return null;
    }
}

async function releaseIsReady(tag: string, environment: UpdateChildEnvironment): Promise<boolean> {
    if (environment.kind === InstallKind.Npm) return true;
    try {
        if (await environment.isReleaseComplete(tag)) return true;
        environment.log(`Release ${tag} has no SHA256SUMS yet`);
    } catch (error) {
        environment.log(`Could not check release ${tag}: ${errorMessage(error)}`);
    }
    return false;
}

function daemonStillDiffers(state: UpdateState, environment: UpdateChildEnvironment): boolean {
    const daemon = environment.liveDaemon();
    return daemon !== null && daemonIpcVersion(daemon) !== state.deferredIpcVersion;
}

function skipReason(latest: string, state: UpdateState, environment: UpdateChildEnvironment): string | null {
    if (!canReplaceItself(environment.kind) || environment.target === null) return "this install cannot update itself";
    if (latest === state.rolledBackFromVersion) return "the user rolled back from this version";
    if (latest === state.failedVersion && (state.failedAttempts ?? 0) >= MAX_FAILED_ATTEMPTS) return "this version failed too many times";
    if (latest === state.deferredVersion && daemonStillDiffers(state, environment)) return "a live daemon still needs a restart first";
    return null;
}

function countFailure(latest: string, environment: UpdateChildEnvironment): void {
    const state = environment.readState();
    const attempts = state.failedVersion === latest ? (state.failedAttempts ?? 0) + 1 : 1;
    environment.writeState({ failedVersion: latest, failedAttempts: attempts });
}

/** @returns false when the verified file must not be installed now */
async function holdForLiveDaemon(latest: string, target: UpdateTarget, environment: UpdateChildEnvironment): Promise<boolean> {
    const newIpcVersion = await environment.readIpcVersion(target.downloadPath);
    const daemon = environment.liveDaemon();
    if (daemon === null || daemonIpcVersion(daemon) === newIpcVersion) return false;
    environment.writeState({ deferredVersion: latest, deferredIpcVersion: newIpcVersion });
    environment.log(`Held ${latest}: the running daemon speaks IPC v${daemonIpcVersion(daemon)}, this release v${newIpcVersion}`);
    return true;
}

function lostTheRight(latest: string, environment: UpdateChildEnvironment): boolean {
    return !environment.isLockOurs() || environment.readState().rolledBackFromVersion === latest;
}

const Outcome = {
    Finished: "finished",
    TryAgainSoon: "try-again-soon",
} as const;
type Outcome = typeof Outcome[keyof typeof Outcome];

async function installRelease(
    release: { tag: string; latest: string },
    installed: string,
    target: UpdateTarget,
    environment: UpdateChildEnvironment,
): Promise<Outcome> {
    const { tag, latest } = release;
    try {
        await environment.download(target, tag);
        if (await holdForLiveDaemon(latest, target, environment)) return Outcome.Finished;
        if (lostTheRight(latest, environment)) {
            environment.log("Stopped before the swap: the lock was lost, or the user rolled back");
            return Outcome.TryAgainSoon;
        }
        await target.install({ newVersion: latest, runningVersion: environment.runningVersion });
        environment.writeState({
            updatedFromVersion: installed,
            updatedToVersion: latest,
            failedVersion: undefined,
            failedAttempts: undefined,
            deferredVersion: undefined,
            deferredIpcVersion: undefined,
        });
        environment.log(`Updated ${installed} to ${latest}`);
    } catch (error) {
        if (error instanceof UpdateError && error.countsAsBadRelease) countFailure(latest, environment);
        environment.log(`Update to ${latest} failed: ${errorMessage(error)}`);
    } finally {
        environment.removeFile(target.downloadPath);
    }
    return Outcome.Finished;
}

async function runLocked(environment: UpdateChildEnvironment): Promise<void> {
    environment.startLog();
    if (checkedRecently(environment.readState(), environment.nowEpochSeconds())) {
        environment.log("Another update checked within the last 24 hours");
        return;
    }
    const release = await latestVersionAndTag(environment);
    if (!release) return;

    const installed = environment.target?.installedVersion(environment.runningVersion) ?? environment.runningVersion;
    if (!isNewerVersion(release.latest, installed)) {
        environment.recordLatestVersion(release.latest);
        saveCheckTime(environment);
        environment.log(`${installed} is up to date`);
        return;
    }
    if (!await releaseIsReady(release.tag, environment)) return;
    environment.recordLatestVersion(release.latest);

    const reason = skipReason(release.latest, environment.readState(), environment);
    if (reason || environment.target === null) {
        saveCheckTime(environment);
        environment.log(`No download: ${reason}`);
        return;
    }
    if (await installRelease(release, installed, environment.target, environment) === Outcome.Finished) saveCheckTime(environment);
}

export async function runUpdateChild(environment: UpdateChildEnvironment = createUpdateChildEnvironment()): Promise<void> {
    const cancelTimeLimit = environment.startTimeLimit(() => {
        if (environment.target) environment.removeFile(environment.target.downloadPath);
        environment.exitProcess();
    });
    try {
        environment.removeStaleFiles();
        if (!await environment.acquireLock()) return;
        try {
            await runLocked(environment);
        } finally {
            environment.releaseLock();
        }
    } catch (error) {
        environment.log(`Failed: ${errorMessage(error)}`);
    } finally {
        cancelTimeLimit();
    }
}

function removeStaleFilesFor(platform: NodeJS.Platform, homeRealPath: string): void {
    if (platform === "win32") removeStaleUpdateFiles();
    else removeStaleUnixFiles(unixLayoutPaths(homeRealPath));
}

function writeLogLine(logPath: string, line: string): void {
    try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}${os.EOL}`);
    } catch {
        // A log that cannot be written must not stop the update.
    }
}

/** Each run overwrites the log, so the file never grows. */
function startLogFile(logPath: string): void {
    try {
        ensurePinggyLogDir();
        fs.writeFileSync(logPath, "");
    } catch {
        // A log that cannot be written must not stop the update.
    }
}

function createUpdateChildEnvironment(): UpdateChildEnvironment {
    const probe = createInstallProbe();
    const kind = backgroundInstallKind(detectInstallKind(probe), probe.execPath, probe.homeRealPath);
    const runningVersion = getVersion();
    const timeout = { timeoutMillis: CHECK_TIMEOUT_MILLIS };
    const logPath = getUpdateLogPath();
    return {
        kind,
        target: createUpdateTarget(kind, probe),
        runningVersion,
        nowEpochSeconds,
        acquireLock: acquireUpdateLock,
        releaseLock: releaseUpdateLock,
        isLockOurs: isUpdateLockOurs,
        readState: readUpdateState,
        writeState: writeUpdateState,
        recordLatestVersion,
        resolveTag: () => resolveLatestTag(timeout),
        resolveNpmVersion: () => resolveLatestNpmVersion(timeout),
        isReleaseComplete: (tag) => isReleaseComplete(tag, timeout),
        download: (target, tag) => downloadRelease(target, tag, assetNameFor(probe.platform, process.arch), runningVersion),
        readIpcVersion: (binaryPath) => readBinaryIpcVersion(binaryPath, runPinggyBinary),
        liveDaemon: getDaemonInfo,
        removeStaleFiles: () => removeStaleFilesFor(probe.platform, probe.homeRealPath),
        removeFile: removeQuietly,
        startLog: () => startLogFile(logPath),
        log: (line) => writeLogLine(logPath, line),
        startTimeLimit: (onLimit) => {
            const timer = setTimeout(onLimit, TIME_LIMIT_MILLIS);
            return () => clearTimeout(timer);
        },
        exitProcess: () => process.exit(0),
    };
}
