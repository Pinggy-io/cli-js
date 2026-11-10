import { beforeEach, describe, expect, test } from "@jest/globals";
import { PinggyBinaryRunner, UpdateError, UpdateErrorCode } from "../update/binaryUpdater.js";
import {
    removeStaleUpdateFiles,
    rollbackWindowsBinary,
    StaleFileOperations,
    swapWindowsBinary,
    windowsInstallPaths,
    WindowsFileOperations,
} from "../update/windowsSwap.js";

const FOLDER = "C:\\Users\\me\\Downloads";
const LIVE = `${FOLDER}\\pinggy.exe`;
const BACKUP = `${FOLDER}\\pinggy.prev.exe`;
const DOWNLOAD = `${FOLDER}\\pinggy.exe.77.new.exe`;

/** An in-memory folder: path to the version the file would report. */
let files: Map<string, string>;
let clock: number;
/** Rename failures to throw, consumed in order, keyed by the rename's destination. */
let renameFailures: Map<string, string[]>;
let copyFailure: string | null;

function errnoError(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(code);
    error.code = code;
    return error;
}

const operations: WindowsFileOperations = {
    exists: (filePath) => files.has(filePath),
    copyFile: (from, to) => {
        if (copyFailure === to) throw errnoError("EPERM");
        const content = files.get(from);
        if (content === undefined) throw errnoError("ENOENT");
        files.set(to, content);
    },
    rename: (from, to) => {
        const code = renameFailures.get(to)?.shift();
        if (code) throw errnoError(code);
        const content = files.get(from);
        if (content === undefined) throw errnoError("ENOENT");
        files.delete(from);
        files.set(to, content);
    },
    sleepMillis: () => undefined,
    nowMillis: () => ++clock,
};

const runBinary: PinggyBinaryRunner = async (binaryPath) => {
    const version = files.get(binaryPath);
    if (version === undefined || version === "corrupt") throw new Error("does not run");
    return `Pinggy CLI version: ${version}\n`;
};

const oldFiles = (): string[] => [...files.keys()].filter((name) => name.endsWith(".old"));
const request = { execPath: LIVE, downloadPath: DOWNLOAD, newVersion: "0.6.5", runningVersion: "0.6.4" };
const swap = (runner: PinggyBinaryRunner = runBinary): Promise<void> => swapWindowsBinary(request, operations, runner);

async function failureOf(promise: Promise<unknown>): Promise<UpdateError> {
    const error = await promise.then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(UpdateError);
    return error as UpdateError;
}

beforeEach(() => {
    files = new Map([[LIVE, "0.6.4"], [DOWNLOAD, "0.6.5"]]);
    clock = 1000;
    renameFailures = new Map();
    copyFailure = null;
});

describe("windowsInstallPaths", () => {
    test("the backup name comes from the live name", () => {
        expect(windowsInstallPaths(LIVE).backupPath).toBe(BACKUP);
        expect(windowsInstallPaths(`${FOLDER}\\pinggy-win-x64.exe`).backupPath).toBe(`${FOLDER}\\pinggy-win-x64.prev.exe`);
    });

    test("from the backup, the live name is the backup's name without .prev", () => {
        const paths = windowsInstallPaths(BACKUP);
        expect(paths.runningFromBackup).toBe(true);
        expect(paths.livePath).toBe(LIVE);
        expect(paths.backupPath).toBe(BACKUP);
    });
});

describe("swapWindowsBinary", () => {
    test("a good swap leaves the new binary live, the old one as backup, and 1 .old", async () => {
        await swap();
        expect(files.get(LIVE)).toBe("0.6.5");
        expect(files.get(BACKUP)).toBe("0.6.4");
        expect(files.has(DOWNLOAD)).toBe(false);
        expect(oldFiles()).toHaveLength(1);
    });

    test("a binary saved under another name keeps it", async () => {
        const other = `${FOLDER}\\pinggy-win-x64.exe`;
        files = new Map([[other, "0.6.4"], [DOWNLOAD, "0.6.5"]]);
        await swapWindowsBinary({ ...request, execPath: other }, operations, runBinary);
        expect(files.get(other)).toBe("0.6.5");
        expect(files.get(`${FOLDER}\\pinggy-win-x64.prev.exe`)).toBe("0.6.4");
    });

    test("a failed copy to the backup stops the update before any rename", async () => {
        copyFailure = BACKUP;
        const error = await failureOf(swap());
        expect(error.code).toBe(UpdateErrorCode.RenameFailed);
        expect(files.get(LIVE)).toBe("0.6.4");
        expect(files.has(DOWNLOAD)).toBe(true);
    });

    test("a rename a scanner holds finishes after a retry", async () => {
        renameFailures.set(LIVE, ["EBUSY", "EPERM"]);
        await swap();
        expect(files.get(LIVE)).toBe("0.6.5");
    });

    test("the 2nd rename fails and the old binary comes back", async () => {
        renameFailures.set(LIVE, ["ENOSPC"]);
        const error = await failureOf(swap());
        expect(error.code).toBe(UpdateErrorCode.RenameFailed);
        expect(files.get(LIVE)).toBe("0.6.4");
        expect(oldFiles()).toHaveLength(0);
    });

    test("a rename that stays busy gives up, and the old binary still comes back", async () => {
        renameFailures.set(LIVE, Array<string>(1000).fill("EBUSY").slice(0, 41));
        const error = await failureOf(swap());
        expect(error.code).toBe(UpdateErrorCode.RenameFailed);
        expect(files.get(LIVE)).toBe("0.6.4");
    });

    test("the restore rename fails and the backup copy restores the live file", async () => {
        renameFailures.set(LIVE, ["ENOSPC", "EXDEV"]);
        await failureOf(swap());
        expect(files.get(LIVE)).toBe("0.6.4");
        expect(oldFiles()).toHaveLength(1);
    });

    test("when the restore cannot work, the error names the .old file and the install command", async () => {
        renameFailures.set(LIVE, ["ENOSPC", "EXDEV"]);
        const realCopy = operations.copyFile;
        let copies = 0;
        operations.copyFile = (from, to) => {
            if (++copies > 1) throw errnoError("EPERM");
            realCopy(from, to);
        };
        try {
            const error = await failureOf(swap());
            expect(error.code).toBe(UpdateErrorCode.RestoreFailed);
            expect(error.message).toContain(oldFiles()[0]);
            expect(error.message).toContain("install.ps1");
        } finally {
            operations.copyFile = realCopy;
        }
    });

    test("the live path fails after the swap and the old binary comes back", async () => {
        const error = await failureOf(swap(async () => { throw new Error("removed by a scanner"); }));
        expect(error.code).toBe(UpdateErrorCode.PostSwapFailed);
        expect(error.countsAsBadRelease).toBe(true);
        expect(files.get(LIVE)).toBe("0.6.4");
    });

    test("a 2nd update while the first .old still exists uses a new name", async () => {
        await swap();
        files.set(DOWNLOAD, "0.6.6");
        await swapWindowsBinary({ ...request, newVersion: "0.6.6", runningVersion: "0.6.5" }, operations, runBinary);
        expect(oldFiles()).toHaveLength(2);
        expect(files.get(LIVE)).toBe("0.6.6");
    });
});

describe("rollbackWindowsBinary", () => {
    const rollback = (execPath = LIVE, runningVersion = "0.6.5", latestVersion?: string) =>
        rollbackWindowsBinary({ execPath, runningVersion, latestVersion }, operations, runBinary);

    beforeEach(() => {
        files = new Map([[LIVE, "0.6.5"], [BACKUP, "0.6.4"]]);
    });

    test("restores the previous file and uses up the backup", async () => {
        await expect(rollback()).resolves.toEqual({ from: "0.6.5", to: "0.6.4" });
        expect(files.get(LIVE)).toBe("0.6.4");
        expect(files.has(BACKUP)).toBe(false);
    });

    test("a 2nd rollback reports nothing to do", async () => {
        await rollback();
        expect((await failureOf(rollback())).code).toBe(UpdateErrorCode.NothingToRollBack);
    });

    test("a damaged backup stops before it touches the live binary", async () => {
        files.set(BACKUP, "corrupt");
        expect((await failureOf(rollback())).code).toBe(UpdateErrorCode.NothingToRollBack);
        expect(files.get(LIVE)).toBe("0.6.5");
    });

    test("works from the backup, and reads the version it leaves from the live file", async () => {
        await expect(rollback(BACKUP, "0.6.4")).resolves.toEqual({ from: "0.6.5", to: "0.6.4" });
        expect(files.get(LIVE)).toBe("0.6.4");
    });

    test("works from the backup when the live file is missing", async () => {
        files.delete(LIVE);
        await expect(rollback(BACKUP, "0.6.4", "0.6.5")).resolves.toEqual({ from: "0.6.5", to: "0.6.4" });
        expect(files.get(LIVE)).toBe("0.6.4");
    });
});

describe("removeStaleUpdateFiles", () => {
    function run(names: string[], alivePids: number[], execPath = LIVE): string[] {
        const removed: string[] = [];
        const staleOperations: StaleFileOperations = {
            list: () => names,
            remove: (filePath) => { removed.push(filePath); },
            isAlive: (pid) => alivePids.includes(pid),
        };
        removeStaleUpdateFiles(execPath, staleOperations);
        return removed;
    }

    test("deletes .old files", () => {
        expect(run(["pinggy.exe", "pinggy.exe.123.old"], [])).toEqual([`${FOLDER}\\pinggy.exe.123.old`]);
    });

    test("keeps a download whose pid is alive and deletes one whose pid is dead", () => {
        const removed = run(["pinggy.exe.11.new.exe", "pinggy.exe.22.new.exe"], [11]);
        expect(removed).toEqual([`${FOLDER}\\pinggy.exe.22.new.exe`]);
    });

    test("leaves the install script's own temp file and other programs alone", () => {
        expect(run(["pinggy.exe.new.exe", "pinggy.prev.exe", "other.exe.1.old", "notes.txt"], [])).toEqual([]);
    });

    test("a name with brackets and a space matches literally", () => {
        const live = `${FOLDER}\\pinggy (1).exe`;
        expect(run(["pinggy (1).exe.5.old", "pinggy.exe.5.old"], [], live)).toEqual([`${FOLDER}\\pinggy (1).exe.5.old`]);
    });

    test("a file that cannot be deleted does not stop the others", () => {
        const removed: string[] = [];
        removeStaleUpdateFiles(LIVE, {
            list: () => ["pinggy.exe.1.old", "pinggy.exe.2.old"],
            remove: (filePath) => {
                if (filePath.includes(".1.")) throw errnoError("EBUSY");
                removed.push(filePath);
            },
            isAlive: () => false,
        });
        expect(removed).toEqual([`${FOLDER}\\pinggy.exe.2.old`]);
    });

    test("a folder that cannot be read does nothing", () => {
        expect(() => removeStaleUpdateFiles(LIVE, {
            list: () => { throw errnoError("ENOENT"); },
            remove: () => undefined,
            isAlive: () => false,
        })).not.toThrow();
    });
});
