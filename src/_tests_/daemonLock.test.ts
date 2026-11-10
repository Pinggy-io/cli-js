import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireDaemonLock, releaseDaemonLock } from "../daemon/lifecycle/daemonLock.js";
import { getDaemonLockPath } from "../utils/configDir.js";

let configHome: string;
let savedXdg: string | undefined;
let savedAppData: string | undefined;

function writeLock(pid: number, startedAt: string): void {
    fs.mkdirSync(path.dirname(getDaemonLockPath()), { recursive: true });
    fs.writeFileSync(getDaemonLockPath(), JSON.stringify({ pid, started_at: startedAt }));
}

function lockPid(): number {
    return JSON.parse(fs.readFileSync(getDaemonLockPath(), "utf-8")).pid;
}

function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""]);
    return child.pid!;
}

const now = () => new Date().toISOString();

beforeEach(() => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-lock-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.APPDATA = configHome;
});

afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppData;
    fs.rmSync(configHome, { recursive: true, force: true });
});

describe("acquireDaemonLock", () => {
    test("takes the lock when none exists", () => {
        expect(acquireDaemonLock()).toBe(true);
        expect(lockPid()).toBe(process.pid);
    });

    test("takes it again when this process already holds it", () => {
        expect(acquireDaemonLock()).toBe(true);
        expect(acquireDaemonLock()).toBe(true);
    });

    test("refuses when another live process holds it", () => {
        writeLock(process.ppid, now());
        expect(acquireDaemonLock()).toBe(false);
        expect(lockPid()).toBe(process.ppid);
    });

    // On Windows the service task gets EPERM for a daemon started from an Administrator shell.
    // PID 1 runs as root, so this process gets EPERM for it too.
    (process.platform === "win32" ? test.skip : test)("refuses when the holder runs but this process may not signal it", () => {
        writeLock(1, now());
        expect(acquireDaemonLock()).toBe(false);
    });

    test("replaces a lock whose process is gone", () => {
        writeLock(deadPid(), now());
        expect(acquireDaemonLock()).toBe(true);
        expect(lockPid()).toBe(process.pid);
    });

    test("replaces a lock written before the last boot, even if its PID is in use now", () => {
        writeLock(process.ppid, new Date(0).toISOString());
        expect(acquireDaemonLock()).toBe(true);
        expect(lockPid()).toBe(process.pid);
    });

    test("treats a new unreadable lock as held, since its holder may still be writing it", () => {
        fs.mkdirSync(path.dirname(getDaemonLockPath()), { recursive: true });
        fs.writeFileSync(getDaemonLockPath(), "");
        expect(acquireDaemonLock()).toBe(false);
    });

    test("replaces an unreadable lock older than 10s", () => {
        fs.mkdirSync(path.dirname(getDaemonLockPath()), { recursive: true });
        fs.writeFileSync(getDaemonLockPath(), "");
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(getDaemonLockPath(), old, old);
        expect(acquireDaemonLock()).toBe(true);
        expect(lockPid()).toBe(process.pid);
    });
});

describe("releaseDaemonLock", () => {
    test("deletes the lock this process holds", () => {
        acquireDaemonLock();
        releaseDaemonLock();
        expect(fs.existsSync(getDaemonLockPath())).toBe(false);
    });

    test("leaves another daemon's lock", () => {
        writeLock(process.ppid, now());
        releaseDaemonLock();
        expect(lockPid()).toBe(process.ppid);
    });
});
