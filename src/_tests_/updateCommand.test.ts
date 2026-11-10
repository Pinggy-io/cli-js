import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runUpdateCommand, UpdateCommandContext } from "../cli/subcommand/handlers/updateCommand.js";
import { UpdateTarget } from "../update/applyUpdate.js";
import { InstallProbe } from "../update/installKind.js";
import { defaultDownloadDependencies } from "../update/binaryUpdater.js";
import { readUpdateState, writeUpdateState } from "../update/updateState.js";
import { getDaemonInfoPath } from "../utils/configDir.js";
import { FakeReleaseServer, setAsset, startFakeReleaseServer } from "./helpers/fakeReleaseServer.js";

const OVERRIDE = "PINGGY_UPDATE_RELEASES_URL";
const HOME = "/home/me";

let server: FakeReleaseServer;
let temporaryDirectory: string;
let printed: string[];
const savedEnvironment: Record<string, string | undefined> = {};

function looseContext(overrides: Partial<InstallProbe> = {}, runningVersion = "0.6.4"): UpdateCommandContext {
    return {
        runningVersion,
        probe: {
            isPackaged: true,
            isElectron: false,
            platform: "linux",
            execPath: `${HOME}/Downloads/pinggy`,
            scriptRealPath: "/snapshot/app/dist/index.cjs",
            homeRealPath: HOME,
            directoryIsWritable: () => true,
            ...overrides,
        },
    };
}

const npmContext = (): UpdateCommandContext =>
    looseContext({ isPackaged: false, scriptRealPath: "/usr/lib/node_modules/pinggy/dist/index.cjs" });

const output = (): string => printed.join("\n");

beforeEach(async () => {
    server = await startFakeReleaseServer();
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-update-command-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
    process.env[OVERRIDE] = server.releasesUrl;
    printed = [];
    const record = (...parts: unknown[]) => { printed.push(parts.join(" ")); };
    jest.spyOn(console, "log").mockImplementation(record);
    jest.spyOn(console, "error").mockImplementation(record);
});

afterEach(async () => {
    jest.restoreAllMocks();
    delete process.env[OVERRIDE];
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    await server.close();
});

describe("pinggy update --check", () => {
    test("a newer release prints the version and the install command", async () => {
        server.latestTag = "v0.6.5";
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.from("x") });
        await expect(runUpdateCommand(["--check"], looseContext())).resolves.toBe(0);
        expect(output()).toContain("pinggy 0.6.5 is available. You run 0.6.4.");
        expect(output()).toContain("Run: curl -fsSL https://pinggy.io/install.sh | sh");
    });

    test("Windows gets the PowerShell command", async () => {
        server.latestTag = "v0.6.5";
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.from("x") });
        const windows = looseContext({ platform: "win32", execPath: "C:\\tools\\pinggy.exe", directoryIsWritable: () => false });
        await expect(runUpdateCommand(["--check"], windows)).resolves.toBe(0);
        expect(output()).toContain("Run: irm https://pinggy.io/install.ps1 | iex");
    });

    test("npm gets the npm command", async () => {
        server.latestTag = "v0.6.5";
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.from("x") });
        await expect(runUpdateCommand(["--check"], npmContext())).resolves.toBe(0);
        expect(output()).toContain("Run: npm i -g pinggy");
    });

    test("the same version is up to date and makes no SHA256SUMS request", async () => {
        server.latestTag = "v0.6.4";
        await expect(runUpdateCommand(["--check"], looseContext())).resolves.toBe(0);
        expect(output()).toContain("pinggy 0.6.4 is up to date.");
        expect(server.requests).toEqual(["HEAD /releases/latest"]);
    });

    test("a running version above the latest is up to date", async () => {
        server.latestTag = "v0.6.3";
        await expect(runUpdateCommand(["--check"], looseContext())).resolves.toBe(0);
        expect(output()).toContain("pinggy 0.6.4 is up to date.");
    });

    test("a newer tag with no SHA256SUMS reports not ready and writes nothing", async () => {
        server.latestTag = "v0.6.5";
        await expect(runUpdateCommand(["--check"], looseContext())).resolves.toBe(1);
        expect(output()).toContain("Release v0.6.5 is not ready. Try again later.");
        expect(readUpdateState()).toEqual({});
    });

    test("a network failure exits 1", async () => {
        await server.close();
        await expect(runUpdateCommand(["--check"], looseContext())).resolves.toBe(1);
        expect(output()).toContain("Could not reach GitHub to check for updates.");
    });

    test("a dev checkout makes no network call", async () => {
        const dev = looseContext({ isPackaged: false, scriptRealPath: "/work/cli-js/dist/index.cjs" });
        await expect(runUpdateCommand(["--check"], dev)).resolves.toBe(0);
        expect(output()).toContain("This is not a packaged build.");
        expect(server.requests).toEqual([]);
    });

    test("a running version that does not parse exits 1", async () => {
        await expect(runUpdateCommand(["--check"], looseContext({}, ""))).resolves.toBe(1);
        expect(output()).toContain("Could not read the running version.");
        expect(server.requests).toEqual([]);
    });

    test("it writes the 2 cache fields and leaves lastCheckEpochSeconds unwritten", async () => {
        server.latestTag = "v0.6.5";
        setAsset(server, "v0.6.5", "SHA256SUMS", { body: Buffer.from("x") });
        await runUpdateCommand(["--check"], looseContext());
        const state = readUpdateState();
        expect(state.latestVersion).toBe("0.6.5");
        expect(state.latestSeenEpochSeconds).toEqual(expect.any(Number));
        expect(state.lastCheckEpochSeconds).toBeUndefined();
    });
});

describe("pinggy update, the swap", () => {
    const TAG = "v0.6.5";
    const ASSET = "pinggy-linux-x64";
    let installs: string[];
    let downloadPath: string;

    function target(overrides: Partial<UpdateTarget> = {}): UpdateTarget {
        return {
            downloadPath,
            rollbackBinaryPath: () => "/nowhere",
            installedVersion: (running) => running,
            prepareDownload: () => undefined,
            install: ({ newVersion }) => { installs.push(newVersion); return Promise.resolve(); },
            rollback: () => Promise.resolve({ from: "0.6.5", to: "0.6.4" }),
            ...overrides,
        };
    }

    const context = (overrides: Partial<UpdateTarget> = {}): UpdateCommandContext => ({
        ...looseContext({ execPath: `${HOME}/.pinggy/versions/0.6.4/pinggy` }),
        architecture: "x64",
        target: target(overrides),
    });

    beforeEach(() => {
        installs = [];
        downloadPath = path.join(temporaryDirectory, "download");
    });

    test("up to date installs nothing", async () => {
        server.latestTag = "v0.6.4";
        await expect(runUpdateCommand([], context())).resolves.toBe(0);
        expect(output()).toContain("pinggy 0.6.4 is up to date.");
        expect(installs).toEqual([]);
    });

    test("a good update installs, reports, and clears the failure and rollback records", async () => {
        server.latestTag = TAG;
        const body = Buffer.from("binary");
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from(`${hash}  ${ASSET}\n`) });
        setAsset(server, TAG, ASSET, { body });
        writeUpdateState({ rolledBackFromVersion: "0.6.5", failedVersion: "0.6.5", failedAttempts: 3, deferredVersion: "0.6.5", deferredIpcVersion: 2 });

        const result = await runUpdateCommand([], {
            ...context(),
            download: {
                ...defaultDownloadDependencies,
                runBinary: async () => "Pinggy CLI version: 0.6.5\n",
                freeBytes: () => null,
            },
        });

        expect(result).toBe(0);
        expect(installs).toEqual(["0.6.5"]);
        expect(output()).toContain("Updated pinggy 0.6.4 to 0.6.5.");
        expect(fs.existsSync(downloadPath)).toBe(false);
        expect(readUpdateState()).toEqual({ latestVersion: "0.6.5", latestSeenEpochSeconds: expect.any(Number) });
    });

    test("a live daemon on another IPC version still updates and gets the restart line", async () => {
        server.latestTag = TAG;
        const body = Buffer.from("binary");
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from(`${hash}  ${ASSET}\n`) });
        setAsset(server, TAG, ASSET, { body });
        fs.mkdirSync(path.dirname(getDaemonInfoPath()), { recursive: true });
        fs.writeFileSync(getDaemonInfoPath(), JSON.stringify({ pid: process.pid, port: 1, startedAt: new Date().toISOString(), ipcVersion: 1 }));

        const result = await runUpdateCommand([], {
            ...context(),
            runBinary: async () => "2\n",
            download: {
                ...defaultDownloadDependencies,
                runBinary: async () => "Pinggy CLI version: 0.6.5\n",
                freeBytes: () => null,
            },
        });

        expect(result).toBe(0);
        expect(installs).toEqual(["0.6.5"]);
        expect(output()).toContain("pinggy 0.6.5 needs a daemon restart.");
    });

    test("a rollback clears the Updated line's record", async () => {
        writeUpdateState({ updatedFromVersion: "0.6.4", updatedToVersion: "0.6.5" });
        await expect(runUpdateCommand(["--rollback"], context())).resolves.toBe(0);
        expect(readUpdateState().updatedFromVersion).toBeUndefined();
        expect(readUpdateState().updatedToVersion).toBeUndefined();
    });

    test("a hint kind prints the command and writes nothing", async () => {
        server.latestTag = TAG;
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from("x") });
        await expect(runUpdateCommand([], { ...looseContext(), target: null })).resolves.toBe(0);
        expect(output()).toContain("Run: curl -fsSL https://pinggy.io/install.sh | sh");
        expect(server.requests.some((line) => line.endsWith(ASSET))).toBe(false);
    });

    test("a held lock refuses before any download", async () => {
        server.latestTag = TAG;
        setAsset(server, TAG, "SHA256SUMS", { body: Buffer.from("x") });
        fs.mkdirSync(path.join(temporaryDirectory, "pinggy"), { recursive: true });
        fs.writeFileSync(path.join(temporaryDirectory, "pinggy", "update.lock"), JSON.stringify({ pid: process.ppid }));
        await expect(runUpdateCommand([], context())).resolves.toBe(1);
        expect(output()).toContain("Another pinggy update is running.");
        expect(server.requests.some((line) => line.startsWith("GET"))).toBe(false);
    });

    test("a rollback with the lock held refuses and changes nothing", async () => {
        fs.mkdirSync(path.join(temporaryDirectory, "pinggy"), { recursive: true });
        fs.writeFileSync(path.join(temporaryDirectory, "pinggy", "update.lock"), JSON.stringify({ pid: process.ppid }));
        let rolledBack = false;
        const result = await runUpdateCommand(["--rollback"], context({
            rollback: () => { rolledBack = true; return Promise.resolve({ from: "0.6.5", to: "0.6.4" }); },
        }));
        expect(result).toBe(1);
        expect(rolledBack).toBe(false);
    });

    test("a rollback prints its result and frees the lock", async () => {
        await expect(runUpdateCommand(["--rollback"], context())).resolves.toBe(0);
        expect(output()).toContain("Rolled back pinggy 0.6.5 to 0.6.4.");
        expect(fs.existsSync(path.join(temporaryDirectory, "pinggy", "update.lock"))).toBe(false);
    });

    test("a loose binary cannot roll back", async () => {
        await expect(runUpdateCommand(["--rollback"], { ...looseContext(), target: null })).resolves.toBe(1);
        expect(output()).toContain("This copy of pinggy cannot update itself.");
    });

    test("--check with --rollback prints usage and exits 1", async () => {
        await expect(runUpdateCommand(["--check", "--rollback"], context())).resolves.toBe(1);
        expect(output()).toContain("Usage: pinggy update");
    });

    test.each([[[]], [["--rollback"]]])("under sudo, %j refuses and writes nothing", async (args: string[]) => {
        process.env.SUDO_UID = "501";
        try {
            await expect(runUpdateCommand(args, context())).resolves.toBe(1);
            expect(output()).toContain("does not run under sudo");
            expect(server.requests).toEqual([]);
        } finally {
            delete process.env.SUDO_UID;
        }
    });

    test("--check still works under sudo", async () => {
        process.env.SUDO_UID = "501";
        server.latestTag = "v0.6.4";
        try {
            await expect(runUpdateCommand(["--check"], context())).resolves.toBe(0);
        } finally {
            delete process.env.SUDO_UID;
        }
    });

    test("update from a .prev.exe refuses", async () => {
        const backup = looseContext({ platform: "win32", execPath: "C:\\tools\\pinggy.prev.exe" });
        await expect(runUpdateCommand([], backup)).resolves.toBe(1);
        expect(output()).toContain("This is the rollback copy of pinggy.exe");
        expect(server.requests).toEqual([]);
    });
});

describe("pinggy update arguments", () => {
    test("--help prints usage and exits 0", async () => {
        await expect(runUpdateCommand(["--help"], looseContext())).resolves.toBe(0);
        expect(output()).toContain("Usage: pinggy update");
    });

    test("an unknown argument prints usage and exits 1", async () => {
        await expect(runUpdateCommand(["extra"], looseContext())).resolves.toBe(1);
        expect(output()).toContain("Usage: pinggy update");
        expect(server.requests).toEqual([]);
    });
});
