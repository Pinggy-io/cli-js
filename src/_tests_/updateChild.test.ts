import { describe, expect, test } from "@jest/globals";
import { UpdateTarget } from "../update/applyUpdate.js";
import { UpdateError, UpdateErrorCode } from "../update/binaryUpdater.js";
import { InstallKind } from "../update/installKind.js";
import { runUpdateChild, UpdateChildEnvironment } from "../update/updateChild.js";
import { UpdateState } from "../update/updateState.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";

const NOW = 2_000_000_000;
const DAY = 24 * 60 * 60;
const DOWNLOAD_PATH = "/download";

interface Harness {
    environment: UpdateChildEnvironment;
    state: UpdateState;
    downloads: string[];
    installs: string[];
    removed: string[];
    logged: string[];
    limitCallback: (() => void) | null;
    exited: boolean;
    lockReleased: boolean;
    timeLimitCancelled: boolean;
}

function harness(state: UpdateState = {}, overrides: Partial<UpdateChildEnvironment> = {}, targetOverrides: Partial<UpdateTarget> = {}): Harness {
    const h: Harness = {
        state,
        downloads: [],
        installs: [],
        removed: [],
        logged: [],
        limitCallback: null,
        exited: false,
        lockReleased: false,
        timeLimitCancelled: false,
        environment: undefined as unknown as UpdateChildEnvironment,
    };
    const target: UpdateTarget = {
        downloadPath: DOWNLOAD_PATH,
        rollbackBinaryPath: () => "/rollback",
        installedVersion: (running) => running,
        prepareDownload: () => undefined,
        install: ({ newVersion }) => { h.installs.push(newVersion); },
        rollback: () => ({ from: "x", to: "y" }),
        ...targetOverrides,
    };
    h.environment = {
        kind: InstallKind.UnixLayout,
        target,
        runningVersion: "0.6.4",
        nowEpochSeconds: () => NOW,
        acquireLock: () => Promise.resolve(true),
        releaseLock: () => { h.lockReleased = true; },
        isLockOurs: () => true,
        readState: () => ({ ...h.state }),
        writeState: (patch) => { h.state = { ...h.state, ...patch }; return true; },
        recordLatestVersion: (version) => { h.state = { ...h.state, latestVersion: version }; return true; },
        resolveTag: () => Promise.resolve("v0.6.5"),
        resolveNpmVersion: () => Promise.resolve("0.6.5"),
        isReleaseComplete: () => Promise.resolve(true),
        download: (_target, tag) => { h.downloads.push(tag); return Promise.resolve(); },
        readIpcVersion: () => Promise.resolve(1),
        liveDaemon: () => null,
        removeStaleFiles: () => undefined,
        removeFile: (filePath) => { h.removed.push(filePath); },
        startLog: () => undefined,
        log: (line) => { h.logged.push(line); },
        startTimeLimit: (onLimit) => {
            h.limitCallback = onLimit;
            return () => { h.timeLimitCancelled = true; };
        },
        exitProcess: () => { h.exited = true; },
        ...overrides,
    };
    return h;
}

const daemon = (ipcVersion: number): DaemonInfo => ({ pid: 1, port: 1, startedAt: "", ipcVersion });
const run = (h: Harness): Promise<void> => runUpdateChild(h.environment);

describe("runUpdateChild", () => {
    test("a newer release is downloaded, installed and recorded", async () => {
        const h = harness();
        await run(h);
        expect(h.downloads).toEqual(["v0.6.5"]);
        expect(h.installs).toEqual(["0.6.5"]);
        expect(h.state).toMatchObject({
            latestVersion: "0.6.5",
            updatedFromVersion: "0.6.4",
            updatedToVersion: "0.6.5",
            lastCheckEpochSeconds: NOW,
        });
        expect(h.lockReleased).toBe(true);
        expect(h.timeLimitCancelled).toBe(true);
        expect(h.removed).toContain(DOWNLOAD_PATH);
    });

    test("a held lock exits and writes nothing", async () => {
        const h = harness({}, { acquireLock: () => Promise.resolve(false) });
        await run(h);
        expect(h.state).toEqual({});
        expect(h.logged).toEqual([]);
        expect(h.downloads).toEqual([]);
    });

    test("a last check under 24 hours old exits after the lock and makes no request", async () => {
        let asked = false;
        const h = harness({ lastCheckEpochSeconds: NOW - DAY + 60 }, { resolveTag: () => { asked = true; return Promise.resolve("v0.6.5"); } });
        await run(h);
        expect(asked).toBe(false);
        expect(h.downloads).toEqual([]);
    });

    test("a failed check writes nothing", async () => {
        const h = harness({}, { resolveTag: () => Promise.reject(new Error("offline")) });
        await run(h);
        expect(h.state).toEqual({});
        expect(h.lockReleased).toBe(true);
    });

    test("a tag not newer saves the check time and downloads nothing", async () => {
        const h = harness({}, { resolveTag: () => Promise.resolve("v0.6.4") });
        await run(h);
        expect(h.state.lastCheckEpochSeconds).toBe(NOW);
        expect(h.downloads).toEqual([]);
    });

    test("on the layout, a tag not newer than the link target downloads nothing when run from an older version", async () => {
        const h = harness({}, {}, { installedVersion: () => "0.6.5" });
        await run(h);
        expect(h.downloads).toEqual([]);
        expect(h.state.lastCheckEpochSeconds).toBe(NOW);
    });

    test("a newer tag with no SHA256SUMS exits and writes nothing", async () => {
        const h = harness({}, { isReleaseComplete: () => Promise.resolve(false) });
        await run(h);
        expect(h.state).toEqual({});
        expect(h.downloads).toEqual([]);
    });

    test.each([InstallKind.WindowsReadOnly, InstallKind.UnixLoose, InstallKind.Npm])("%s saves the version and downloads nothing", async (kind) => {
        const h = harness({}, { kind, target: null });
        await run(h);
        expect(h.state).toMatchObject({ latestVersion: "0.6.5", lastCheckEpochSeconds: NOW });
        expect(h.downloads).toEqual([]);
    });

    test("npm reads the registry and asks GitHub nothing", async () => {
        let askedGitHub = false;
        const h = harness({}, {
            kind: InstallKind.Npm,
            target: null,
            resolveTag: () => { askedGitHub = true; return Promise.resolve("v9.9.9"); },
            isReleaseComplete: () => { askedGitHub = true; return Promise.resolve(false); },
        });
        await run(h);
        expect(askedGitHub).toBe(false);
        expect(h.state.latestVersion).toBe("0.6.5");
    });

    test("a tag equal to rolledBackFromVersion downloads nothing", async () => {
        const h = harness({ rolledBackFromVersion: "0.6.5" });
        await run(h);
        expect(h.downloads).toEqual([]);
        expect(h.state.lastCheckEpochSeconds).toBe(NOW);
    });
});

describe("failures", () => {
    const badChecksum = new UpdateError(UpdateErrorCode.Checksum, "bad");

    test("a failed download writes the check time and counts", async () => {
        const h = harness({}, { download: () => Promise.reject(badChecksum) });
        await run(h);
        expect(h.state).toMatchObject({ lastCheckEpochSeconds: NOW, failedVersion: "0.6.5", failedAttempts: 1 });
        expect(h.installs).toEqual([]);
    });

    test("3 failures for 1 tag stop the downloads", async () => {
        const h = harness({ failedVersion: "0.6.5", failedAttempts: 3 });
        await run(h);
        expect(h.downloads).toEqual([]);
        expect(h.state.lastCheckEpochSeconds).toBe(NOW);
    });

    test("2 failures still try", async () => {
        const h = harness({ failedVersion: "0.6.5", failedAttempts: 2 });
        await run(h);
        expect(h.downloads).toEqual(["v0.6.5"]);
    });

    test("a newer tag starts from 0", async () => {
        const h = harness({ failedVersion: "0.6.5", failedAttempts: 3 }, {
            resolveTag: () => Promise.resolve("v0.6.6"),
            download: () => Promise.reject(badChecksum),
        });
        await run(h);
        expect(h.state).toMatchObject({ failedVersion: "0.6.6", failedAttempts: 1 });
    });

    test("a network failure does not count", async () => {
        const h = harness({}, { download: () => Promise.reject(new UpdateError(UpdateErrorCode.Network, "reset")) });
        await run(h);
        expect(h.state.failedAttempts).toBeUndefined();
        expect(h.state.lastCheckEpochSeconds).toBe(NOW);
    });

    test("a post-swap failure counts", async () => {
        const h = harness({}, {}, {
            install: () => { throw new UpdateError(UpdateErrorCode.PostSwapFailed, "gone"); },
        });
        await run(h);
        expect(h.state.failedAttempts).toBe(1);
        expect(h.state.updatedToVersion).toBeUndefined();
    });

    test("a success clears earlier failures and deferrals", async () => {
        const h = harness({ failedVersion: "0.6.5", failedAttempts: 1, deferredVersion: "0.6.4", deferredIpcVersion: 9 });
        await run(h);
        expect(h.state.failedVersion).toBeUndefined();
        expect(h.state.failedAttempts).toBeUndefined();
        expect(h.state.deferredVersion).toBeUndefined();
    });
});

describe("a live daemon on another IPC version", () => {
    test("deletes the file, writes the held fields, and does not swap", async () => {
        const h = harness({}, { liveDaemon: () => daemon(1), readIpcVersion: () => Promise.resolve(2) });
        await run(h);
        expect(h.installs).toEqual([]);
        expect(h.removed).toContain(DOWNLOAD_PATH);
        expect(h.state).toMatchObject({ deferredVersion: "0.6.5", deferredIpcVersion: 2, lastCheckEpochSeconds: NOW });
    });

    test("a later check skips the download while the mismatch stands", async () => {
        const h = harness({ deferredVersion: "0.6.5", deferredIpcVersion: 2 }, { liveDaemon: () => daemon(1) });
        await run(h);
        expect(h.downloads).toEqual([]);
    });

    test("it downloads once the daemon stops", async () => {
        const h = harness({ deferredVersion: "0.6.5", deferredIpcVersion: 2 }, { readIpcVersion: () => Promise.resolve(2) });
        await run(h);
        expect(h.installs).toEqual(["0.6.5"]);
    });

    test("a daemon on the same IPC version does not hold the swap", async () => {
        const h = harness({}, { liveDaemon: () => daemon(1), readIpcVersion: () => Promise.resolve(1) });
        await run(h);
        expect(h.installs).toEqual(["0.6.5"]);
    });
});

describe("right before the swap", () => {
    test("a rollback during the download stops the swap and tries again soon", async () => {
        const h = harness();
        h.environment.download = () => {
            h.state = { ...h.state, rolledBackFromVersion: "0.6.5" };
            return Promise.resolve();
        };
        await run(h);
        expect(h.installs).toEqual([]);
        expect(h.removed).toContain(DOWNLOAD_PATH);
        expect(h.state.lastCheckEpochSeconds).toBeUndefined();
    });

    test("a lost lock stops the swap", async () => {
        const h = harness({}, { isLockOurs: () => false });
        await run(h);
        expect(h.installs).toEqual([]);
        expect(h.state.lastCheckEpochSeconds).toBeUndefined();
    });
});

describe("the time limit", () => {
    test("deletes this process's temp file, then exits", async () => {
        const h = harness();
        await run(h);
        h.limitCallback?.();
        expect(h.removed.at(-1)).toBe(DOWNLOAD_PATH);
        expect(h.exited).toBe(true);
    });
});

describe("cleanup", () => {
    test("stale files go before the lock is taken", async () => {
        const order: string[] = [];
        const h = harness({}, {
            removeStaleFiles: () => { order.push("stale"); },
            acquireLock: () => { order.push("lock"); return Promise.resolve(true); },
        });
        await run(h);
        expect(order).toEqual(["stale", "lock"]);
    });
});
