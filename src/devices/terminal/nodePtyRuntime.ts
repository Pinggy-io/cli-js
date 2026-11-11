import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { getPinggyConfigDir } from "../../utils/configDir.js";

/**
 * Where `node-pty` is loaded from.
 *
 * Inside a `pkg` binary the package resolves to `/snapshot/...`, a virtual filesystem pkg implements
 * by patching `fs`. The kernel never sees it. On macOS `node-pty` derives the path of `spawn-helper`
 * from wherever its own module sits, then execs that path to fork the shell, so a packaged binary execs
 * a file the kernel cannot find and `posix_spawn` fails with ENOENT. That throw is fatal inside the
 * addon: the process dies before any caller can answer for it.
 *
 * So a packaged binary copies the package onto real disk and loads it from there, on every platform.
 * Every path node-pty derives afterwards is a real one. The copy is per node-pty version and per
 * architecture, so it happens once. A CLI upgrade that keeps the node-pty version reuses it.
 *
 * node-pty ships no Linux prebuild. On Linux `npm ci` compiles `build/Release/pty.node`, and
 * `pkg.assets` in package.json packs it, since node-pty's `files` list leaves `build/` out.
 *
 * The Pinggy app has the same problem. Electron serves the app's files from an `.asar`
 * archive that only Electron's patched `fs` reads. node-pty rewrites the helper's path from `app.asar`
 * to `app.asar.unpacked`, but the app unpacks `*.node` files only, so `spawn-helper` is not there and
 * the first terminal kills the app. A package that resolves inside an `.asar` archive is copied out the
 * same way.
 */

const require = createRequire(import.meta.url);

const PACKAGE_NAME = "node-pty";
const NATIVE_FILE = "pty.node";
const SPAWN_HELPER_FILE = "spawn-helper";
const EXECUTABLE_MODE = 0o755;
const EXECUTE_BITS = 0o111;
const RUNTIME_DIR_NAME = "runtime";
const ASAR_ARCHIVE_SUFFIX = ".asar";

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

/** A path inside an Electron `.asar` archive, such as the Pinggy app's `app.asar`. */
export function isInsideAsarArchive(packageRoot: string): boolean {
    if (!process.versions.electron) return false;
    return packageRoot.split(path.sep).some((segment) => segment.endsWith(ASAR_ARCHIVE_SUFFIX));
}

/**
 * The directory node-pty is loaded from. Unpacks it first when this is a packaged binary, or when the
 * package sits inside an Electron `.asar` archive.
 */
export function resolveNodePtyRoot(): string {
    const resolvedRoot = path.dirname(require.resolve(`${PACKAGE_NAME}/package.json`));
    if (!isPackagedBinary() && !isInsideAsarArchive(resolvedRoot)) return resolvedRoot;
    return unpackNodePty(resolvedRoot);
}

/** Loads node-pty from a root on real disk, so every path it derives afterwards is a real one. */
export function requireNodePty(packageRoot: string): NodePty {
    return require(packageRoot) as NodePty;
}

/**
 * Every place `spawn-helper` can sit under a node-pty root. Only macOS has a helper: node-pty builds it
 * there alone. Linux forks the shell with `forkpty()`, and Windows uses ConPTY.
 */
export function spawnHelperPaths(packageRoot: string, platform: NodeJS.Platform = process.platform): string[] {
    if (platform !== "darwin") return [];
    return NATIVE_DIRECTORIES.map((directory) => path.join(packageRoot, directory, SPAWN_HELPER_FILE));
}

/**
 * True when a `spawn-helper` under this root is a file the kernel can exec, or when this platform needs
 * no helper. A spawn whose helper is missing kills the process from inside the addon, so a terminal is
 * offered only when this holds.
 */
export function hasExecutableSpawnHelper(packageRoot: string, platform: NodeJS.Platform = process.platform): boolean {
    const helpers = spawnHelperPaths(packageRoot, platform);
    if (helpers.length === 0) return true;
    return helpers.some((helper) => {
        try {
            const stat = fs.statSync(helper);
            return stat.isFile() && (stat.mode & EXECUTE_BITS) !== 0;
        } catch {
            return false;
        }
    });
}

/** Restores the execute bit wherever the helper exists under this root. */
export function makeSpawnHelperExecutable(packageRoot: string): void {
    for (const helper of spawnHelperPaths(packageRoot)) {
        try {
            const stat = fs.statSync(helper);
            if ((stat.mode & EXECUTE_BITS) === 0) {
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
        removeIncompleteCopy(unpackedRoot);
        fs.renameSync(stagingRoot, unpackedRoot);
    } catch (error) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        // Another process may have committed its own copy first, which is the one to use.
        if (!isLoadable(unpackedRoot)) throw error;
    }
    return unpackedRoot;
}

/**
 * A copy without the addon blocks the rename: `rename(2)` does not replace a directory that has files in
 * it. Linux binaries up to 0.6.5 carried no `pty.node` and left such a copy behind. Checked again right
 * before the delete, so a complete copy another agent just committed stays.
 */
function removeIncompleteCopy(unpackedRoot: string): void {
    if (!isLoadable(unpackedRoot)) fs.rmSync(unpackedRoot, { recursive: true, force: true });
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
