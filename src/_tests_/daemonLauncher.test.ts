import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IPC_VERSION } from "../daemon/ipc/ipcRoutes.js";
import { ensureDaemonRunning, removeDeadDaemonFiles, setDaemonLauncher } from "../daemon/lifecycle/daemonManager.js";
import { getDaemonInfoPath, getDaemonLockPath } from "../utils/configDir.js";

/**
 * A host can start the daemon its own way: the Pinggy app starts it in a child process, so a crash in the
 * native library ends that child and not the app.
 */

let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

/** Our own PID, so the liveness check passes. */
function writeDaemonJson(port: number, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.dirname(getDaemonInfoPath()), { recursive: true });
    fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({
        pid: process.pid, port, startedAt: new Date().toISOString(), ipcVersion: IPC_VERSION, ...extra,
    }));
}

function deadPid(): number {
    return spawnSync(process.execPath, ["-e", ""]).pid!;
}

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-launcher-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
});

afterEach(() => {
    setDaemonLauncher(null);
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("setDaemonLauncher", () => {
    test("with no daemon running, the launcher starts one and its daemon.json is returned", async () => {
        let launches = 0;
        setDaemonLauncher(async () => {
            launches += 1;
            writeDaemonJson(4242);
        });

        const info = await ensureDaemonRunning();

        expect(launches).toBe(1);
        expect(info.port).toBe(4242);
    });

    test("a daemon that already runs is used, and the launcher is not called", async () => {
        writeDaemonJson(1111);
        let launches = 0;
        setDaemonLauncher(async () => { launches += 1; });

        const info = await ensureDaemonRunning();

        expect(launches).toBe(0);
        expect(info.port).toBe(1111);
    });

    test("a launcher that fails passes its error to the caller", async () => {
        setDaemonLauncher(async () => { throw new Error("child exited with code 70"); });

        await expect(ensureDaemonRunning()).rejects.toThrow("child exited with code 70");
    });

    test("a launched daemon on another IPC version is refused", async () => {
        setDaemonLauncher(async () => writeDaemonJson(4242, { ipcVersion: IPC_VERSION + 1 }));

        await expect(ensureDaemonRunning()).rejects.toThrow(`v${IPC_VERSION + 1}`);
    });
});

describe("removeDeadDaemonFiles", () => {
    function writeLock(pid: number): void {
        fs.mkdirSync(path.dirname(getDaemonLockPath()), { recursive: true });
        fs.writeFileSync(getDaemonLockPath(), JSON.stringify({ pid, started_at: new Date().toISOString() }));
    }

    test("deletes daemon.json and daemon.lock that name the dead daemon", () => {
        const pid = deadPid();
        writeDaemonJson(1, { pid });
        writeLock(pid);

        removeDeadDaemonFiles(pid);

        expect(fs.existsSync(getDaemonInfoPath())).toBe(false);
        expect(fs.existsSync(getDaemonLockPath())).toBe(false);
    });

    test("leaves the files of another daemon", () => {
        writeDaemonJson(1);
        writeLock(process.pid);

        removeDeadDaemonFiles(deadPid());

        expect(fs.existsSync(getDaemonInfoPath())).toBe(true);
        expect(fs.existsSync(getDaemonLockPath())).toBe(true);
    });

    test("does nothing when neither file exists", () => {
        expect(() => removeDeadDaemonFiles(deadPid())).not.toThrow();
    });
});
