/**
 * What the `pinggy` command runs, found as scripts/install/install.sh and install.ps1 find it. A change to how either
 * script recognizes an npm copy changes this file in the same commit.
 */
import fs from "node:fs";
import path from "node:path";

const NPM_PACKAGE = "pinggy";
const UNIX_NPM_SEGMENT = `/lib/node_modules/${NPM_PACKAGE}/`;
const DEFAULT_PATH_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";
/** PowerShell also runs the pinggy.ps1 launcher npm writes next to pinggy.cmd. */
const POWERSHELL_SCRIPT_EXTENSION = ".ps1";
const CURRENT_FOLDER = ".";

export interface NpmCopy {
    /** The npm global folder, for `npm uninstall -g --prefix`. */
    prefix: string;
    packageFolder: string;
}

export interface PinggyCommand {
    /** The file PATH leads to, before links are resolved, as `which pinggy` prints it. */
    commandPath: string;
    npm: NpmCopy | null;
}

export interface PathFileSystem {
    /** On Windows a plain file counts, since Windows has no executable bit. */
    isExecutableFile(filePath: string): boolean;
    isFile(filePath: string): boolean;
    realPath(filePath: string): string | null;
    /** True for a symlink, and for a Windows junction, which `npm link` makes. */
    isLink(filePath: string): boolean;
}

export interface PathLookup {
    platform: NodeJS.Platform;
    pathValue: string;
    pathExtensions: string | undefined;
    files: PathFileSystem;
}

function pathModule(platform: NodeJS.Platform): path.PlatformPath {
    return platform === "win32" ? path.win32 : path.posix;
}

/** An empty entry and `.` mean the current folder, which is often the folder holding a download. */
export function pathFolders(platform: NodeJS.Platform, pathValue: string): string[] {
    const separator = platform === "win32" ? ";" : ":";
    return pathValue.split(separator).filter((folder) => folder !== "" && folder !== CURRENT_FOLDER);
}

/** The names Windows tries for `name`, in PATHEXT order, then the PowerShell launcher. */
export function windowsCommandNames(name: string, pathExtensions: string | undefined): string[] {
    const extensions = (pathExtensions || DEFAULT_PATH_EXTENSIONS).split(";").filter(Boolean);
    return [...extensions, POWERSHELL_SCRIPT_EXTENSION].map((extension) => `${name}${extension.toLowerCase()}`);
}

/** The first file named 1 of `names` in a PATH folder, with folders in PATH order. */
export function findOnPath(names: string[], lookup: PathLookup): string | null {
    const paths = pathModule(lookup.platform);
    for (const folder of pathFolders(lookup.platform, lookup.pathValue)) {
        for (const name of names) {
            const candidate = paths.join(folder, name);
            if (lookup.files.isExecutableFile(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * macOS/Linux: the real file is under `<prefix>/lib/node_modules/pinggy/`. An `npm link` copy resolves into its
 * checkout, and yarn and bun keep no `lib/` in the path, so neither matches.
 *
 * Windows: npm's launchers are files, so the folder decides: it holds `node_modules\pinggy\package.json`, and that
 * package folder is not the junction `npm link` makes.
 */
export function npmCopyFor(commandPath: string, lookup: PathLookup): NpmCopy | null {
    if (lookup.platform === "win32") {
        const folder = path.win32.dirname(commandPath);
        const packageFolder = path.win32.join(folder, "node_modules", NPM_PACKAGE);
        const isPackage = lookup.files.isFile(path.win32.join(packageFolder, "package.json"));
        return isPackage && !lookup.files.isLink(packageFolder) ? { prefix: folder, packageFolder } : null;
    }
    const realPath = lookup.files.realPath(commandPath);
    const segmentStart = realPath?.indexOf(UNIX_NPM_SEGMENT) ?? -1;
    if (realPath === null || segmentStart < 0) return null;
    const prefix = realPath.slice(0, segmentStart);
    return { prefix, packageFolder: path.posix.join(prefix, "lib", "node_modules", NPM_PACKAGE) };
}

export function findPinggyCommand(lookup: PathLookup): PinggyCommand | null {
    const names = lookup.platform === "win32" ? windowsCommandNames(NPM_PACKAGE, lookup.pathExtensions) : [NPM_PACKAGE];
    const commandPath = findOnPath(names, lookup);
    if (commandPath === null) return null;
    return { commandPath, npm: npmCopyFor(commandPath, lookup) };
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function realPathFileSystem(platform: NodeJS.Platform): PathFileSystem {
    return {
        isExecutableFile: (filePath) => {
            if (!isFile(filePath)) return false;
            if (platform === "win32") return true;
            try {
                fs.accessSync(filePath, fs.constants.X_OK);
                return true;
            } catch {
                return false;
            }
        },
        isFile,
        realPath: (filePath) => {
            try {
                return fs.realpathSync(filePath);
            } catch {
                return null;
            }
        },
        isLink: (filePath) => {
            try {
                return fs.lstatSync(filePath).isSymbolicLink();
            } catch {
                return false;
            }
        },
    };
}

export function processPathLookup(): PathLookup {
    return {
        platform: process.platform,
        pathValue: process.env.PATH ?? process.env.Path ?? "",
        pathExtensions: process.env.PATHEXT,
        files: realPathFileSystem(process.platform),
    };
}
