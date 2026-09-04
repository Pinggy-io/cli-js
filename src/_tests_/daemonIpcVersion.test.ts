import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC_VERSION, DaemonHost } from "../daemon/ipc/ipcRoutes.js";
import {
    ensureDaemonRunning,
    isIpcCompatible,
    daemonIpcVersion,
    ipcMismatchMessage,
} from "../daemon/lifecycle/daemonManager.js";
import { getDaemonInfoPath } from "../utils/configDir.js";

// Point the config dir at a temp directory so the test never touches ~/.config/pinggy.
let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

function writeDaemonJson(extra: Record<string, unknown>): void {
    const p = getDaemonInfoPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Use our own PID so the liveness check passes.
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, port: 1, startedAt: new Date().toISOString(), ...extra }));
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-ipc-test-"));
    for (const k of ["XDG_CONFIG_HOME", "APPDATA"]) savedEnv[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.env.APPDATA = tmpDir;
});

afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("IPC version compatibility", () => {
    test("daemon.json without ipcVersion is treated as v0", () => {
        const info = { pid: 1, port: 1, startedAt: "" };
        expect(daemonIpcVersion(info)).toBe(0);
        expect(isIpcCompatible(info)).toBe(false);
    });

    test("matching ipcVersion is compatible", () => {
        expect(isIpcCompatible({ pid: 1, port: 1, startedAt: "", ipcVersion: IPC_VERSION })).toBe(true);
    });

    test("mismatch message tells CLI users to stop the daemon", () => {
        const msg = ipcMismatchMessage({ pid: 42, port: 1, startedAt: "", ipcVersion: IPC_VERSION + 1 });
        expect(msg).toContain("pinggy daemon stop");
        expect(msg).toContain("PID 42");
        expect(msg).toContain(`v${IPC_VERSION + 1}`);
        expect(msg).toContain(`v${IPC_VERSION}`);
    });

    test("mismatch message for an app-hosted daemon points at the app", () => {
        const msg = ipcMismatchMessage({ pid: 42, port: 1, startedAt: "", host: DaemonHost.APP });
        expect(msg).toContain("Pinggy app");
        expect(msg).not.toContain("pinggy daemon stop");
    });

    test("ensureDaemonRunning rejects a live daemon with a different ipcVersion", async () => {
        writeDaemonJson({ ipcVersion: IPC_VERSION + 1 });
        await expect(ensureDaemonRunning()).rejects.toThrow(/different Pinggy CLI version/);
        // The mismatch must not delete daemon.json: the daemon is alive and still owns it.
        expect(fs.existsSync(getDaemonInfoPath())).toBe(true);
    });

    test("ensureDaemonRunning rejects a live daemon from a build that wrote no ipcVersion", async () => {
        writeDaemonJson({});
        await expect(ensureDaemonRunning()).rejects.toThrow(/daemon IPC v0/);
    });

    test("ensureDaemonRunning returns a live daemon with a matching ipcVersion", async () => {
        writeDaemonJson({ ipcVersion: IPC_VERSION });
        const info = await ensureDaemonRunning();
        expect(info.pid).toBe(process.pid);
        expect(info.ipcVersion).toBe(IPC_VERSION);
    });
});
