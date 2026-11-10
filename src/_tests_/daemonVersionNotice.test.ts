import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonHost, IPC_VERSION } from "../daemon/ipc/ipcRoutes.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";
import { ensureDaemonRunning, printDaemonVersionNoticeOnce } from "../daemon/lifecycle/daemonManager.js";
import { serviceRestartInstruction, ServiceQuery } from "../daemon/lifecycle/serviceInstaller.js";
import { TunnelClient } from "../daemon/tunnelClient.js";
import { readUpdateState } from "../update/updateState.js";
import { getDaemonInfoPath } from "../utils/configDir.js";

const RUNNING = "0.6.5";
const OLD_VERSION = "0.0.1";

let temporaryDirectory: string;
let printed: string[];
const savedEnvironment: Record<string, string | undefined> = {};
const originalIsTty = process.stdout.isTTY;

function setTerminal(isTerminal: boolean): void {
    Object.defineProperty(process.stdout, "isTTY", { value: isTerminal, configurable: true });
}

function daemon(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
    return { pid: process.pid, port: 1, startedAt: new Date().toISOString(), ipcVersion: IPC_VERSION, cliVersion: OLD_VERSION, host: DaemonHost.CLI, ...overrides };
}

const noService = (): string | null => null;
const notice = (info: DaemonInfo, restartInstruction: (daemonInfo: DaemonInfo) => string | null = noService): void =>
    printDaemonVersionNoticeOnce(info, restartInstruction, RUNNING);

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-daemon-notice-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
    printed = [];
    jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { printed.push(parts.join(" ")); });
    setTerminal(true);
});

afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("printDaemonVersionNoticeOnce", () => {
    test("the same version prints nothing", () => {
        notice(daemon({ cliVersion: RUNNING }));
        expect(printed).toEqual([]);
    });

    test("a different version prints once, and a 2nd call prints nothing", () => {
        notice(daemon());
        notice(daemon());
        expect(printed).toEqual([
            `The daemon runs ${OLD_VERSION}. Run "pinggy daemon stop" to start ${RUNNING}. This stops all running tunnels.`,
        ]);
        expect(readUpdateState().lastDaemonNoticeVersion).toBe(RUNNING);
    });

    test("a daemon.json without cliVersion gets the older-version line", () => {
        notice(daemon({ cliVersion: undefined }));
        expect(printed[0]).toContain("The daemon runs an older version.");
        expect(printed[0]).not.toContain("undefined");
    });

    test("an app-hosted daemon prints nothing", () => {
        notice(daemon({ host: DaemonHost.APP }));
        expect(printed).toEqual([]);
    });

    test("a non-terminal stdout prints nothing and writes nothing", () => {
        setTerminal(false);
        notice(daemon());
        expect(printed).toEqual([]);
        expect(readUpdateState()).toEqual({});
    });

    test("a daemon a service runs gets the service's restart command", () => {
        notice(daemon(), () => '"systemctl --user restart pinggy"');
        expect(printed[0]).toContain('Run "systemctl --user restart pinggy" to start');
        expect(printed[0]).not.toContain("pinggy daemon stop");
    });
});

describe("where the line prints", () => {
    let notices: DaemonInfo[];
    const client = (): TunnelClient => new TunnelClient({ printVersionNotice: (info) => { notices.push(info); } });

    function writeDaemonJson(overrides: Partial<DaemonInfo> = {}): void {
        const infoPath = getDaemonInfoPath();
        fs.mkdirSync(path.dirname(infoPath), { recursive: true });
        fs.writeFileSync(infoPath, JSON.stringify(daemon(overrides)));
    }

    beforeEach(() => {
        notices = [];
    });

    test("ensureDaemonRunning never prints", async () => {
        writeDaemonJson();
        await ensureDaemonRunning();
        expect(printed).toEqual([]);
    });

    test("TunnelClient.ensureDaemon prints", async () => {
        writeDaemonJson();
        await client().ensureDaemon();
        expect(notices).toHaveLength(1);
    });

    test("with holdVersionNotice, nothing prints until printHeldVersionNotice", async () => {
        writeDaemonJson();
        const held = client();
        await held.ensureDaemon({ holdVersionNotice: true });
        expect(notices).toHaveLength(0);
        held.printHeldVersionNotice();
        expect(notices).toHaveLength(1);
    });

    test("connectIfRunning prints", () => {
        writeDaemonJson();
        expect(client().connectIfRunning()).toBe(true);
        expect(notices).toHaveLength(1);
    });

    test("a different ipcVersion keeps the old error and prints no notice", async () => {
        writeDaemonJson({ ipcVersion: IPC_VERSION + 1 });
        await expect(client().ensureDaemon()).rejects.toThrow(/different Pinggy CLI version/);
        expect(notices).toHaveLength(0);
    });
});

describe("serviceRestartInstruction", () => {
    const info = { pid: 4242 };

    test("Linux names systemctl when the unit's main pid is this daemon", () => {
        const query: ServiceQuery = () => "4242\n";
        expect(serviceRestartInstruction(info, "linux", query)).toBe('"systemctl --user restart pinggy"');
    });

    test("Linux returns null for another pid", () => {
        expect(serviceRestartInstruction(info, "linux", () => "0\n")).toBeNull();
    });

    test("macOS names launchctl when the agent's pid is this daemon", () => {
        const query: ServiceQuery = () => "gui/501/io.pinggy.agent = {\n\tactive count = 1\n\tpid = 4242\n}";
        expect(serviceRestartInstruction(info, "darwin", query, 501)).toBe('"launchctl kickstart -k gui/501/io.pinggy.agent"');
    });

    test("macOS returns null when the agent has no pid", () => {
        expect(serviceRestartInstruction(info, "darwin", () => "gui/501/io.pinggy.agent = {\n}", 501)).toBeNull();
    });

    test("a query that fails returns null", () => {
        expect(serviceRestartInstruction(info, "linux", () => { throw new Error("no systemd"); })).toBeNull();
    });

    test("Windows returns null, because the task never owns the daemon", () => {
        expect(serviceRestartInstruction(info, "win32", () => "Running")).toBeNull();
    });
});
