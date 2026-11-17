/**
 * Decides, on every command, whether to start the detached updater. It reads a few files and makes no network call.
 *
 * It never throws and never delays the command. The updater runs in its own process, because a short command exits long
 * before a 59 MB download ends.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { getDaemonInfo } from "../daemon/lifecycle/daemonManager.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";
import { logger } from "../logger.js";
import { errorMessage, getVersion } from "../utils/util.js";
import CLIPrinter from "../utils/printer.js";
import { environmentWithoutDeviceToken } from "./binaryUpdater.js";
import {
    backgroundInstallKind,
    canReplaceItself,
    createInstallProbe,
    detectInstallKind,
    hasPathSegment,
    installCommandFor,
    InstallKind,
    NPM_INSTALL_COMMAND,
} from "./installKind.js";
import { isNewerVersion, parseVersion } from "./latestRelease.js";
import { daemonRestartLine } from "./updateMessages.js";
import { isUpdateLockHeld } from "./updateLock.js";
import { nowEpochSeconds, readUpdateState, UpdateState, writeUpdateState } from "./updateState.js";

const AUTO_UPDATE_ENV = "PINGGY_AUTO_UPDATE";
const OFF_VALUES = new Set(["false", "0"]);
const ON_VALUES = new Set(["true", "1"]);
const SUDO_UID_ENV = "SUDO_UID";
const CONTAINER_MARKER_FILES = ["/.dockerenv", "/run/.containerenv"];
const NPX_SEGMENT = "_npx";
const UPDATE_SUBCOMMAND = "update";
const UPDATE_CHILD_FLAG = "--_update-child";

const SECONDS_PER_DAY = 24 * 60 * 60;
const CHECK_INTERVAL_SECONDS = SECONDS_PER_DAY;
const ATTEMPT_INTERVAL_SECONDS = 60 * 60;
const COULD_NOT_UPDATE_AFTER_SECONDS = 7 * SECONDS_PER_DAY;
const COULD_NOT_CHECK_AFTER_SECONDS = 30 * SECONDS_PER_DAY;

export interface BackgroundUpdateCommand {
    rawArgs: string[];
    values: { help?: boolean; version?: boolean };
    hasAnyArgs: boolean;
    /** The install question showed this run, so no notice prints with it. */
    installQuestionShown?: boolean;
}

export interface BackgroundUpdateEnvironment {
    variables: NodeJS.ProcessEnv;
    stdoutIsTerminal: boolean;
    runningVersion: string;
    platform: NodeJS.Platform;
    scriptRealPath: string | null;
    nowEpochSeconds(): number;
    fileExists(filePath: string): boolean;
    /** The install kind the background update acts on. Detecting it can create a file, so it runs only when needed. */
    detectKind(): InstallKind;
    readState(): UpdateState;
    writeState(patch: UpdateState): boolean;
    isLockHeld(): boolean;
    liveDaemon(): DaemonInfo | null;
    print(line: string): void;
    spawnUpdater(): void;
}

/** Older than the interval, never set, or from a clock that has since moved back. */
function isDue(lastEpochSeconds: number | undefined, intervalSeconds: number, now: number): boolean {
    return lastEpochSeconds === undefined || lastEpochSeconds > now || now - lastEpochSeconds > intervalSeconds;
}

export function isAutoUpdateOff(variables: NodeJS.ProcessEnv): boolean {
    const value = variables[AUTO_UPDATE_ENV]?.toLowerCase();
    if (value === undefined) return false;
    if (!OFF_VALUES.has(value) && !ON_VALUES.has(value)) {
        logger.debug(`Unknown ${AUTO_UPDATE_ENV} value leaves auto-update on`, { value });
    }
    return OFF_VALUES.has(value);
}

function isExplicitOrPrintOnly({ rawArgs, values, hasAnyArgs }: BackgroundUpdateCommand): boolean {
    return rawArgs[0] === UPDATE_SUBCOMMAND || !hasAnyArgs || Boolean(values.help) || Boolean(values.version);
}

/** A root process would write root-owned files into the user's folders, and a container's binary belongs to its image. */
export function isUnderSudoOrInContainer(variables: NodeJS.ProcessEnv, fileExists: (filePath: string) => boolean): boolean {
    return Boolean(variables[SUDO_UID_ENV]) || CONTAINER_MARKER_FILES.some(fileExists);
}

function isExcludedProcess(environment: BackgroundUpdateEnvironment): boolean {
    return isUnderSudoOrInContainer(environment.variables, environment.fileExists)
        || parseVersion(environment.runningVersion) === null
        || hasPathSegment(environment.scriptRealPath, NPX_SEGMENT);
}

interface PendingNotice {
    line: string;
    patch: UpdateState;
}

function updatedNotice(state: UpdateState, running: string): PendingNotice | null {
    if (state.updatedToVersion !== running || !state.updatedFromVersion) return null;
    return {
        line: `Updated pinggy ${state.updatedFromVersion} to ${running}.`,
        patch: { updatedFromVersion: undefined, updatedToVersion: undefined },
    };
}

function deferredNotice(state: UpdateState, environment: BackgroundUpdateEnvironment): PendingNotice | null {
    const version = state.deferredVersion;
    if (!version || state.lastNoticeVersion === version) return null;
    const daemon = environment.liveDaemon();
    if (!daemon) return null;
    return { line: daemonRestartLine(version, daemon.host), patch: { lastNoticeVersion: version } };
}

function availableLine(kind: InstallKind, latest: string, platform: NodeJS.Platform): string | null {
    if (kind === InstallKind.Npm) return `pinggy ${latest} is available. Run: ${NPM_INSTALL_COMMAND}`;
    if (kind === InstallKind.WindowsReadOnly || kind === InstallKind.UnixLoose) {
        return `pinggy ${latest} is available. Run: ${installCommandFor(platform)}`;
    }
    return null;
}

function newVersionNotice(state: UpdateState, kind: () => InstallKind, environment: BackgroundUpdateEnvironment): PendingNotice | null {
    const latest = state.latestVersion;
    if (!latest || !isNewerVersion(latest, environment.runningVersion) || state.lastNoticeVersion === latest) return null;

    const patch: UpdateState = { lastNoticeVersion: latest };
    const available = availableLine(kind(), latest, environment.platform);
    if (available) return { line: available, patch };

    const seenLongAgo = state.latestSeenEpochSeconds !== undefined
        && environment.nowEpochSeconds() - state.latestSeenEpochSeconds > COULD_NOT_UPDATE_AFTER_SECONDS;
    if (canReplaceItself(kind()) && seenLongAgo && latest !== state.rolledBackFromVersion) {
        return { line: `pinggy could not update itself to ${latest}. Run: pinggy update`, patch };
    }
    return null;
}

function couldNotCheckNotice(state: UpdateState, kind: () => InstallKind, environment: BackgroundUpdateEnvironment): PendingNotice | null {
    const now = environment.nowEpochSeconds();
    const lastCheck = state.lastCheckEpochSeconds;
    if (lastCheck === undefined || now - lastCheck <= COULD_NOT_CHECK_AFTER_SECONDS) return null;
    if (!isDue(state.lastCheckFailureNoticeEpochSeconds, COULD_NOT_CHECK_AFTER_SECONDS, now)) return null;
    if (kind() === InstallKind.DevCheckout) return null;
    return { line: "pinggy could not check for updates. Run: pinggy update", patch: { lastCheckFailureNoticeEpochSeconds: now } };
}

function pendingNotice(state: UpdateState, kind: () => InstallKind, environment: BackgroundUpdateEnvironment): PendingNotice | null {
    return updatedNotice(state, environment.runningVersion)
        ?? deferredNotice(state, environment)
        ?? newVersionNotice(state, kind, environment)
        ?? couldNotCheckNotice(state, kind, environment);
}

/** Write first and print only after: a file that cannot be written must not repeat the line on every command. */
function printPendingNotice(state: UpdateState, kind: () => InstallKind, environment: BackgroundUpdateEnvironment): void {
    const notice = pendingNotice(state, kind, environment);
    if (notice && environment.writeState(notice.patch)) environment.print(notice.line);
}

function runGates(command: BackgroundUpdateCommand, environment: BackgroundUpdateEnvironment): void {
    if (isExplicitOrPrintOnly(command) || !environment.stdoutIsTerminal) return;
    if (isAutoUpdateOff(environment.variables) || isExcludedProcess(environment)) return;

    let detectedKind: InstallKind | undefined;
    const kind = (): InstallKind => detectedKind ??= environment.detectKind();

    const state = environment.readState();
    if (!command.installQuestionShown) printPendingNotice(state, kind, environment);

    const now = environment.nowEpochSeconds();
    if (!isDue(state.lastCheckEpochSeconds, CHECK_INTERVAL_SECONDS, now)) return;
    if (!isDue(state.lastAttemptEpochSeconds, ATTEMPT_INTERVAL_SECONDS, now)) return;
    if (kind() === InstallKind.DevCheckout || environment.isLockHeld()) return;
    // Without this record an offline machine would start 1 extra process on every command.
    if (environment.writeState({ lastAttemptEpochSeconds: now })) environment.spawnUpdater();
}

export function spawnUpdater(spawnProcess: typeof spawn = spawn): void {
    const child = spawnProcess(process.execPath, [process.argv[1], UPDATE_CHILD_FLAG], {
        detached: true,
        stdio: "ignore",
        // On Windows a process holds its working directory open, so inheriting it would block deleting that folder.
        cwd: os.homedir(),
        env: environmentWithoutDeviceToken(),
        ...(os.platform() === "win32" ? { windowsHide: true } : {}),
    });
    child.on("error", (error) => logger.debug("Could not start the updater", { error: errorMessage(error) }));
    child.unref();
}

function realEnvironment(): BackgroundUpdateEnvironment {
    const probe = createInstallProbe();
    return {
        variables: process.env,
        stdoutIsTerminal: process.stdout.isTTY === true,
        runningVersion: getVersion(),
        platform: probe.platform,
        scriptRealPath: probe.scriptRealPath,
        nowEpochSeconds,
        fileExists: (filePath) => fs.existsSync(filePath),
        detectKind: () => backgroundInstallKind(detectInstallKind(probe), probe.execPath, probe.homeRealPath),
        readState: readUpdateState,
        writeState: writeUpdateState,
        isLockHeld: isUpdateLockHeld,
        liveDaemon: getDaemonInfo,
        print: (line) => CLIPrinter.print(line),
        spawnUpdater: () => spawnUpdater(),
    };
}

export function startBackgroundUpdate(
    command: BackgroundUpdateCommand,
    createEnvironment: () => BackgroundUpdateEnvironment = realEnvironment,
): void {
    try {
        runGates(command, createEnvironment());
    } catch (error) {
        logger.debug("Background update gate failed", { error: errorMessage(error) });
    }
}
