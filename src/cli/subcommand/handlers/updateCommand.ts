/**
 * `pinggy update`: check for a newer release, install it, or go back to the previous one.
 */
import {
    createInstallProbe,
    detectInstallKind,
    installCommandFor,
    InstallKind,
    InstallProbe,
    NPM_INSTALL_COMMAND,
} from "../../../update/installKind.js";
import {
    isNewerVersion,
    isReleaseComplete,
    parseVersion,
    resolveLatestTag,
    versionFromTag,
} from "../../../update/latestRelease.js";
import { createUpdateTarget, downloadRelease, UpdateTarget } from "../../../update/applyUpdate.js";
import {
    assetNameFor,
    DownloadDependencies,
    PinggyBinaryRunner,
    readBinaryIpcVersion,
    removeQuietly,
    runPinggyBinary,
    UpdateError,
} from "../../../update/binaryUpdater.js";
import { daemonRestartLine } from "../../../update/updateMessages.js";
import { daemonIpcVersion, getDaemonInfo } from "../../../daemon/lifecycle/daemonManager.js";
import { acquireUpdateLock, releaseUpdateLock } from "../../../update/updateLock.js";
import { recordLatestVersion, writeUpdateState } from "../../../update/updateState.js";
import { windowsInstallPaths } from "../../../update/windowsSwap.js";
import { printUpdateHelp } from "../../../utils/helpMessages.js";
import CLIPrinter from "../../../utils/printer.js";
import { getVersion } from "../../../utils/util.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const CHECK_TIMEOUT_MILLIS = 10_000;

const CHECK_FLAG = "--check";
const ROLLBACK_FLAG = "--rollback";
const KNOWN_FLAGS = new Set([CHECK_FLAG, ROLLBACK_FLAG]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const SUDO_UID_ENV = "SUDO_UID";

export interface UpdateCommandContext {
    probe: InstallProbe;
    runningVersion: string;
    /** The swap for this install. Omitted, it comes from the install kind. */
    target?: UpdateTarget | null;
    architecture?: string;
    download?: DownloadDependencies;
    runBinary?: PinggyBinaryRunner;
}

function createContext(): UpdateCommandContext {
    return { probe: createInstallProbe(), runningVersion: getVersion() };
}

function targetFor(kind: InstallKind, context: UpdateCommandContext): UpdateTarget | null {
    return context.target !== undefined ? context.target : createUpdateTarget(kind, context.probe);
}

function printAvailable(latest: string, running: string, command: string): void {
    CLIPrinter.print(`pinggy ${latest} is available. You run ${running}.`);
    CLIPrinter.print(`Run: ${command}`);
}

function installCommand(kind: InstallKind, probe: InstallProbe): string {
    return kind === InstallKind.Npm ? NPM_INSTALL_COMMAND : installCommandFor(probe.platform);
}

interface ReleaseLookup {
    tag: string;
    latest: string;
    newer: boolean;
}

/** @returns null when the release cannot be used, after printing the reason */
async function lookUpRelease(installed: string): Promise<ReleaseLookup | null> {
    try {
        const tag = await resolveLatestTag({ timeoutMillis: CHECK_TIMEOUT_MILLIS });
        const latest = versionFromTag(tag);
        const newer = isNewerVersion(latest, installed);
        if (newer && !await isReleaseComplete(tag, { timeoutMillis: CHECK_TIMEOUT_MILLIS })) {
            CLIPrinter.error(`Release ${tag} is not ready. Try again later.`);
            return null;
        }
        return { tag, latest, newer };
    } catch {
        CLIPrinter.error("Could not reach GitHub to check for updates.");
        return null;
    }
}

async function runCheck(kind: InstallKind, context: UpdateCommandContext): Promise<number> {
    const running = context.runningVersion;
    const release = await lookUpRelease(running);
    if (!release) return EXIT_FAILURE;

    recordLatestVersion(release.latest);
    if (release.newer) printAvailable(release.latest, running, installCommand(kind, context.probe));
    else CLIPrinter.print(`pinggy ${running} is up to date.`);
    return EXIT_OK;
}

/** Runs `action` under the update lock, and prints an UpdateError as the command's result. */
async function underUpdateLock(action: () => Promise<number>): Promise<number> {
    if (!await acquireUpdateLock()) {
        CLIPrinter.error("Another pinggy update is running.");
        return EXIT_FAILURE;
    }
    try {
        return await action();
    } catch (error) {
        if (!(error instanceof UpdateError)) throw error;
        CLIPrinter.error(error.message);
        return EXIT_FAILURE;
    } finally {
        releaseUpdateLock();
    }
}

async function installRelease(release: ReleaseLookup, target: UpdateTarget, context: UpdateCommandContext): Promise<number> {
    const { tag, latest } = release;
    const runningVersion = context.runningVersion;
    const assetName = assetNameFor(context.probe.platform, context.architecture ?? process.arch);
    return underUpdateLock(async () => {
        let daemonRestart: string | null;
        try {
            await downloadRelease(target, tag, assetName, runningVersion, context.download);
            daemonRestart = await daemonRestartLineFor(target.downloadPath, latest, context);
            await target.install({ newVersion: latest, runningVersion });
        } finally {
            removeQuietly(target.downloadPath);
        }
        writeUpdateState({
            rolledBackFromVersion: undefined,
            failedVersion: undefined,
            failedAttempts: undefined,
            deferredVersion: undefined,
            deferredIpcVersion: undefined,
        });
        CLIPrinter.print(`Updated pinggy ${runningVersion} to ${latest}.`);
        if (daemonRestart) CLIPrinter.print(daemonRestart);
        return EXIT_OK;
    });
}

/** @returns the restart line when a live daemon speaks another IPC version than this binary, else null */
async function daemonRestartLineFor(binaryPath: string, version: string, context: UpdateCommandContext): Promise<string | null> {
    const daemon = getDaemonInfo();
    if (!daemon) return null;
    const ipcVersion = await readBinaryIpcVersion(binaryPath, context.runBinary ?? runPinggyBinary).catch(() => null);
    return ipcVersion !== null && ipcVersion !== daemonIpcVersion(daemon) ? daemonRestartLine(version, daemon.host) : null;
}

function isRollbackCopy(kind: InstallKind, context: UpdateCommandContext): boolean {
    return kind === InstallKind.WindowsWritable && windowsInstallPaths(context.probe.execPath).runningFromBackup;
}

async function runUpdate(kind: InstallKind, context: UpdateCommandContext): Promise<number> {
    if (isRollbackCopy(kind, context)) {
        const { liveName } = windowsInstallPaths(context.probe.execPath);
        CLIPrinter.error(`This is the rollback copy of ${liveName}. It runs only: update ${ROLLBACK_FLAG}`);
        return EXIT_FAILURE;
    }
    const target = targetFor(kind, context);
    const running = context.runningVersion;
    const release = await lookUpRelease(target ? target.installedVersion(running) : running);
    if (!release) return EXIT_FAILURE;

    recordLatestVersion(release.latest);
    if (!release.newer) {
        CLIPrinter.print(`pinggy ${running} is up to date.`);
        return EXIT_OK;
    }
    if (!target) {
        printAvailable(release.latest, running, installCommand(kind, context.probe));
        return EXIT_OK;
    }
    return installRelease(release, target, context);
}

async function runRollback(kind: InstallKind, context: UpdateCommandContext): Promise<number> {
    const target = targetFor(kind, context);
    if (!target) {
        CLIPrinter.error(rollbackRefusal(kind));
        return EXIT_FAILURE;
    }
    return underUpdateLock(async () => {
        const { from, to } = await target.rollback(context.runningVersion);
        writeUpdateState({ updatedFromVersion: undefined, updatedToVersion: undefined });
        CLIPrinter.print(`Rolled back pinggy ${from} to ${to}.`);
        const daemonRestart = await daemonRestartLineFor(target.rollbackBinaryPath(to), to, context);
        if (daemonRestart) CLIPrinter.print(daemonRestart);
        return EXIT_OK;
    });
}

function rollbackRefusal(kind: InstallKind): string {
    if (kind === InstallKind.WindowsReadOnly || kind === InstallKind.UnixLoose) return "This copy of pinggy cannot update itself.";
    return "Rollback is not available for this install.";
}

/** @returns the exit code */
export async function runUpdateCommand(rest: string[], context: UpdateCommandContext = createContext()): Promise<number> {
    if (rest.some((argument) => HELP_FLAGS.has(argument))) {
        printUpdateHelp();
        return EXIT_OK;
    }
    const check = rest.includes(CHECK_FLAG);
    const rollback = rest.includes(ROLLBACK_FLAG);
    if (rest.some((argument) => !KNOWN_FLAGS.has(argument)) || (check && rollback)) {
        printUpdateHelp();
        return EXIT_FAILURE;
    }

    const kind = detectInstallKind(context.probe);
    if (kind === InstallKind.DevCheckout) {
        CLIPrinter.print("This is not a packaged build. Run from your checkout, or install a release.");
        return EXIT_OK;
    }
    if (parseVersion(context.runningVersion) === null) {
        CLIPrinter.error("Could not read the running version.");
        return EXIT_FAILURE;
    }
    if (check) return runCheck(kind, context);
    if (process.env[SUDO_UID_ENV]) {
        CLIPrinter.error("pinggy update does not run under sudo. Run it without sudo.");
        return EXIT_FAILURE;
    }
    return rollback ? runRollback(kind, context) : runUpdate(kind, context);
}

export async function handleUpdate(rest: string[]): Promise<void> {
    const exitCode = await runUpdateCommand(rest);
    if (exitCode !== EXIT_OK) process.exit(exitCode);
}
