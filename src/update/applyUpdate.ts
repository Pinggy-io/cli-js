/**
 * The operations that differ by install kind, behind 1 interface, so the explicit command and the background update
 * run the same swap.
 */
import fs from "node:fs";
import { downloadAndVerify, DownloadDependencies, defaultDownloadDependencies, PinggyBinaryRunner, runPinggyBinary } from "./binaryUpdater.js";
import { InstallKind, InstallProbe, unixLayoutPaths } from "./installKind.js";
import {
    installVersion,
    nothingToRollBack,
    readLinkVersion,
    rollbackUnixVersion,
    unixDownloadPath,
    versionBinaryPath,
} from "./unixLinkSwap.js";
import { readUpdateState, writeUpdateState } from "./updateState.js";
import {
    realWindowsFileOperations,
    rollbackWindowsBinary,
    RollbackResult,
    swapWindowsBinary,
    windowsDownloadPath,
    windowsInstallPaths,
} from "./windowsSwap.js";

export interface VerifiedDownload {
    newVersion: string;
    runningVersion: string;
}

export interface UpdateTarget {
    downloadPath: string;
    /** The binary to run the rollback target of, once a rollback has moved it into place. */
    rollbackBinaryPath(version: string): string;
    installedVersion(runningVersion: string): string;
    prepareDownload(): void;
    install(download: VerifiedDownload): Promise<void> | void;
    rollback(runningVersion: string): Promise<RollbackResult> | RollbackResult;
}

function windowsUpdateTarget(execPath: string, runBinary: PinggyBinaryRunner): UpdateTarget {
    return {
        downloadPath: windowsDownloadPath(execPath),
        rollbackBinaryPath: () => windowsInstallPaths(execPath).livePath,
        installedVersion: (runningVersion) => runningVersion,
        prepareDownload: () => undefined,
        install: ({ newVersion, runningVersion }) => swapWindowsBinary(
            { execPath, downloadPath: windowsDownloadPath(execPath), newVersion, runningVersion },
            realWindowsFileOperations,
            runBinary,
        ),
        rollback: async (runningVersion) => {
            const result = await rollbackWindowsBinary(
                { execPath, runningVersion, latestVersion: readUpdateState().latestVersion },
                realWindowsFileOperations,
                runBinary,
            );
            writeUpdateState({ rolledBackFromVersion: result.from });
            return result;
        },
    };
}

function unixUpdateTarget(kind: InstallKind, probe: InstallProbe): UpdateTarget {
    const layout = unixLayoutPaths(probe.homeRealPath);
    const isPlainFile = kind === InstallKind.UnixPlainFile;
    return {
        downloadPath: unixDownloadPath(layout),
        rollbackBinaryPath: (version) => versionBinaryPath(layout, version),
        installedVersion: (runningVersion) => readLinkVersion(layout) ?? runningVersion,
        prepareDownload: () => { fs.mkdirSync(layout.versionsDirectory, { recursive: true }); },
        install: ({ newVersion, runningVersion }) => installVersion({
            layout, plainFileToConvert: isPlainFile ? probe.execPath : null, newVersion, runningVersion,
        }),
        rollback: () => {
            if (isPlainFile) throw nothingToRollBack();
            return rollbackUnixVersion(layout);
        },
    };
}

/** @returns null for a kind that cannot replace itself */
export function createUpdateTarget(kind: InstallKind, probe: InstallProbe, runBinary: PinggyBinaryRunner = runPinggyBinary): UpdateTarget | null {
    switch (kind) {
        case InstallKind.WindowsWritable:
            return windowsUpdateTarget(probe.execPath, runBinary);
        case InstallKind.UnixLayout:
        case InstallKind.UnixPlainFile:
            return unixUpdateTarget(kind, probe);
        default:
            return null;
    }
}

export function downloadRelease(
    target: UpdateTarget,
    tag: string,
    assetName: string,
    runningVersion: string,
    dependencies: DownloadDependencies = defaultDownloadDependencies,
): Promise<void> {
    target.prepareDownload();
    return downloadAndVerify({ tag, assetName, tempPath: target.downloadPath, runningVersion }, dependencies);
}
