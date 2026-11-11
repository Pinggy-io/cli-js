import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDaemonSpawnArgs, startDaemon } from "../daemon/lifecycle/daemonManager.js";
import { installerBinaryPath, serviceProgramPath, ServiceInstallContext } from "../daemon/lifecycle/serviceInstaller.js";

const LINK = "/home/me/.pinggy/bin/pinggy";
const realExecPath = process.execPath;
let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-daemon-spawn-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
});

afterEach(() => {
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true, writable: true });
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("getDaemonSpawnArgs", () => {
    test("a packaged binary whose file is gone starts the daemon from the link", () => {
        const { command, args } = getDaemonSpawnArgs(true, false, LINK);
        expect(command).toBe(LINK);
        expect(args).toEqual(["--_daemon-child"]);
    });

    test("a packaged binary whose file exists starts itself", () => {
        const { command, args } = getDaemonSpawnArgs(true, true, LINK);
        expect(command).toBe(process.execPath);
        expect(args).toEqual([process.argv[1], "--_daemon-child"]);
    });

    test("an unpackaged run starts itself", () => {
        expect(getDaemonSpawnArgs(false, false, LINK).command).toBe(process.execPath);
    });
});

describe("startDaemon", () => {
    test("reports a failed spawn and does not crash the process", async () => {
        Object.defineProperty(process, "execPath", {
            value: path.join(temporaryDirectory, "gone", "pinggy"),
            configurable: true,
            writable: true,
        });
        await expect(startDaemon()).rejects.toThrow(/ENOENT/);
    });
});

describe("serviceProgramPath", () => {
    const home = fs.realpathSync(os.tmpdir());
    const context = (overrides: Partial<ServiceInstallContext>): ServiceInstallContext => ({
        platform: "linux", isPkg: true, execPath: "", home, env: {}, ...overrides,
    });
    const link = installerBinaryPath("linux", home, {});

    test("a binary in the layout names the link", () => {
        expect(serviceProgramPath(context({ execPath: `${home}/.pinggy/versions/0.6.5/pinggy` }))).toBe(link);
    });

    test("a plain file at the link path names the link", () => {
        expect(serviceProgramPath(context({ execPath: link }))).toBe(link);
    });

    test("a loose binary names itself", () => {
        expect(serviceProgramPath(context({ execPath: "/opt/pinggy" }))).toBe("/opt/pinggy");
    });

    test("Windows names the file, which keeps its path across updates", () => {
        const execPath = "C:\\Users\\me\\AppData\\Local\\Pinggy\\bin\\pinggy.exe";
        expect(serviceProgramPath(context({ platform: "win32", execPath }))).toBe(execPath);
    });
});
