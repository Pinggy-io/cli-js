import fs from "fs";
import os from "os";
import path from "path";
import { autostartFilePath, installerBinaryPath } from "../../daemon/lifecycle/servicePaths.js";
import { getPinggyConfigDir } from "../../utils/configDir.js";
import { isPackagedBinary } from "../terminal/nodePtyRuntime.js";
import { FileCallTimeoutError, FileSystemRemover, callWithTimeout } from "./fileSystem.js";

/**
 * The folders a delete never removes: a filesystem root, the agent user's home folder, the agent's config
 * folder and everything in it, what Pinggy runs from and the file that starts it at sign-in, every folder
 * above these, the OS's own system folders, and the folder of accounts with each account in it.
 *
 * Matched by device and inode, not by path text. A symlink above the item, home on another disk, a
 * letter-case difference on macOS, a Windows short name and a bind mount each reach a protected folder
 * by other text, and each reaches the same `(dev, ino)`. Each protected path counts twice, as the link
 * itself and as what it points at, so a home folder that is a symlink is protected both ways.
 *
 * Read when each delete starts, not once: a folder deleted and made again has a new inode, and a disk
 * can be mounted while the agent runs. A read that times out fails the delete: a protected folder that
 * could not be read must not count as absent.
 */

export const MESSAGE_PINGGY_FOLDER = "Pinggy keeps this folder so the device stays connected.";
export const MESSAGE_PINGGY_PROGRAM = "Pinggy needs this to keep the device connected.";
export const MESSAGE_SYSTEM_FOLDER = "This is a system folder.";
export const MESSAGE_ACCOUNTS_FOLDER = "This folder holds the accounts on this device.";
export const MESSAGE_ACCOUNT_FOLDER = "This is an account's home folder.";

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

/**
 * The accounts folder. An agent running as root has `/root` as home, so without this `/home` and every account
 * in it would be deletable.
 */
const POSIX_ACCOUNTS_FOLDER = "/home";
const MACOS_ACCOUNTS_FOLDER = "/Users";
const WINDOWS_ACCOUNTS_FOLDER = "C:\\Users";
/** `C:\Users\Public`. Its parent follows a profiles folder moved off `C:`. */
const WINDOWS_PUBLIC_FOLDER_VARIABLE = "PUBLIC";

/** The paths a delete protects, as text. Tests point them at a temp folder. */
export interface ProtectedSources {
    home: string;
    configFolder: string;
    systemFolders: string[];
    /** Protected with every account directly in it. */
    accountsFolder: string;
    /**
     * What Pinggy runs from and what starts it at sign-in. Each is protected by the path given and by its real
     * path, each with every folder above it. A path that does not exist protects nothing.
     */
    agentFiles: string[];
}

/** What a delete matches against, by `(dev, ino)` as text. */
export interface ProtectedSet {
    /** Each protected folder's identity, mapped to the message its refusal carries. */
    reasons: Map<string, string>;
    /** What the config folder resolves to, for the check on the folder an item is in. Null when it cannot be read. */
    configFolder: string | null;
    /** What the accounts folder resolves to, for the check on the folder an item is in. Null when it cannot be read. */
    accountsFolder: string | null;
}

export function systemFoldersFor(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
    if (platform === "win32") {
        return WINDOWS_SYSTEM_FOLDER_VARIABLES.map(([variable, fallback]) => environment[variable] || fallback);
    }
    return platform === "darwin" ? MACOS_SYSTEM_FOLDERS : LINUX_SYSTEM_FOLDERS;
}

export function accountsFolderFor(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
    if (platform === "win32") {
        const publicFolder = environment[WINDOWS_PUBLIC_FOLDER_VARIABLE];
        return publicFolder ? path.win32.dirname(publicFolder) : WINDOWS_ACCOUNTS_FOLDER;
    }
    return platform === "darwin" ? MACOS_ACCOUNTS_FOLDER : POSIX_ACCOUNTS_FOLDER;
}

/**
 * The installed binary, the program running now and, when that is `node`, the script it runs, then the
 * autostart file. A packaged binary's script lives inside the binary, so it has none.
 */
export function agentFilesFor(platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv,
                              runningProgram: string, script: string | undefined): string[] {
    const files = [installerBinaryPath(platform, home, environment), runningProgram];
    if (script) {
        files.push(script);
    }
    const autostartFile = autostartFilePath(platform, home);
    if (autostartFile) {
        files.push(autostartFile);
    }
    // The installed binary is usually the running program too.
    return [...new Set(files)];
}

export function machineProtectedSources(): ProtectedSources {
    const home = os.homedir();
    const script = isPackagedBinary() ? undefined : process.argv[1];
    return {
        home,
        configFolder: getPinggyConfigDir(),
        systemFolders: systemFoldersFor(process.platform, process.env),
        accountsFolder: accountsFolderFor(process.platform, process.env),
        agentFiles: agentFilesFor(process.platform, home, process.env, process.execPath, script),
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

/** The identity `read` gives, or null when it fails. A timeout is thrown, to fail the delete. */
function identityOrNull(read: Promise<fs.BigIntStats>, callTimeoutMillis: number): Promise<string | null> {
    return callWithTimeout(read, callTimeoutMillis).then(identityOf, (err: unknown) => {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        return null;
    });
}

/** The link itself and what it points at. A side that cannot be read, a folder that does not exist, is left out. */
async function identitiesOf(target: string, remover: FileSystemRemover, callTimeoutMillis: number):
    Promise<string[]> {
    const identities = await Promise.all([remover.lstat(target), remover.stat(target)]
        .map((read) => identityOrNull(read, callTimeoutMillis)));
    return identities.filter((identity): identity is string => identity !== null);
}

/** `target` with every link resolved. Null when it does not exist, so it protects nothing. A timeout is thrown. */
async function realPathOrNull(target: string, remover: FileSystemRemover, callTimeoutMillis: number):
    Promise<string | null> {
    try {
        return await callWithTimeout(remover.realpath(target), callTimeoutMillis);
    } catch (err) {
        if (err instanceof FileCallTimeoutError) {
            throw err;
        }
        return null;
    }
}

/** Each agent file that exists, as given and as its real path, each with every folder above it. */
async function agentFileChains(files: string[], paths: path.PlatformPath, remover: FileSystemRemover,
                               callTimeoutMillis: number): Promise<string[]> {
    const realPaths = await Promise.all(files.map((file) => realPathOrNull(file, remover, callTimeoutMillis)));
    return files.flatMap((file, index) => {
        const realPath = realPaths[index];
        return realPath === null ? [] : [...selfAndAncestors(file, paths), ...selfAndAncestors(realPath, paths)];
    });
}

async function addFolders(reasons: Map<string, string>, folders: string[], message: string,
                          remover: FileSystemRemover, callTimeoutMillis: number): Promise<void> {
    const identities = await Promise.all(folders.map((folder) => identitiesOf(folder, remover, callTimeoutMillis)));
    for (const identity of identities.flat()) {
        reasons.set(identity, message);
    }
}

/**
 * Reads every protected folder's identity. Each later group's message wins on a folder 2 groups share: a
 * system folder above `node` says it is a system folder, and the root, above everything, carries the Pinggy
 * message. Throws a {@link FileCallTimeoutError} when a read times out.
 */
export async function readProtectedSet(sources: ProtectedSources, paths: path.PlatformPath,
                                       remover: FileSystemRemover, callTimeoutMillis: number):
    Promise<ProtectedSet> {
    const reasons = new Map<string, string>();
    const agentChains = await agentFileChains(sources.agentFiles, paths, remover, callTimeoutMillis);
    await addFolders(reasons, agentChains, MESSAGE_PINGGY_PROGRAM, remover, callTimeoutMillis);
    const systemChains = sources.systemFolders.flatMap((folder) => selfAndAncestors(folder, paths));
    await addFolders(reasons, systemChains, MESSAGE_SYSTEM_FOLDER, remover, callTimeoutMillis);
    await addFolders(reasons, selfAndAncestors(sources.accountsFolder, paths), MESSAGE_ACCOUNTS_FOLDER, remover,
        callTimeoutMillis);
    const pinggyChains = [...selfAndAncestors(sources.home, paths), ...selfAndAncestors(sources.configFolder, paths)];
    await addFolders(reasons, pinggyChains, MESSAGE_PINGGY_FOLDER, remover, callTimeoutMillis);

    const [configFolder, accountsFolder] = await Promise.all([sources.configFolder, sources.accountsFolder]
        .map((folder) => identityOrNull(remover.stat(folder), callTimeoutMillis)));
    return { reasons, configFolder, accountsFolder };
}

/**
 * True when `directory`, or a folder above it, is the config folder. Every name in it is then protected:
 * a file such as `device.json` has an identity of its own, which the set of folders does not hold.
 * `stat` follows links, so a `directory` that is a link into the config folder counts too. Throws a
 * {@link FileCallTimeoutError} when a read times out.
 */
export async function isInsideConfigFolder(directory: string, protectedSet: ProtectedSet,
                                           paths: path.PlatformPath, remover: FileSystemRemover,
                                           callTimeoutMillis: number): Promise<boolean> {
    if (protectedSet.configFolder === null) {
        return false;
    }
    const chain = selfAndAncestors(directory, paths);
    const identities = await Promise.all(chain.map((folder) =>
        identityOrNull(remover.stat(folder), callTimeoutMillis)));
    return identities.includes(protectedSet.configFolder);
}
