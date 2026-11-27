/**
 * `pinggy device` - run this machine as a Pinggy device.
 */
import pico from "picocolors";
import { cliOptions } from "../../options.js";
import { parseCliArgs } from "../../../utils/parseArgs.js";
import { configureLogger } from "../../../logger.js";
import CLIPrinter from "../../../utils/printer.js";
import { printDeviceHelp } from "../../../utils/helpMessages.js";
import { runDeviceAgent } from "../../../devices/deviceAgent.js";
import { DeviceIdentity, maskToken } from "../../../devices/deviceIdentity.js";
import {
    DeviceLoginOptions, EXIT_FAILED, EXIT_OK, machineDeviceLoginDependencies, runDeviceLogin,
} from "../../../devices/login/deviceLogin.js";
import {
    BackgroundAgentDependencies, describeDeviceState, foregroundRefusal, machineBackgroundAgentDependencies,
    printBackgroundStatus, readBackgroundAgent, startAgentInBackground, stopAgentInBackground,
} from "../../../devices/backgroundAgent.js";
import { foregroundAgentRefusal } from "../../../devices/foregroundAgent.js";
import { machineDeviceRemoveDependencies, runDeviceRemove } from "../../../devices/removeDevice.js";
import {
    FileAccessDependencies, INVALID_FILES_FLAG_MESSAGE, describeFileAccess, machineFileAccessDependencies,
    parseFilesFlag, settleFileAccess,
} from "../../../devices/fileAccess.js";
import { isCtrlCAtPrompt } from "../../../devices/login/prompts.js";

const DeviceVerb = {
    Login: "login",
    Connect: "connect",
    Start: "start",
    Stop: "stop",
    Status: "status",
    Remove: "remove",
} as const;
type DeviceVerb = typeof DeviceVerb[keyof typeof DeviceVerb];

/**
 * The device token the dashboard's install command hands to `connect`. Users set it, so it has no
 * `PINGGY_` prefix. The environment and not `--token`, because a command line shows in `ps` to every
 * user of the machine for as long as the agent runs.
 */
export const DEVICE_AGENT_TOKEN_VARIABLE = "DEVICE_AGENT_TOKEN";

/**
 * Reads the variable, then deletes it from this process's environment. Every shell the terminal opens
 * and every daemon the agent starts copies `process.env`, so without the delete `env` in a browser shell
 * prints the token. An empty value counts as unset.
 */
export function takeEnvironmentToken(): string | undefined {
    const value = process.env[DEVICE_AGENT_TOKEN_VARIABLE]?.trim();
    delete process.env[DEVICE_AGENT_TOKEN_VARIABLE];
    return value || undefined;
}

export interface ConnectTarget {
    token: string;
    /** Undefined dials dashboard.pinggy.io. */
    manage: string | undefined;
}

/**
 * The token: `--token`, else the variable, else `device.json`. The server: `--manage`, else production
 * for a token from the variable, else the server in `device.json`. The stored server belongs to the
 * stored token, so a machine once enrolled on a test dashboard never sends a production token there.
 */
export function resolveConnectTarget(flagToken: string | undefined, environmentToken: string | undefined,
                                     manage: string | undefined,
                                     stored: DeviceIdentity | null): ConnectTarget | null {
    if (flagToken) {
        return { token: flagToken, manage: manage ?? stored?.server };
    }
    if (environmentToken) {
        return { token: environmentToken, manage };
    }
    if (stored?.token) {
        return { token: stored.token, manage: manage ?? stored.server };
    }
    return null;
}

/** What `connect` and `start` were given on the command line and in the environment. */
interface ConnectRequest {
    flagToken: string | undefined;
    environmentToken: string | undefined;
    manage: string | undefined;
    inBackground: boolean;
    /** `--files`. Undefined without the flag. */
    fileManager: boolean | undefined;
}

/**
 * @param background how `login`, `connect`, `start`, `stop`, `status` and `remove` reach the daemon's agent. A test
 *                   passes a fake.
 * @param fileAccess how `connect` and `start` ask the file access question and save the answer. A test passes a fake.
 */
export async function handleDevice(args: string[],
                                   background: BackgroundAgentDependencies = machineBackgroundAgentDependencies(),
                                   fileAccess: FileAccessDependencies = machineFileAccessDependencies()):
    Promise<void> {
    // First, for every verb: login runs the same agent, and its shells copy the environment too. So does a
    // daemon that login or connect starts.
    const environmentToken = takeEnvironmentToken();

    if (args.length === 0) {
        printDeviceHelp();
        return;
    }

    const verb = args[0];
    const flagArgs = args.slice(1);

    // main.ts parses the whole command line with cliOptions before it dispatches, so --foreground lives
    // there too, hidden. remove reads -f, the existing --force, to skip its question. Subcommand mode
    // returns from main.ts before global flags are handled, so the logger is configured here, the way
    // handleStart does it.
    const { values } = parseCliArgs(cliOptions, flagArgs);
    configureLogger(values);
    if (values.b && values.foreground) {
        CLIPrinter.error("-b and --foreground contradict each other. The agent runs in the background "
            + "unless --foreground is given.");
        process.exit(1);
    }
    // -b is the default, and still parses for scripts that pass it.
    const inBackground = !values.foreground;
    const fileManager = parseFilesFlag(values.files);
    if (fileManager === null) {
        CLIPrinter.error(INVALID_FILES_FLAG_MESSAGE);
        process.exit(1);
    }

    switch (verb as DeviceVerb) {
        case DeviceVerb.Login:
            exitUnlessOk(await handleDeviceLogin({ manage: values.manage, name: values.name, fileManager },
                inBackground, background));
            return;

        case DeviceVerb.Connect:
        case DeviceVerb.Start:
            exitUnlessOk(await handleDeviceConnect({
                flagToken: values.token, environmentToken, manage: values.manage, inBackground, fileManager,
            }, background, fileAccess));
            return;

        case DeviceVerb.Stop:
            exitUnlessOk(await stopAgentInBackground(background));
            return;

        case DeviceVerb.Status:
            await handleDeviceStatus(background);
            return;

        case DeviceVerb.Remove:
            exitUnlessOk(await runDeviceRemove({ skipConfirmation: Boolean(values.force) },
                machineDeviceRemoveDependencies(background)));
            return;

        default:
            if (verb === "help" || verb === "--help" || verb === "-h") {
                printDeviceHelp();
                return;
            }
            CLIPrinter.error(`Unknown command "${verb}". Valid commands: login, connect, start, stop, status, remove.`);
            process.exit(1);
    }
}

function exitUnlessOk(exitCode: number): void {
    if (exitCode !== EXIT_OK) {
        process.exit(exitCode);
    }
}

/**
 * `pinggy devices`, the old spelling: print the new one and exit 1. Reads no flag, no environment and no file.
 */
export function refuseDevicesSpelling(args: string[]): void {
    CLIPrinter.error(devicesSpellingMessage(args));
    process.exit(1);
}

/** Names the verb when it is 1 of the 6, else `--help`. Never the other arguments, which can hold a token. */
export function devicesSpellingMessage(args: string[]): string {
    const verbs: string[] = Object.values(DeviceVerb);
    const suggestion = verbs.includes(args[0]) ? args[0] : "--help";
    return `"pinggy devices" is now "pinggy device". Run: pinggy device ${suggestion}`;
}

/** A foreground agent while the daemon or another terminal runs one: refuse, and say so. @returns false when refused */
async function mayRunInForeground(background: BackgroundAgentDependencies): Promise<boolean> {
    const refusal = foregroundAgentRefusal(background.readForegroundAgent()) ?? await foregroundRefusal(background);
    if (refusal) {
        CLIPrinter.error(refusal);
        return false;
    }
    return true;
}

/** `-b` while another terminal runs an agent: refuse, and say so. @returns false when refused */
function mayRunInBackground(background: BackgroundAgentDependencies): boolean {
    const refusal = foregroundAgentRefusal(background.readForegroundAgent());
    if (refusal) {
        CLIPrinter.error(refusal);
        return false;
    }
    return true;
}

async function handleDeviceLogin(options: DeviceLoginOptions, inBackground: boolean,
                                 background: BackgroundAgentDependencies): Promise<number> {
    if (!inBackground) {
        if (!(await mayRunInForeground(background))) return EXIT_FAILED;
        return runDeviceLogin(options);
    }
    if (!mayRunInBackground(background)) return EXIT_FAILED;
    return runDeviceLogin(options, {
        ...machineDeviceLoginDependencies(),
        runAgent: (token, agentManage, signInShown) =>
            startAgentInBackground({ token, manage: agentManage }, background, { signInShown }),
    });
}

async function handleDeviceConnect(request: ConnectRequest, background: BackgroundAgentDependencies,
                                   fileAccess: FileAccessDependencies): Promise<number> {
    const stored = background.readIdentity();
    const target = resolveConnectTarget(request.flagToken, request.environmentToken, request.manage, stored);

    if (!target) {
        CLIPrinter.error("This machine is not enrolled. Sign it in with your email:\n"
            + "  pinggy device login\n"
            + "Or add a device in the dashboard, then run:\n"
            + "  pinggy device connect --token <TOKEN>");
        return EXIT_FAILED;
    }

    const mayRun = request.inBackground ? mayRunInBackground(background) : await mayRunInForeground(background);
    if (!mayRun) return EXIT_FAILED;

    let fileManager: boolean | undefined;
    try {
        fileManager = await settleFileAccess(request.fileManager, target.token, stored, fileAccess);
    } catch (err) {
        if (!isCtrlCAtPrompt(err)) throw err;
        fileAccess.print(pico.yellow("Cancelled. Nothing changed."));
        return EXIT_FAILED;
    }

    if (request.inBackground) {
        return startAgentInBackground(target, background, { fileManager });
    }
    await runDeviceAgent(target.token, target.manage, { fileManager });
    return EXIT_OK;
}

async function handleDeviceStatus(background: BackgroundAgentDependencies): Promise<void> {
    const identity = background.readIdentity();
    if (!identity) {
        CLIPrinter.print(pico.yellow("This machine is not enrolled. Run: pinggy device login"));
        return;
    }

    // 1 read of each source, so the state line and the detail lines below it cannot disagree.
    const reading = await readBackgroundAgent(background);
    const foreground = background.readForegroundAgent();
    const daemonFound = background.findDaemon() !== null;

    CLIPrinter.print(`  State      ${describeDeviceState(reading, daemonFound, foreground)}`);
    CLIPrinter.print(`  Device id  ${identity.device_agent_id ?? pico.gray("not yet assigned")}`);
    CLIPrinter.print(`  Server     ${identity.server}`);
    CLIPrinter.print(`  Token      ${maskToken(identity.token)}`);
    CLIPrinter.print(`  Enrolled   ${identity.enrolled_at ?? pico.gray("never")}`);
    CLIPrinter.print(`  Autostart  ${background.hasSavedAgent() ? "on, starts with the daemon" : pico.gray("off")}`);
    CLIPrinter.print(`  Files      ${describeFileAccess(identity)}`);
    if (foreground) {
        CLIPrinter.print(`  Foreground running in another terminal, PID ${foreground.pid}`);
    }
    printBackgroundStatus(reading, background);
}
