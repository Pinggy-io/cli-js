import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireUpdateLock, isUpdateLockHeld, isUpdateLockOurs, releaseUpdateLock } from "../update/updateLock.js";
import { isProcessAlive } from "../daemon/lifecycle/daemonManager.js";
import { getUpdateLockPath } from "../utils/configDir.js";

let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

/** A pid that existed and has exited. */
function deadPid(): number {
    return spawnSync(process.execPath, ["-e", ""]).pid;
}

function writeLock(content: string, ageMillis = 0): void {
    const lockPath = getUpdateLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, content);
    if (ageMillis > 0) {
        const modified = new Date(Date.now() - ageMillis);
        fs.utimesSync(lockPath, modified, modified);
    }
}

const THIRTY_MINUTES = 30 * 60 * 1000;

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-update-lock-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
});

afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("update.lock", () => {
    test("the first caller gets it and holds this pid", async () => {
        await expect(acquireUpdateLock()).resolves.toBe(true);
        expect(isUpdateLockOurs()).toBe(true);
    });

    test("release removes it", async () => {
        await acquireUpdateLock();
        releaseUpdateLock();
        expect(fs.existsSync(getUpdateLockPath())).toBe(false);
    });

    test("release leaves a lock another process took over", async () => {
        writeLock(JSON.stringify({ pid: 1, startedAt: Date.now() }));
        releaseUpdateLock();
        expect(fs.existsSync(getUpdateLockPath())).toBe(true);
    });

    test("a lock held by a live process refuses", async () => {
        writeLock(JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
        await expect(acquireUpdateLock()).resolves.toBe(false);
        expect(isUpdateLockHeld()).toBe(true);
    });

    test("a lock whose pid is dead is replaced", async () => {
        writeLock(JSON.stringify({ pid: deadPid(), startedAt: Date.now() }));
        expect(isUpdateLockHeld()).toBe(false);
        await expect(acquireUpdateLock()).resolves.toBe(true);
        expect(isUpdateLockOurs()).toBe(true);
    });

    test("a lock over 30 minutes old is replaced, even with a live pid", async () => {
        writeLock(JSON.stringify({ pid: process.ppid, startedAt: 1 }), THIRTY_MINUTES + 1000);
        await expect(acquireUpdateLock()).resolves.toBe(true);
    });

    test("an empty lock counts as held", async () => {
        writeLock("");
        await expect(acquireUpdateLock()).resolves.toBe(false);
    });

    test("an unparseable lock counts as held", async () => {
        writeLock("{half a rec");
        await expect(acquireUpdateLock()).resolves.toBe(false);
    });

    test("an empty lock goes stale by its modified time", async () => {
        writeLock("", THIRTY_MINUTES + 1000);
        await expect(acquireUpdateLock()).resolves.toBe(true);
    });

    test("a process that loses the race for a stale lock does not continue", async () => {
        writeLock(JSON.stringify({ pid: deadPid(), startedAt: 1 }));
        const firstAttempt = acquireUpdateLock();
        // Another process renames its own record over the lock during the settle wait.
        fs.writeFileSync(getUpdateLockPath(), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
        await expect(firstAttempt).resolves.toBe(false);
    });

    test("a pid that returns EPERM counts as alive", () => {
        if (process.platform === "win32" || process.getuid?.() === 0) return;
        expect(isProcessAlive(1)).toBe(true);
    });
});
