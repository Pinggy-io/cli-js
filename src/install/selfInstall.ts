/**
 * A downloaded pinggy binary offers to install itself before the command the user typed runs. After any answer, or a
 * failure, that command runs as usual.
 *
 * It never throws. The install itself is the install script the binary carries, run with this file as its binary, so
 * the result matches `curl -fsSL https://pinggy.io/install.sh | sh` exactly.
 */
import { execFile, spawn, SpawnOptions, StdioOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startDaemonFromInstalledBinary } from "../daemon/lifecycle/daemonManager.js";
import { installerBinaryPath } from "../daemon/lifecycle/serviceInstaller.js";
import { isPackagedBinary } from "../devices/terminal/nodePtyRuntime.js";
import { logger } from "../logger.js";
import { isUnderSudoOrInContainer } from "../update/backgroundUpdate.js";
import { environmentWithoutDeviceToken, pinggyBinaryRunOptions, readBinaryVersion } from "../update/binaryUpdater.js";
import { createInstallProbe, detectInstallKind, installCommandFor, InstallKind, unixLayoutPaths } from "../update/installKind.js";
import { isNewerVersion, parseVersion } from "../update/latestRelease.js";
import { readLinkVersion } from "../update/unixLinkSwap.js";
import { acquireUpdateLock, isUpdateLockHeld, releaseUpdateLock } from "../update/updateLock.js";
import { readUpdateState, UpdateState, writeUpdateState } from "../update/updateState.js";
import CLIPrinter from "../utils/printer.js";
import { errorMessage, getVersion } from "../utils/util.js";
import { findOnPath, findPinggyCommand, NpmCopy, PathLookup, pathFolders, PinggyCommand, processPathLookup } from "./pinggyOnPath.js";

const UPDATE_SUBCOMMAND = "update";
const NPM_PACKAGE = "pinggy";
const LINK_DIRECTORY = path.posix.join(".local", "bin");
const NO_ANSWER = /^\s*n/i;
const INTERRUPTED_EXIT_CODE = 130;
const VERSION_RUN_TIMEOUT_MILLIS = 10_000;
/** The child prints to this terminal but never reads it: the question was asked here already. */
const OUTPUT_ONLY: StdioOptions = ["ignore", "inherit", "inherit"];
/** Read by scripts/install/install.sh and install.ps1: install, then end, with no sign-in and no PATH warning. */
const INSTALL_ONLY_ENV = "PINGGY_INSTALL_ONLY";
const BINARY_URL_ENV = "PINGGY_BINARY_URL";
/** A pinned version would only make the script print a line about auto-update. This file is the version. */
const VERSION_ENV = "PINGGY_VERSION";
/** tsup bundles every module into dist/index.cjs, and pkg keeps the scripts at their place in the package. */
const BUNDLE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIRECTORY = path.join(BUNDLE_DIRECTORY, "..", "scripts", "install");

export const SelfInstallAnswer = {
    Yes: "yes",
    No: "no",
    /** Ctrl+D: the input ended. Not a decision, so nothing is installed or remembered. */
    Closed: "closed",
} as const;
export type SelfInstallAnswer = typeof SelfInstallAnswer[keyof typeof SelfInstallAnswer];

export const NpmRemoval = {
    Removed: "removed",
    NotWritable: "not-writable",
    NoNpm: "no-npm",
    Failed: "failed",
} as const;
export type NpmRemoval = typeof NpmRemoval[keyof typeof NpmRemoval];

export interface SelfInstallCommand {
    rawArgs: string[];
    values: { help?: boolean; version?: boolean };
}

export interface SelfInstallResult {
    questionShown: boolean;
}

export interface InstalledBinary {
    path: string;
    /** null when the file does not run. */
    version: string | null;
}

export interface SelfInstallEnvironment {
    platform: NodeJS.Platform;
    variables: NodeJS.ProcessEnv;
    isPackaged: boolean;
    stdinIsTerminal: boolean;
    stdoutIsTerminal: boolean;
    execPath: string;
    runningVersion: string;
    /** The folder the install script writes under, or null when it has none. */
    home: string | null;
    fileExists(filePath: string): boolean;
    isInstalledCopy(): boolean;
    findPinggyCommand(): PinggyCommand | null;
    installedBinary(installPath: string): Promise<InstalledBinary | null>;
    npmVersion(npm: NpmCopy): string | null;
    readState(): UpdateState;
    writeState(patch: UpdateState): boolean;
    isLockHeld(): boolean;
    acquireLock(): Promise<boolean>;
    releaseLock(): void;
    ask(question: string): Promise<SelfInstallAnswer>;
    runInstaller(): Promise<boolean>;
    removeNpmCopy(npm: NpmCopy): Promise<NpmRemoval>;
    useInstalledBinaryForDaemon(binaryPath: string): void;
    print(line: string): void;
}

type Offer =
    | { kind: "npm"; npm: NpmCopy; npmVersion: string | null; installedVersion: string | null; installThisFile: boolean }
    | { kind: "replace"; installedVersion: string | null }
    | { kind: "install" };

function installPathFor(environment: SelfInstallEnvironment, home: string): string {
    return installerBinaryPath(environment.platform, home, environment.variables);
}

/** `~` for the home folder on macOS and Linux, as the scripts print paths. */
function shown(filePath: string, environment: SelfInstallEnvironment, home: string): string {
    if (environment.platform === "win32") return filePath;
    return filePath === home || filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
}

function samePath(first: string, second: string, platform: NodeJS.Platform): boolean {
    return platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function wasDeclined(environment: SelfInstallEnvironment): boolean {
    const state = environment.readState();
    return state.declinedInstallVersion === environment.runningVersion
        && state.declinedInstallPath !== undefined
        && samePath(state.declinedInstallPath, environment.execPath, environment.platform);
}

function isPrintOnlyOrUpdate({ rawArgs, values }: SelfInstallCommand): boolean {
    return rawArgs[0] === UPDATE_SUBCOMMAND || Boolean(values.help) || Boolean(values.version);
}

/** Cheapest first. */
function passesGates(command: SelfInstallCommand, environment: SelfInstallEnvironment): boolean {
    if (!environment.isPackaged || isPrintOnlyOrUpdate(command)) return false;
    if (!environment.stdinIsTerminal || !environment.stdoutIsTerminal) return false;
    if (isUnderSudoOrInContainer(environment.variables, environment.fileExists)) return false;
    if (parseVersion(environment.runningVersion) === null || environment.home === null) return false;
    if (environment.isInstalledCopy() || wasDeclined(environment)) return false;
    return !environment.isLockHeld();
}

/** null when nothing would change: the installed binary is this version or newer, and npm holds no copy. */
async function decideOffer(environment: SelfInstallEnvironment, home: string): Promise<Offer | null> {
    const running = environment.runningVersion;
    const command = environment.findPinggyCommand();
    const installed = await environment.installedBinary(installPathFor(environment, home));
    const installedIsCurrent = installed !== null && installed.version !== null && !isNewerVersion(running, installed.version);
    if (command?.npm) {
        return {
            kind: "npm",
            npm: command.npm,
            npmVersion: environment.npmVersion(command.npm),
            installedVersion: installed?.version ?? null,
            installThisFile: !installedIsCurrent,
        };
    }
    if (installed) return installedIsCurrent ? null : { kind: "replace", installedVersion: installed.version };
    return { kind: "install" };
}

function questionFor(offer: Offer, environment: SelfInstallEnvironment, home: string): string {
    const running = environment.runningVersion;
    const installPath = shown(installPathFor(environment, home), environment, home);
    switch (offer.kind) {
        case "npm": {
            const npmCopy = offer.npmVersion ? `pinggy ${offer.npmVersion}` : "pinggy";
            if (!offer.installThisFile) {
                return `${npmCopy} is installed with npm, and pinggy ${offer.installedVersion} in ${installPath}. `
                    + "Remove npm's copy? [Y/n] ";
            }
            return `${npmCopy} is installed with npm. Remove it, and install this pinggy, ${running}, to ${installPath}? [Y/n] `;
        }
        case "replace":
            if (offer.installedVersion === null) {
                return `${installPath} does not run. Replace it with this pinggy, ${running}? [Y/n] `;
            }
            return `pinggy ${offer.installedVersion} is installed in ${installPath}. Replace it with this pinggy, ${running}? [Y/n] `;
        case "install":
            return `Install this pinggy, ${running}, to ${installPath}? [Y/n] `;
    }
}

function rememberDecline(environment: SelfInstallEnvironment): void {
    environment.writeState({ declinedInstallPath: environment.execPath, declinedInstallVersion: environment.runningVersion });
}

function npmUninstallCommand(npm: NpmCopy): string {
    return `npm uninstall -g --prefix ${npm.prefix} ${NPM_PACKAGE}`;
}

function printNpmRemoval(result: NpmRemoval, npm: NpmCopy, environment: SelfInstallEnvironment): void {
    switch (result) {
        case NpmRemoval.Removed:
            environment.print("Removed npm's pinggy.");
            // A shell remembers where it last found a command, and an rc change reaches only new shells.
            environment.print("Open a new terminal to use the installed pinggy.");
            return;
        case NpmRemoval.NotWritable:
            environment.print(`This user cannot change ${npm.prefix}. To remove npm's pinggy, run: sudo ${npmUninstallCommand(npm)}`);
            return;
        case NpmRemoval.NoNpm:
            environment.print(`npm is not on PATH. To remove npm's pinggy, run: ${npmUninstallCommand(npm)}`);
            return;
        case NpmRemoval.Failed:
            environment.print("Could not remove npm's pinggy. If pinggy is running, run: pinggy daemon stop");
            environment.print(`Then run: ${npmUninstallCommand(npm)}`);
            return;
    }
}

/**
 * The script prints this warning itself, except when the binary runs it: npm's copy, which comes first, is removed
 * only after the script ends. On macOS and Linux, a `~/.local/bin` missing from PATH got an rc line that puts it first.
 */
function warnIfShadowed(environment: SelfInstallEnvironment, home: string): void {
    const found = environment.findPinggyCommand();
    if (found === null) return;
    let expectedFolder: string;
    if (environment.platform === "win32") {
        expectedFolder = path.win32.dirname(installPathFor(environment, home));
        if (samePath(path.win32.dirname(found.commandPath), expectedFolder, "win32")) return;
    } else {
        expectedFolder = path.posix.join(home, LINK_DIRECTORY);
        // `~/.local/bin/` with a trailing slash is the same folder, as the script's own check allows.
        const folders = pathFolders(environment.platform, environment.variables.PATH ?? "")
            .map((folder) => path.posix.normalize(`${folder}/`));
        if (!folders.includes(`${expectedFolder}/`)) return;
        if (found.commandPath === path.posix.join(expectedFolder, NPM_PACKAGE)) return;
    }
    const folder = shown(expectedFolder, environment, home);
    environment.print(`Another pinggy, ${shown(found.commandPath, environment, home)}, comes before ${folder} on PATH, `
        + "so the pinggy command runs it.");
    environment.print(`Remove it, or move ${folder} earlier in PATH.`);
}

async function installAfterYes(offer: Offer, environment: SelfInstallEnvironment, home: string): Promise<void> {
    if (!await environment.acquireLock()) {
        environment.print("Another pinggy is installing or updating. Skipped the install.");
        return;
    }
    try {
        if (offer.kind !== "npm" || offer.installThisFile) {
            if (!await environment.runInstaller()) {
                environment.print(`Could not install pinggy. To install it later, run: ${installCommandFor(environment.platform)}`);
                // Without the record, the same failure would follow every command.
                rememberDecline(environment);
                return;
            }
            environment.useInstalledBinaryForDaemon(installPathFor(environment, home));
        }
        // Installed first, so a failed removal leaves 2 copies, never none.
        if (offer.kind === "npm") printNpmRemoval(await environment.removeNpmCopy(offer.npm), offer.npm, environment);
        warnIfShadowed(environment, home);
    } finally {
        environment.releaseLock();
    }
}

export async function offerSelfInstall(
    command: SelfInstallCommand,
    createEnvironment: () => SelfInstallEnvironment = realEnvironment,
): Promise<SelfInstallResult> {
    let questionShown = false;
    try {
        const environment = createEnvironment();
        if (!passesGates(command, environment) || environment.home === null) return { questionShown };
        const home = environment.home;
        const offer = await decideOffer(environment, home);
        // An answer that cannot be remembered would bring the question back on every command.
        if (offer === null || !environment.writeState({})) return { questionShown };

        questionShown = true;
        const answer = await environment.ask(questionFor(offer, environment, home));
        if (answer === SelfInstallAnswer.No) rememberDecline(environment);
        if (answer === SelfInstallAnswer.Yes) await installAfterYes(offer, environment, home);
    } catch (error) {
        logger.debug("Self-install check failed", { error: errorMessage(error) });
    }
    return { questionShown };
}

// The real environment.

function existingFolder(folder: string | undefined): string | null {
    if (!folder) return null;
    try {
        return fs.statSync(folder).isDirectory() ? folder : null;
    } catch {
        return null;
    }
}

/** The script writes under $HOME, and install.ps1 under %LOCALAPPDATA%. Without either, there is nowhere to install. */
function installHome(platform: NodeJS.Platform, variables: NodeJS.ProcessEnv): string | null {
    if (platform === "win32") return existingFolder(variables.LOCALAPPDATA) ? os.homedir() : null;
    return existingFolder(variables.HOME);
}

function isInstalledCopy(platform: NodeJS.Platform, execPath: string, home: string | null, variables: NodeJS.ProcessEnv): boolean {
    if (platform === "win32") {
        // The folder, not the file: a running copy can sit there under a moved-aside name.
        if (home === null) return false;
        const installFolder = path.win32.dirname(installerBinaryPath(platform, home, variables));
        return samePath(path.win32.dirname(execPath), installFolder, platform);
    }
    const kind = detectInstallKind(createInstallProbe());
    return kind === InstallKind.UnixLayout || kind === InstallKind.UnixPlainFile;
}

const runForVersion = (binaryPath: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(binaryPath, args, { ...pinggyBinaryRunOptions(), timeout: VERSION_RUN_TIMEOUT_MILLIS }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
    });
});

/** Starting a 2nd 59 MB binary on every command would be slow, so the answer is kept until the file changes. */
async function cachedBinaryVersion(binaryPath: string): Promise<string | null> {
    const stats = fs.statSync(binaryPath);
    const state = readUpdateState();
    if (state.cachedVersionPath === binaryPath
        && state.cachedVersionSizeBytes === stats.size
        && state.cachedVersionModifiedMillis === stats.mtimeMs) {
        return state.cachedVersion || null;
    }
    let version: string | null = null;
    try {
        version = await readBinaryVersion(binaryPath, runForVersion);
    } catch (error) {
        logger.debug("The installed pinggy printed no version", { binaryPath, error: errorMessage(error) });
    }
    writeUpdateState({
        cachedVersionPath: binaryPath,
        cachedVersionSizeBytes: stats.size,
        cachedVersionModifiedMillis: stats.mtimeMs,
        cachedVersion: version ?? "",
    });
    return version;
}

/** The layout's link names its version in its target, so most runs read it with no process at all. */
async function realInstalledBinary(platform: NodeJS.Platform, home: string, installPath: string): Promise<InstalledBinary | null> {
    if (platform !== "win32") {
        let isLink: boolean;
        try {
            isLink = fs.lstatSync(installPath).isSymbolicLink();
        } catch {
            return null;
        }
        if (!fs.existsSync(installPath)) return { path: installPath, version: null };
        const linkVersion = isLink ? readLinkVersion(unixLayoutPaths(home)) : null;
        if (linkVersion) return { path: installPath, version: linkVersion };
    } else if (!fs.existsSync(installPath)) {
        return null;
    }
    return { path: installPath, version: await cachedBinaryVersion(installPath) };
}

function readNpmVersion(npm: NpmCopy): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(npm.packageFolder, "package.json"), "utf-8")) as { version?: unknown };
        return typeof parsed.version === "string" && parseVersion(parsed.version) ? parsed.version : null;
    } catch {
        return null;
    }
}

/** Ctrl+C ends the process, as at any other prompt. The command after it gets stdin back paused. */
function askOnTerminal(question: string): Promise<SelfInstallAnswer> {
    return new Promise((resolve) => {
        const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let settled = false;
        const finish = (answer: SelfInstallAnswer): void => {
            if (settled) return;
            settled = true;
            readline.close();
            process.stdin.pause();
            resolve(answer);
        };
        readline.on("SIGINT", () => {
            readline.close();
            process.stdout.write("\n");
            process.exit(INTERRUPTED_EXIT_CODE);
        });
        readline.on("close", () => {
            if (!settled) process.stdout.write("\n");
            finish(SelfInstallAnswer.Closed);
        });
        readline.question(question, (text) => finish(NO_ANSWER.test(text) ? SelfInstallAnswer.No : SelfInstallAnswer.Yes));
    });
}

/** Windows: a double-clicked pinggy.exe closes its window when it exits, before anyone reads the result. */
export function waitForEnterToClose(): Promise<void> {
    return new Promise((resolve) => {
        const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        readline.on("close", () => resolve());
        readline.on("SIGINT", () => readline.close());
        readline.question("Press Enter to close.", () => readline.close());
    });
}

function waitForExit(command: string, args: string[], options: SpawnOptions): Promise<number | null> {
    return new Promise((resolve) => {
        const child = spawn(command, args, options);
        child.on("error", (error) => {
            logger.debug("Could not start a process", { command, error: errorMessage(error) });
            resolve(null);
        });
        child.on("close", (code) => resolve(code));
    });
}

/** The script reads `file://` plus the raw path, and install.ps1 a real file URL it turns back into a path. */
function binaryUrlFor(platform: NodeJS.Platform, execPath: string): string {
    return platform === "win32" ? pathToFileURL(execPath).href : `file://${execPath}`;
}

function installerEnvironment(platform: NodeJS.Platform, execPath: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...environmentWithoutDeviceToken(),
        PKG_EXECPATH: "",
        [BINARY_URL_ENV]: binaryUrlFor(platform, execPath),
        [INSTALL_ONLY_ENV]: "1",
    };
    delete environment[VERSION_ENV];
    return environment;
}

function windowsPowerShell(): string {
    const systemRoot = process.env.SystemRoot;
    return systemRoot ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

/**
 * pkg keeps the scripts in its snapshot, which `sh` and PowerShell cannot read, so each run copies 1 to a private
 * temp folder. Windows runs it through `iex`, as `irm | iex` does: an execution policy applies to script files,
 * not to `iex`.
 */
async function runEmbeddedInstaller(platform: NodeJS.Platform, execPath: string): Promise<boolean> {
    const scriptName = platform === "win32" ? "install.ps1" : "install.sh";
    const temporaryFolder = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-install-"));
    try {
        const scriptPath = path.join(temporaryFolder, scriptName);
        fs.writeFileSync(scriptPath, fs.readFileSync(path.join(SCRIPTS_DIRECTORY, scriptName)), { mode: 0o600 });
        const options: SpawnOptions = { stdio: OUTPUT_ONLY, env: installerEnvironment(platform, execPath) };
        if (platform !== "win32") return await waitForExit("/bin/sh", [scriptPath], options) === 0;

        const command = `iex ([IO.File]::ReadAllText('${scriptPath.replace(/'/g, "''")}'))`;
        const encoded = Buffer.from(command, "utf16le").toString("base64");
        return await waitForExit(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], options) === 0;
    } catch (error) {
        logger.debug("The install script did not run", { error: errorMessage(error) });
        CLIPrinter.error(`pinggy install: ${errorMessage(error)}`);
        return false;
    } finally {
        fs.rmSync(temporaryFolder, { recursive: true, force: true });
    }
}

function canWrite(folder: string): boolean {
    try {
        fs.accessSync(folder, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/** npm on PATH, or the npm in npm's own global folder. */
function findNpm(npm: NpmCopy, lookup: PathLookup): string | null {
    if (lookup.platform === "win32") {
        const onPath = findOnPath(["npm.cmd"], lookup);
        const inPrefix = path.win32.join(npm.prefix, "npm.cmd");
        return onPath ?? (lookup.files.isFile(inPrefix) ? inPrefix : null);
    }
    const onPath = findOnPath(["npm"], lookup);
    const inPrefix = path.posix.join(npm.prefix, "bin", "npm");
    return onPath ?? (lookup.files.isExecutableFile(inPrefix) ? inPrefix : null);
}

async function removeNpmCopy(npm: NpmCopy): Promise<NpmRemoval> {
    const lookup = processPathLookup();
    if (lookup.platform !== "win32") {
        const folders = [path.posix.join(npm.prefix, "lib", "node_modules"), path.posix.join(npm.prefix, "bin")];
        if (!folders.every(canWrite)) return NpmRemoval.NotWritable;
    }
    const npmPath = findNpm(npm, lookup);
    if (npmPath === null) return NpmRemoval.NoNpm;

    CLIPrinter.print(`Running: ${npmUninstallCommand(npm)}`);
    const options: SpawnOptions = { stdio: OUTPUT_ONLY, env: environmentWithoutDeviceToken() };
    let exitCode: number | null;
    if (lookup.platform === "win32") {
        // Node starts a .cmd only through cmd.exe. /s keeps the outer quotes, so paths with spaces stay whole.
        const commandLine = `""${npmPath}" uninstall -g --prefix "${npm.prefix}" ${NPM_PACKAGE}"`;
        exitCode = await waitForExit(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
            ...options,
            windowsVerbatimArguments: true,
        });
    } else {
        exitCode = await waitForExit(npmPath, ["uninstall", "-g", "--prefix", npm.prefix, NPM_PACKAGE], options);
    }
    return exitCode === 0 ? NpmRemoval.Removed : NpmRemoval.Failed;
}

function realEnvironment(): SelfInstallEnvironment {
    const platform = process.platform;
    const variables = process.env;
    const home = installHome(platform, variables);
    const execPath = process.execPath;
    return {
        platform,
        variables,
        isPackaged: isPackagedBinary(),
        stdinIsTerminal: process.stdin.isTTY === true,
        stdoutIsTerminal: process.stdout.isTTY === true,
        execPath,
        runningVersion: getVersion(),
        home,
        fileExists: (filePath) => fs.existsSync(filePath),
        isInstalledCopy: () => isInstalledCopy(platform, execPath, home, variables),
        findPinggyCommand: () => findPinggyCommand(processPathLookup()),
        installedBinary: (installPath) => (home === null ? Promise.resolve(null) : realInstalledBinary(platform, home, installPath)),
        npmVersion: readNpmVersion,
        readState: readUpdateState,
        writeState: writeUpdateState,
        isLockHeld: isUpdateLockHeld,
        acquireLock: acquireUpdateLock,
        releaseLock: releaseUpdateLock,
        ask: askOnTerminal,
        runInstaller: () => runEmbeddedInstaller(platform, execPath),
        removeNpmCopy,
        useInstalledBinaryForDaemon: startDaemonFromInstalledBinary,
        print: (line) => CLIPrinter.print(line),
    };
}
