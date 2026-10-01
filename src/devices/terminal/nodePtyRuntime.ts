import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { getPinggyConfigDir } from "../../utils/configDir.js";

/**
 * Where `node-pty` is loaded from.
 *
 * Inside a `pkg` binary the package resolves to `/snapshot/...`, a virtual filesystem pkg implements
 * by patching `fs`. The kernel never sees it. `node-pty` derives the path of `spawn-helper` from
 * wherever its own module sits, then execs that path to fork the shell, so a packaged binary execs a
 * file the kernel cannot find and `posix_spawn` fails with ENOENT. That throw is fatal inside the
 * addon: the process dies before any caller can answer for it.
 *
 * So a packaged binary copies the package onto real disk and loads it from there. Every path
 * node-pty derives afterwards is a real one. The copy is per version and per architecture, so it
 * happens once and an upgrade never reuses the old one.
 */

const require = createRequire(import.meta.url);

const PACKAGE_NAME = "node-pty";
const NATIVE_FILE = "pty.node";
const SPAWN_HELPER_FILE = "spawn-helper";
const EXECUTABLE_MODE = 0o755;
const RUNTIME_DIR_NAME = "runtime";

/** The 2 layouts node-pty loads its addon from: a source build, or a shipped prebuild. */
const NATIVE_DIRECTORIES = [
    path.join("build", "Release"),
    path.join("prebuilds", `${process.platform}-${process.arch}`),
];

export type NodePty = typeof import("node-pty");

/** `pkg` sets this on the process object. Nothing else does. */
export function isPackagedBinary(): boolean {
    return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

/** The directory node-pty is loaded from. Unpacks it first when this is a packaged binary. */
export function resolveNodePtyRoot(): string {
    const resolvedRoot = path.dirname(require.resolve(`${PACKAGE_NAME}/package.json`));
    if (!isPackagedBinary()) return resolvedRoot;
    return unpackNodePty(resolvedRoot);
}

/** Loads node-pty from a root on real disk, so every path it derives afterwards is a real one. */
export function requireNodePty(packageRoot: string): NodePty {
    return require(packageRoot) as NodePty;
}

/** Every place `spawn-helper` can sit under a node-pty root. Windows has no helper. */
export function spawnHelperPaths(packageRoot: string): string[] {
    if (process.platform === "win32") return [];
    return NATIVE_DIRECTORIES.map((directory) => path.join(packageRoot, directory, SPAWN_HELPER_FILE));
}

/** Restores the execute bit wherever the helper exists under this root. */
export function makeSpawnHelperExecutable(packageRoot: string): void {
    for (const helper of spawnHelperPaths(packageRoot)) {
        try {
            const stat = fs.statSync(helper);
            if ((stat.mode & 0o111) === 0) {
                fs.chmodSync(helper, EXECUTABLE_MODE);
            }
        } catch {
            // Not this layout. Try the next one.
        }
    }
}

function unpackNodePty(snapshotRoot: string): string {
    const unpackedRoot = unpackedRootPath(snapshotRoot);
    if (isLoadable(unpackedRoot)) return unpackedRoot;

    // Staged under a sibling name and renamed into place, so 2 agents starting at once never load a
    // half-written copy. The rename is the commit.
    const stagingRoot = `${unpackedRoot}.${process.pid}`;
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    try {
        copyRuntimeFiles(snapshotRoot, stagingRoot);
        makeSpawnHelperExecutable(stagingRoot);
        fs.renameSync(stagingRoot, unpackedRoot);
    } catch (error) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        // Another process may have committed its own copy first, which is the one to use.
        if (!isLoadable(unpackedRoot)) throw error;
    }
    return unpackedRoot;
}

function unpackedRootPath(snapshotRoot: string): string {
    const version = readPackageVersion(snapshotRoot);
    const directoryName = `${PACKAGE_NAME}-${version}-${process.platform}-${process.arch}`;
    return path.join(getPinggyConfigDir(), RUNTIME_DIR_NAME, directoryName);
}

function readPackageVersion(packageRoot: string): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return String(manifest.version);
}

/** A copy is only ever renamed into place complete, so the addon being there means the rest is. */
function isLoadable(packageRoot: string): boolean {
    if (!fs.existsSync(path.join(packageRoot, "package.json"))) return false;
    return NATIVE_DIRECTORIES.some((directory) => fs.existsSync(path.join(packageRoot, directory, NATIVE_FILE)));
}

/**
 * The runtime needs 3 things: the manifest that names the entry point, the JavaScript, and this
 * platform's native directory. The other prebuilds are 58 MB of other people's architectures.
 */
function copyRuntimeFiles(sourceRoot: string, targetRoot: string): void {
    fs.mkdirSync(targetRoot, { recursive: true });
    copyFile(path.join(sourceRoot, "package.json"), path.join(targetRoot, "package.json"));
    copyDirectory(path.join(sourceRoot, "lib"), path.join(targetRoot, "lib"));
    for (const directory of NATIVE_DIRECTORIES) {
        const source = path.join(sourceRoot, directory);
        if (fs.existsSync(source)) {
            copyDirectory(source, path.join(targetRoot, directory));
        }
    }
}

/**
 * Written out by hand because `fs.cpSync` does not work here. Inside pkg the source is served by a
 * shim that implements `readdir` and `readFile`, not the bulk copy primitives.
 */
function copyDirectory(sourceDirectory: string, targetDirectory: string): void {
    fs.mkdirSync(targetDirectory, { recursive: true });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        const source = path.join(sourceDirectory, entry.name);
        const target = path.join(targetDirectory, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(source, target);
            continue;
        }
        copyFile(source, target);
    }
}

function copyFile(source: string, target: string): void {
    fs.writeFileSync(target, fs.readFileSync(source));
}
