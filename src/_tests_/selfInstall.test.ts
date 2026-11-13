import { describe, expect, test } from "@jest/globals";
import {
    InstalledBinary,
    NpmRemoval,
    offerSelfInstall,
    SelfInstallAnswer,
    SelfInstallCommand,
    SelfInstallEnvironment,
} from "../install/selfInstall.js";
import { NpmCopy, PinggyCommand } from "../install/pinggyOnPath.js";
import { UpdateState } from "../update/updateState.js";

const HOME = "/home/me";
const DOWNLOAD = "/home/me/Downloads/pinggy";
const INSTALLED = "/home/me/.pinggy/bin/pinggy";
const NPM: NpmCopy = { prefix: "/usr/local", packageFolder: "/usr/local/lib/node_modules/pinggy" };
const NPM_COMMAND: PinggyCommand = { commandPath: "/usr/local/bin/pinggy", npm: NPM };
const tunnelCommand: SelfInstallCommand = { rawArgs: ["-l", "3000"], values: {} };

interface Harness {
    environment: SelfInstallEnvironment;
    state: UpdateState;
    questions: string[];
    printed: string[];
    calls: string[];
    daemonBinary: string | null;
}

interface Setup {
    answer?: SelfInstallAnswer;
    state?: UpdateState;
    /** What `pinggy` runs: before the install, then after it. */
    commands?: (PinggyCommand | null)[];
    installed?: InstalledBinary | null;
    npmVersion?: string | null;
    installerSucceeds?: boolean;
    removal?: NpmRemoval;
    overrides?: Partial<SelfInstallEnvironment>;
}

function harness(setup: Setup = {}): Harness {
    const commands = [...(setup.commands ?? [null])];
    const h: Harness = {
        state: { ...setup.state },
        questions: [],
        printed: [],
        calls: [],
        daemonBinary: null,
        environment: {
            platform: "linux",
            variables: { PATH: "/usr/local/bin:/usr/bin" },
            isPackaged: true,
            stdinIsTerminal: true,
            stdoutIsTerminal: true,
            execPath: DOWNLOAD,
            runningVersion: "0.6.7",
            home: HOME,
            fileExists: () => false,
            isInstalledCopy: () => false,
            findPinggyCommand: () => (commands.length > 1 ? commands.shift() ?? null : commands[0] ?? null),
            installedBinary: async () => setup.installed ?? null,
            npmVersion: () => (setup.npmVersion === undefined ? "0.6.6" : setup.npmVersion),
            readState: () => ({ ...h.state }),
            writeState: (patch) => { h.state = { ...h.state, ...patch }; return true; },
            isLockHeld: () => false,
            acquireLock: async () => { h.calls.push("lock"); return true; },
            releaseLock: () => { h.calls.push("unlock"); },
            ask: async (question) => { h.questions.push(question); return setup.answer ?? SelfInstallAnswer.Yes; },
            runInstaller: async () => { h.calls.push("install"); return setup.installerSucceeds ?? true; },
            removeNpmCopy: async () => { h.calls.push("npm uninstall"); return setup.removal ?? NpmRemoval.Removed; },
            useInstalledBinaryForDaemon: (binaryPath) => { h.daemonBinary = binaryPath; },
            print: (line) => { h.printed.push(line); },
            ...setup.overrides,
        },
    };
    return h;
}

async function run(h: Harness, command: SelfInstallCommand = tunnelCommand): Promise<boolean> {
    return (await offerSelfInstall(command, () => h.environment)).questionShown;
}

describe("when the question is skipped", () => {
    test.each([
        ["an npm copy, the app or a dev checkout", { isPackaged: false }],
        ["no terminal on stdin", { stdinIsTerminal: false }],
        ["no terminal on stdout", { stdoutIsTerminal: false }],
        ["sudo", { variables: { SUDO_UID: "501" } }],
        ["a container", { fileExists: (filePath: string) => filePath === "/.dockerenv" }],
        ["a version that does not parse", { runningVersion: "dev" }],
        ["no home folder", { home: null }],
        ["the installed copy", { isInstalledCopy: () => true }],
        ["another process holding the update lock", { isLockHeld: () => true }],
        ["an update.json that cannot be written", { writeState: () => false }],
    ] as [string, Partial<SelfInstallEnvironment>][])("%s", async (_name, overrides) => {
        const h = harness({ overrides });
        expect(await run(h)).toBe(false);
        expect(h.questions).toEqual([]);
    });

    test.each([
        ["--version", { rawArgs: ["--version"], values: { version: true } }],
        ["--help", { rawArgs: ["--help"], values: { help: true } }],
        ["pinggy update", { rawArgs: ["update"], values: {} }],
    ] as [string, SelfInstallCommand][])("%s", async (_name, command) => {
        const h = harness();
        expect(await run(h, command)).toBe(false);
    });

    test("a remembered n for this file and version", async () => {
        const h = harness({ state: { declinedInstallPath: DOWNLOAD, declinedInstallVersion: "0.6.7" } });
        expect(await run(h)).toBe(false);
    });

    test("a remembered n for another version asks again", async () => {
        const h = harness({ state: { declinedInstallPath: DOWNLOAD, declinedInstallVersion: "0.6.6" } });
        expect(await run(h)).toBe(true);
    });

    test("Windows compares the remembered path without case", async () => {
        const execPath = "C:\\Users\\me\\Downloads\\pinggy.exe";
        const h = harness({
            state: { declinedInstallPath: execPath.toUpperCase(), declinedInstallVersion: "0.6.7" },
            overrides: { platform: "win32", execPath, variables: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, home: "C:\\Users\\me" },
        });
        expect(await run(h)).toBe(false);
    });

    test("no arguments, as a double-click on Windows, still asks", async () => {
        const h = harness();
        expect(await run(h, { rawArgs: [], values: {} })).toBe(true);
    });

    test("an error inside the check never reaches the command", async () => {
        const h = harness({ overrides: { installedBinary: async () => { throw new Error("disk gone"); } } });
        expect(await run(h)).toBe(false);
    });
});

describe("which question shows", () => {
    test("(c) nothing installed", async () => {
        const h = harness();
        await run(h);
        expect(h.questions).toEqual(["Install this pinggy, 0.6.7, to ~/.pinggy/bin/pinggy? [Y/n] "]);
    });

    test.each(["0.6.6", "0.6.7", "0.6.8"])("(b) an installed %s asks, with both versions printed", async (version) => {
        const h = harness({ installed: { path: INSTALLED, version } });
        await run(h);
        expect(h.questions).toEqual([`pinggy ${version} is installed in ~/.pinggy/bin/pinggy. Replace it with this pinggy, 0.6.7? [Y/n] `]);
    });

    test("(b) an installed binary that does not run", async () => {
        const h = harness({ installed: { path: INSTALLED, version: null } });
        await run(h);
        expect(h.questions).toEqual(["~/.pinggy/bin/pinggy does not run. Replace it with this pinggy, 0.6.7? [Y/n] "]);
    });

    test("(a) an npm copy", async () => {
        const h = harness({ commands: [NPM_COMMAND] });
        await run(h);
        expect(h.questions).toEqual([
            "pinggy 0.6.6 is installed with npm. Remove it, and install this pinggy, 0.6.7, to ~/.pinggy/bin/pinggy? [Y/n] ",
        ]);
    });

    test.each(["0.6.7", "0.6.9"])("(a) an npm copy at %s still asks", async (npmVersion) => {
        const h = harness({ commands: [NPM_COMMAND], npmVersion });
        expect(await run(h)).toBe(true);
    });

    test("(a) an npm copy with no readable version", async () => {
        const h = harness({ commands: [NPM_COMMAND], npmVersion: null });
        await run(h);
        expect(h.questions[0]).toMatch(/^pinggy is installed with npm\. Remove it, and install this pinggy, 0\.6\.7/);
    });

    test("(a) an installed binary of any version does not change the npm question", async () => {
        const h = harness({ commands: [NPM_COMMAND], installed: { path: INSTALLED, version: "0.6.8" } });
        await run(h);
        expect(h.questions).toEqual([
            "pinggy 0.6.6 is installed with npm. Remove it, and install this pinggy, 0.6.7, to ~/.pinggy/bin/pinggy? [Y/n] ",
        ]);
    });

    test("a copy this file cannot remove gets the (c) question", async () => {
        const h = harness({ commands: [{ commandPath: "/Users/me/.nvm/bin/pinggy", npm: null }] });
        await run(h);
        expect(h.questions).toEqual(["Install this pinggy, 0.6.7, to ~/.pinggy/bin/pinggy? [Y/n] "]);
    });

    test("Windows names the full install path", async () => {
        const h = harness({
            overrides: {
                platform: "win32",
                execPath: "C:\\Users\\me\\Downloads\\pinggy.exe",
                variables: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
                home: "C:\\Users\\me",
            },
        });
        await run(h);
        expect(h.questions).toEqual(["Install this pinggy, 0.6.7, to C:\\Users\\me\\AppData\\Local\\Pinggy\\bin\\pinggy.exe? [Y/n] "]);
    });
});

describe("after the answer", () => {
    test("n is remembered for this file and version, and nothing installs", async () => {
        const h = harness({ answer: SelfInstallAnswer.No });
        expect(await run(h)).toBe(true);
        expect(h.state).toMatchObject({ declinedInstallPath: DOWNLOAD, declinedInstallVersion: "0.6.7" });
        expect(h.calls).toEqual([]);
    });

    test("Ctrl+D installs nothing and remembers nothing", async () => {
        const h = harness({ answer: SelfInstallAnswer.Closed });
        await run(h);
        expect(h.state.declinedInstallPath).toBeUndefined();
        expect(h.calls).toEqual([]);
    });

    test("yes installs under the lock, and the daemon starts from the installed copy", async () => {
        const h = harness();
        await run(h);
        expect(h.calls).toEqual(["lock", "install", "unlock"]);
        expect(h.daemonBinary).toBe(INSTALLED);
        expect(h.printed).toEqual([]);
    });

    test("a failed install prints the install command and is remembered like n", async () => {
        const h = harness({ installerSucceeds: false });
        await run(h);
        expect(h.printed).toEqual(["Could not install pinggy. To install it later, run: curl -fsSL https://pinggy.io/install.sh | sh"]);
        expect(h.state).toMatchObject({ declinedInstallPath: DOWNLOAD, declinedInstallVersion: "0.6.7" });
        expect(h.daemonBinary).toBeNull();
        expect(h.calls).toEqual(["lock", "install", "unlock"]);
    });

    test("a lock taken between the question and the install skips the install", async () => {
        const h = harness({ overrides: { acquireLock: async () => false } });
        await run(h);
        expect(h.printed).toEqual(["Another pinggy is installing or updating. Skipped the install."]);
        expect(h.calls).toEqual([]);
    });

    test("(a) installs first, then removes npm's copy", async () => {
        const h = harness({ commands: [NPM_COMMAND, null] });
        await run(h);
        expect(h.calls).toEqual(["lock", "install", "npm uninstall", "unlock"]);
        expect(h.printed).toEqual(["Removed npm's pinggy.", "Open a new terminal to use the installed pinggy."]);
    });

    test("(a) a folder this user cannot change gets the sudo command, never runs it", async () => {
        const h = harness({ commands: [NPM_COMMAND, NPM_COMMAND], removal: NpmRemoval.NotWritable });
        await run(h);
        expect(h.printed[0]).toBe("This user cannot change /usr/local. To remove npm's pinggy, run: sudo npm uninstall -g --prefix /usr/local pinggy");
    });

    test("(a) no npm on PATH prints the command", async () => {
        const h = harness({ commands: [NPM_COMMAND, null], removal: NpmRemoval.NoNpm });
        await run(h);
        expect(h.printed).toEqual(["npm is not on PATH. To remove npm's pinggy, run: npm uninstall -g --prefix /usr/local pinggy"]);
    });

    test("(a) a failed removal names daemon stop", async () => {
        const h = harness({ commands: [NPM_COMMAND, null], removal: NpmRemoval.Failed });
        await run(h);
        expect(h.printed).toEqual([
            "Could not remove npm's pinggy. If pinggy is running, run: pinggy daemon stop",
            "Then run: npm uninstall -g --prefix /usr/local pinggy",
        ]);
    });
});

describe("the PATH warning after an install", () => {
    const onPath = { PATH: "/usr/local/bin:/home/me/.local/bin/:/usr/bin" };

    test("another pinggy before ~/.local/bin", async () => {
        const other = { commandPath: "/usr/local/bin/pinggy", npm: null };
        const h = harness({ commands: [other, other], overrides: { variables: onPath } });
        await run(h);
        expect(h.printed).toEqual([
            "Another pinggy, /usr/local/bin/pinggy, comes before ~/.local/bin on PATH, so the pinggy command runs it.",
            "Remove it, or move ~/.local/bin earlier in PATH.",
        ]);
    });

    test("the installed link first prints nothing", async () => {
        const h = harness({ commands: [null, { commandPath: "/home/me/.local/bin/pinggy", npm: null }], overrides: { variables: onPath } });
        await run(h);
        expect(h.printed).toEqual([]);
    });

    test("~/.local/bin missing from PATH prints nothing: the script's rc line puts it first", async () => {
        const other = { commandPath: "/usr/local/bin/pinggy", npm: null };
        const h = harness({ commands: [other, other] });
        await run(h);
        expect(h.printed).toEqual([]);
    });

    test("Windows names the install folder", async () => {
        const other = { commandPath: "C:\\Tools\\pinggy.exe", npm: null };
        const h = harness({
            commands: [other, other],
            overrides: {
                platform: "win32",
                execPath: "C:\\Users\\me\\Downloads\\pinggy.exe",
                variables: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
                home: "C:\\Users\\me",
            },
        });
        await run(h);
        expect(h.printed).toEqual([
            "Another pinggy, C:\\Tools\\pinggy.exe, comes before C:\\Users\\me\\AppData\\Local\\Pinggy\\bin on PATH, so the pinggy command runs it.",
            "Remove it, or move C:\\Users\\me\\AppData\\Local\\Pinggy\\bin earlier in PATH.",
        ]);
    });
});
