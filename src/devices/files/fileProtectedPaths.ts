import os from "os";
import path from "path";
import { getPinggyConfigDir } from "../../utils/configDir.js";
import { FileSystemRemover, callWithTimeout } from "./fileSystem.js";

/**
 * The folders a delete never removes: a filesystem root, the agent user's home folder, the agent's config
 * folder and everything in it, every folder above these, and the OS's own system folders.
 *
 * Matched by device and inode, not by path text. A symlink above the item, home on another disk, a
 * letter-case difference on macOS, a Windows short name and a bind mount each reach a protected folder
 * by other text, and each reaches the same `(dev, ino)`. Each protected path counts twice, as the link
 * itself and as what it points at, so a home folder that is a symlink is protected both ways.
 *
 * Read when each delete starts, not once: a folder deleted and made again has a new inode, and a disk
 * can be mounted while the agent runs.
 */

export const MESSAGE_PINGGY_FOLDER = "Pinggy keeps this folder so the device stays connected.";
export const MESSAGE_SYSTEM_FOLDER = "This is a system folder.";

/** The OS refuses these to a normal user already. The list matters for an agent that runs as root. */
const LINUX_SYSTEM_FOLDERS = ["/bin", "/boot", "/etc", "/lib", "/lib64", "/sbin", "/usr", "/var"];
const MACOS_SYSTEM_FOLDERS = ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private"];

/** Windows names its system folders in the environment. Each default is where a standard install puts it. */
const WINDOWS_SYSTEM_FOLDER_VARIABLES: ReadonlyArray<readonly [string, string]> = [
    ["SystemRoot", "C:\\Windows"],
    ["ProgramFiles", "C:\\Program Files"],
    ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
    ["ProgramData", "C:\\ProgramData"],
];

/** The paths a delete protects, as text. Tests point them at a temp folder. */
export interface ProtectedSources {
    home: string;
    configFolder: string;
    systemFolders: string[];
}

/** What a delete matches against, by `(dev, ino)` as text. */
export interface ProtectedSet {
    /** Each protected folder's identity, mapped to the message its refusal carries. */
    reasons: Map<string, string>;
    /** What the config folder resolves to, for the check on `directory`. Null when it cannot be read. */
    configFolder: string | null;
}

export function systemFoldersFor(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
    if (platform === "win32") {
        return WINDOWS_SYSTEM_FOLDER_VARIABLES.map(([variable, fallback]) => environment[variable] || fallback);
    }
    return platform === "darwin" ? MACOS_SYSTEM_FOLDERS : LINUX_SYSTEM_FOLDERS;
}

export function machineProtectedSources(): ProtectedSources {
    return {
        home: os.homedir(),
        configFolder: getPinggyConfigDir(),
        systemFolders: systemFoldersFor(process.platform, process.env),
    };
}

/** `dev:ino`, so a Set or a Map can hold an identity. */
export function identityOf(stats: { dev: bigint; ino: bigint }): string {
    return `${stats.dev}:${stats.ino}`;
}

/** The path itself, then each folder above it, ending at the root. */
export function selfAndAncestors(target: string, paths: path.PlatformPath): string[] {
    const chain: string[] = [];
    let current = paths.resolve(target);
    for (;;) {
        chain.push(current);
        const parent = paths.dirname(current);
        if (parent === current) {
            return chain;
        }
        current = parent;
    }
}

/** The link itself and what it points at. A side that cannot be read, a folder that does not exist, is left out. */
async function identitiesOf(target: string, remover: FileSystemRemover, callTimeoutMillis: number):
    Promise<string[]> {
    const reads = [remover.lstat(target), remover.stat(target)]
        .map((read) => callWithTimeout(read, callTimeoutMillis).then(identityOf, () => null));
    const identities = await Promise.all(reads);
    return identities.filter((identity): identity is string => identity !== null);
}

async function addFolders(reasons: Map<string, string>, folders: string[], message: string,
                          remover: FileSystemRemover, callTimeoutMillis: number): Promise<void> {
    const identities = await Promise.all(folders.map((folder) => identitiesOf(folder, remover, callTimeoutMillis)));
    for (const identity of identities.flat()) {
        reasons.set(identity, message);
    }
}

/**
 * Reads every protected folder's identity. System folders go in first, so the root, which is above both
 * a system folder and home, carries the Pinggy message.
 */
export async function readProtectedSet(sources: ProtectedSources, paths: path.PlatformPath,
                                       remover: FileSystemRemover, callTimeoutMillis: number):
    Promise<ProtectedSet> {
    const reasons = new Map<string, string>();
    const systemChains = sources.systemFolders.flatMap((folder) => selfAndAncestors(folder, paths));
    await addFolders(reasons, systemChains, MESSAGE_SYSTEM_FOLDER, remover, callTimeoutMillis);
    const pinggyChains = [...selfAndAncestors(sources.home, paths), ...selfAndAncestors(sources.configFolder, paths)];
    await addFolders(reasons, pinggyChains, MESSAGE_PINGGY_FOLDER, remover, callTimeoutMillis);

    const configFolder = await callWithTimeout(remover.stat(sources.configFolder), callTimeoutMillis)
        .then(identityOf, () => null);
    return { reasons, configFolder };
}

/**
 * True when `directory`, or a folder above it, is the config folder. Every name in it is then protected:
 * a file such as `device.json` has an identity of its own, which the set of folders does not hold.
 * `stat` follows links, so a `directory` that is a link into the config folder counts too.
 */
export async function isInsideConfigFolder(directory: string, protectedSet: ProtectedSet,
                                           paths: path.PlatformPath, remover: FileSystemRemover,
                                           callTimeoutMillis: number): Promise<boolean> {
    if (protectedSet.configFolder === null) {
        return false;
    }
    const chain = selfAndAncestors(directory, paths);
    const identities = await Promise.all(chain.map((folder) =>
        callWithTimeout(remover.stat(folder), callTimeoutMillis).then(identityOf, () => null)));
    return identities.includes(protectedSet.configFolder);
}
