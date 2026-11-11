/**
 * How this copy of pinggy was installed, which decides whether it can replace itself.
 *
 * An unrecognised location always falls to a kind that only prints a hint, never to one that writes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPackagedBinary } from "../devices/terminal/nodePtyRuntime.js";

export const InstallKind = {
    WindowsWritable: "windows-writable",
    WindowsReadOnly: "windows-read-only",
    UnixLayout: "unix-layout",
    UnixPlainFile: "unix-plain-file",
    UnixLoose: "unix-loose",
    Npm: "npm",
    DevCheckout: "dev-checkout",
} as const;
export type InstallKind = typeof InstallKind[keyof typeof InstallKind];

export interface InstallProbe {
    isPackaged: boolean;
    isElectron: boolean;
    platform: NodeJS.Platform;
    execPath: string;
    scriptRealPath: string | null;
    homeRealPath: string;
    directoryIsWritable(): boolean;
}

export interface UnixLayoutPaths {
    binDirectory: string;
    link: string;
    versionsDirectory: string;
}

const NODE_MODULES_SEGMENT = "node_modules";
const WINDOWS_INSTALL_COMMAND = "irm https://pinggy.io/install.ps1 | iex";
const UNIX_INSTALL_COMMAND = "curl -fsSL https://pinggy.io/install.sh | sh";
export const NPM_INSTALL_COMMAND = "npm i -g pinggy";

export function hasPathSegment(candidate: string | null, segment: string): boolean {
    return candidate !== null && candidate.split(/[\\/]/).includes(segment);
}

/** The layout under the user's home. `homeRealPath` must have its symlinks resolved, as `execPath` does. */
export function unixLayoutPaths(homeRealPath: string): UnixLayoutPaths {
    const root = path.posix.join(homeRealPath, ".pinggy");
    const binDirectory = path.posix.join(root, "bin");
    return {
        binDirectory,
        link: path.posix.join(binDirectory, "pinggy"),
        versionsDirectory: path.posix.join(root, "versions"),
    };
}

/** First match wins. */
export function detectInstallKind(probe: InstallProbe): InstallKind {
    if (!probe.isPackaged) {
        if (probe.isElectron) return InstallKind.Npm;
        return hasPathSegment(probe.scriptRealPath, NODE_MODULES_SEGMENT) ? InstallKind.Npm : InstallKind.DevCheckout;
    }
    if (probe.platform === "win32") {
        return probe.directoryIsWritable() ? InstallKind.WindowsWritable : InstallKind.WindowsReadOnly;
    }
    const layout = unixLayoutPaths(probe.homeRealPath);
    if (probe.execPath.startsWith(`${layout.versionsDirectory}/`)) return InstallKind.UnixLayout;
    return probe.execPath === layout.link ? InstallKind.UnixPlainFile : InstallKind.UnixLoose;
}

/** The kinds that replace their own binary. The others only tell the user how to update. */
export function canReplaceItself(kind: InstallKind): boolean {
    return kind === InstallKind.WindowsWritable || kind === InstallKind.UnixLayout || kind === InstallKind.UnixPlainFile;
}

/**
 * In the background, a writable folder outside the user's profile counts as read-only, because another account can
 * write to it. `pinggy update` is an explicit request and is unaffected.
 */
export function backgroundInstallKind(kind: InstallKind, execPath: string, homeRealPath: string): InstallKind {
    if (kind !== InstallKind.WindowsWritable) return kind;
    const relative = path.win32.relative(homeRealPath, execPath);
    const insideProfile = relative !== "" && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
    return insideProfile ? kind : InstallKind.WindowsReadOnly;
}

export function installCommandFor(platform: NodeJS.Platform): string {
    return platform === "win32" ? WINDOWS_INSTALL_COMMAND : UNIX_INSTALL_COMMAND;
}

function realPathOr(candidate: string, fallback: string): string {
    try {
        return fs.realpathSync(candidate);
    } catch {
        return fallback;
    }
}

/** Creates and deletes a real file, because `fs.accessSync` does not check Windows ACLs. */
function canCreateFileNextTo(filePath: string): boolean {
    const probePath = path.join(path.dirname(filePath), `.pinggy-write-test-${process.pid}`);
    try {
        fs.closeSync(fs.openSync(probePath, "wx"));
        fs.unlinkSync(probePath);
        return true;
    } catch {
        return false;
    }
}

export function createInstallProbe(): InstallProbe {
    const execPath = process.execPath;
    const scriptPath = process.argv[1];
    return {
        isPackaged: isPackagedBinary(),
        isElectron: Boolean(process.versions.electron),
        platform: process.platform,
        execPath,
        scriptRealPath: scriptPath ? realPathOr(scriptPath, scriptPath) : null,
        homeRealPath: realPathOr(os.homedir(), os.homedir()),
        directoryIsWritable: () => canCreateFileNextTo(execPath),
    };
}
