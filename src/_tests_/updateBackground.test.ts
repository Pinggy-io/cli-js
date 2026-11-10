import { describe, expect, jest, test } from "@jest/globals";
import { spawn } from "node:child_process";
import {
    BackgroundUpdateCommand,
    BackgroundUpdateEnvironment,
    isAutoUpdateOff,
    spawnUpdater,
    startBackgroundUpdate,
} from "../update/backgroundUpdate.js";
import { InstallKind } from "../update/installKind.js";
import { backgroundInstallKind } from "../update/installKind.js";
import { UpdateState } from "../update/updateState.js";
import { DaemonHost } from "../daemon/ipc/ipcRoutes.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";

const NOW = 2_000_000_000;
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

interface Harness {
    environment: BackgroundUpdateEnvironment;
    state: UpdateState;
    printed: string[];
    spawnCount(): number;
    detectCount(): number;
}

function harness(state: UpdateState = {}, overrides: Partial<BackgroundUpdateEnvironment> = {}): Harness {
    const printed: string[] = [];
    let spawns = 0;
    let detects = 0;
    const harnessState: Harness = {
        state,
        printed,
        spawnCount: () => spawns,
        detectCount: () => detects,
        environment: {
            variables: {},
            stdoutIsTerminal: true,
            runningVersion: "0.6.4",
            platform: "linux",
            scriptRealPath: "/snapshot/app/dist/index.cjs",
            nowEpochSeconds: () => NOW,
            fileExists: () => false,
            detectKind: () => { detects++; return InstallKind.UnixLayout; },
            readState: () => ({ ...harnessState.state }),
            writeState: (patch) => { harnessState.state = { ...harnessState.state, ...patch }; return true; },
            isLockHeld: () => false,
            liveDaemon: () => null,
            print: (line) => { printed.push(line); },
            spawnUpdater: () => { spawns++; },
            ...overrides,
        },
    };
    return harnessState;
}

const psCommand: BackgroundUpdateCommand = { rawArgs: ["ps"], values: {}, hasAnyArgs: true };

function run(h: Harness, command: BackgroundUpdateCommand = psCommand): void {
    startBackgroundUpdate(command, () => h.environment);
}

describe("which commands start the updater", () => {
    test.each([
        ["tunnel mode", { rawArgs: ["-l", "3000"], values: {}, hasAnyArgs: true }],
        ["ps", psCommand],
        ["config", { rawArgs: ["config", "list"], values: {}, hasAnyArgs: true }],
        ["daemon", { rawArgs: ["daemon", "status"], values: {}, hasAnyArgs: true }],
        ["device", { rawArgs: ["device", "status"], values: {}, hasAnyArgs: true }],
    ] as [string, BackgroundUpdateCommand][])("%s does", (_name, command) => {
        const h = harness();
        run(h, command);
        expect(h.spawnCount()).toBe(1);
    });

    test.each([
        ["update", { rawArgs: ["update"], values: {}, hasAnyArgs: true }],
        ["update --check", { rawArgs: ["update", "--check"], values: {}, hasAnyArgs: true }],
        ["--version", { rawArgs: ["--version"], values: { version: true }, hasAnyArgs: true }],
        ["--help", { rawArgs: ["--help"], values: { help: true }, hasAnyArgs: true }],
        ["no arguments", { rawArgs: [], values: {}, hasAnyArgs: false }],
    ] as [string, BackgroundUpdateCommand][])("%s does not", (_name, command) => {
        const h = harness({ updatedFromVersion: "0.6.3", updatedToVersion: "0.6.4" });
        run(h, command);
        expect(h.spawnCount()).toBe(0);
        expect(h.printed).toEqual([]);
    });
});

describe("each gate on its own", () => {
    test("no terminal", () => {
        const h = harness({ updatedFromVersion: "0.6.3", updatedToVersion: "0.6.4" }, { stdoutIsTerminal: false });
        run(h);
        expect(h.spawnCount()).toBe(0);
        expect(h.printed).toEqual([]);
    });

    test.each([
        ["false", true], ["0", true], ["FALSE", true], ["true", false], ["1", false], ["banana", false], [undefined, false],
    ] as [string | undefined, boolean][])("PINGGY_AUTO_UPDATE=%s", (value, off) => {
        const h = harness({}, { variables: value === undefined ? {} : { PINGGY_AUTO_UPDATE: value } });
        expect(isAutoUpdateOff(h.environment.variables)).toBe(off);
        run(h);
        expect(h.spawnCount()).toBe(off ? 0 : 1);
    });

    test("under sudo", () => {
        const h = harness({}, { variables: { SUDO_UID: "501" } });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test.each(["/.dockerenv", "/run/.containerenv"])("in a container marked by %s", (marker) => {
        const h = harness({ latestVersion: "0.6.5" }, { fileExists: (filePath) => filePath === marker });
        run(h);
        expect(h.spawnCount()).toBe(0);
        expect(h.printed).toEqual([]);
    });

    test("a running version that does not parse", () => {
        const h = harness({}, { runningVersion: "" });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test("an npx run", () => {
        const h = harness({}, { scriptRealPath: "/home/me/.npm/_npx/abc/node_modules/pinggy/dist/index.cjs" });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test("a dev checkout", () => {
        const h = harness({}, { detectKind: () => InstallKind.DevCheckout });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test("a lock held by a live process", () => {
        const h = harness({}, { isLockHeld: () => true });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test.each([
        [DAY - 1, 0],
        [DAY + 1, 1],
    ])("a last check %i seconds ago", (age, spawns) => {
        const h = harness({ lastCheckEpochSeconds: NOW - age });
        run(h);
        expect(h.spawnCount()).toBe(spawns);
    });

    test("a last check in the future counts as missing", () => {
        const h = harness({ lastCheckEpochSeconds: NOW + 5000 });
        run(h);
        expect(h.spawnCount()).toBe(1);
    });

    test.each([
        [HOUR - 1, 0],
        [HOUR + 1, 1],
    ])("a last attempt %i seconds ago", (age, spawns) => {
        const h = harness({ lastAttemptEpochSeconds: NOW - age });
        run(h);
        expect(h.spawnCount()).toBe(spawns);
    });

    test("writes the attempt time before it spawns", () => {
        const h = harness();
        run(h);
        expect(h.state.lastAttemptEpochSeconds).toBe(NOW);
    });

    test("a failed attempt write spawns nothing", () => {
        const h = harness({}, { writeState: () => false });
        run(h);
        expect(h.spawnCount()).toBe(0);
    });

    test("with the 24-hour gate closed and no notice pending, the install kind is not detected", () => {
        const h = harness({ lastCheckEpochSeconds: NOW - 60 });
        run(h);
        expect(h.detectCount()).toBe(0);
    });

    test("a gate that throws never reaches the command", () => {
        const h = harness({}, { readState: () => { throw new Error("broken"); } });
        expect(() => run(h)).not.toThrow();
    });
});

describe("the pending notice", () => {
    const closedGate: UpdateState = { lastCheckEpochSeconds: NOW - 60 };

    test("the Updated line prints once", () => {
        const h = harness({ ...closedGate, updatedFromVersion: "0.6.3", updatedToVersion: "0.6.4" });
        run(h);
        run(h);
        expect(h.printed).toEqual(["Updated pinggy 0.6.3 to 0.6.4."]);
    });

    test("a copy at another version prints no Updated line", () => {
        const h = harness({ ...closedGate, updatedFromVersion: "0.6.4", updatedToVersion: "0.6.5" }, { runningVersion: "0.6.3" });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test("a manual update leaves no record, so nothing prints", () => {
        const h = harness({ ...closedGate, latestVersion: "0.6.4" });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test.each([
        [InstallKind.UnixLoose, "pinggy 0.6.5 is available. Run: curl -fsSL https://pinggy.io/install.sh | sh"],
        [InstallKind.WindowsReadOnly, "pinggy 0.6.5 is available. Run: curl -fsSL https://pinggy.io/install.sh | sh"],
        [InstallKind.Npm, "pinggy 0.6.5 is available. Run: npm i -g pinggy"],
    ] as [InstallKind, string][])("%s gets the hint once per release", (kind, line) => {
        const h = harness({ ...closedGate, latestVersion: "0.6.5" }, { detectKind: () => kind });
        run(h);
        run(h);
        expect(h.printed).toEqual([line]);
    });

    test("a self-updating install gets no hint in the first 7 days", () => {
        const h = harness({ ...closedGate, latestVersion: "0.6.5", latestSeenEpochSeconds: NOW - DAY });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test("after 7 days it says the update did not happen, once per release", () => {
        const h = harness({ ...closedGate, latestVersion: "0.6.5", latestSeenEpochSeconds: NOW - 8 * DAY });
        run(h);
        run(h);
        expect(h.printed).toEqual(["pinggy could not update itself to 0.6.5. Run: pinggy update"]);
    });

    test("a version the user rolled back from gets no such line", () => {
        const h = harness({ ...closedGate, latestVersion: "0.6.5", latestSeenEpochSeconds: NOW - 8 * DAY, rolledBackFromVersion: "0.6.5" });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test("no completed check in 30 days prints at most once every 30 days", () => {
        const h = harness({ lastCheckEpochSeconds: NOW - 31 * DAY, lastAttemptEpochSeconds: NOW - 60 });
        run(h);
        run(h);
        expect(h.printed).toEqual(["pinggy could not check for updates. Run: pinggy update"]);
        expect(h.state.lastCheckFailureNoticeEpochSeconds).toBe(NOW);
    });

    test("a dev checkout gets no such line", () => {
        const h = harness({ lastCheckEpochSeconds: NOW - 31 * DAY, lastAttemptEpochSeconds: NOW - 60 }, { detectKind: () => InstallKind.DevCheckout });
        run(h);
        expect(h.printed).toEqual([]);
    });

    const daemon = (host: DaemonHost): DaemonInfo => ({ pid: 1, port: 1, startedAt: "", host });

    test("the deferred line prints once for a CLI daemon", () => {
        const h = harness({ ...closedGate, deferredVersion: "0.7.0" }, { liveDaemon: () => daemon(DaemonHost.CLI) });
        run(h);
        run(h);
        expect(h.printed).toEqual([
            'pinggy 0.7.0 needs a daemon restart. Run "pinggy daemon stop", then "pinggy update". This stops all running tunnels.',
        ]);
    });

    test("the deferred line names the app for an app daemon", () => {
        const h = harness({ ...closedGate, deferredVersion: "0.7.0" }, { liveDaemon: () => daemon(DaemonHost.APP) });
        run(h);
        expect(h.printed).toEqual(['pinggy 0.7.0 needs a daemon restart. Update the Pinggy app, then run "pinggy update".']);
    });

    test("with no live daemon the deferred line does not print", () => {
        const h = harness({ ...closedGate, deferredVersion: "0.7.0" });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test("a state file that cannot be written prints nothing", () => {
        const h = harness({ ...closedGate, updatedFromVersion: "0.6.3", updatedToVersion: "0.6.4" }, { writeState: () => false });
        run(h);
        expect(h.printed).toEqual([]);
    });

    test("at most 1 line prints per command", () => {
        const h = harness({ ...closedGate, updatedFromVersion: "0.6.3", updatedToVersion: "0.6.4", deferredVersion: "0.7.0" }, { liveDaemon: () => daemon(DaemonHost.CLI) });
        run(h);
        expect(h.printed).toEqual(["Updated pinggy 0.6.3 to 0.6.4."]);
    });
});

describe("spawnUpdater", () => {
    test("is detached, silent, unreferenced, and carries no device token", () => {
        process.env.DEVICE_AGENT_TOKEN = "secret";
        const unref = jest.fn();
        const on = jest.fn();
        const spawnProcess = jest.fn(() => ({ on, unref }));
        try {
            spawnUpdater(spawnProcess as unknown as typeof spawn);
        } finally {
            delete process.env.DEVICE_AGENT_TOKEN;
        }
        const [, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
        expect(args).toContain("--_update-child");
        expect(options.detached).toBe(true);
        expect(options.stdio).toBe("ignore");
        expect((options.env as NodeJS.ProcessEnv).DEVICE_AGENT_TOKEN).toBeUndefined();
        expect(unref).toHaveBeenCalled();
        expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    });
});

describe("backgroundInstallKind", () => {
    const HOME = "C:\\Users\\me";

    test("a folder in the profile stays writable", () => {
        expect(backgroundInstallKind(InstallKind.WindowsWritable, `${HOME}\\Downloads\\pinggy.exe`, HOME)).toBe(InstallKind.WindowsWritable);
    });

    test("a folder outside the profile reads as read-only", () => {
        expect(backgroundInstallKind(InstallKind.WindowsWritable, "C:\\Tools\\pinggy.exe", HOME)).toBe(InstallKind.WindowsReadOnly);
    });

    test("another drive reads as read-only", () => {
        expect(backgroundInstallKind(InstallKind.WindowsWritable, "D:\\pinggy.exe", HOME)).toBe(InstallKind.WindowsReadOnly);
    });

    test("other kinds are unchanged", () => {
        expect(backgroundInstallKind(InstallKind.UnixLoose, "/opt/pinggy", "/home/me")).toBe(InstallKind.UnixLoose);
    });
});
