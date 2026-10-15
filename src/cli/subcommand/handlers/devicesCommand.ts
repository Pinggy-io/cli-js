/**
 * `pinggy devices` - run this machine as a Pinggy device.
 */
import pico from "picocolors";
import { cliOptions } from "../../options.js";
import { parseCliArgs } from "../../../utils/parseArgs.js";
import { configureLogger } from "../../../logger.js";
import CLIPrinter from "../../../utils/printer.js";
import { printDevicesHelp } from "../../../utils/helpMessages.js";
import { runDeviceAgent } from "../../../devices/deviceAgent.js";
import {
    DeviceIdentity, clearDeviceIdentity, maskToken,
} from "../../../devices/deviceIdentity.js";
import {
    EXIT_FAILED, EXIT_OK, machineDeviceLoginDependencies, runDeviceLogin,
} from "../../../devices/login/deviceLogin.js";
import {
    BackgroundAgentDependencies, foregroundRefusal, machineBackgroundAgentDependencies, printBackgroundStatus,
    startAgentInBackground, stopAgentBeforeRemove, stopAgentInBackground,
} from "../../../devices/backgroundAgent.js";

const DevicesVerb = {
    Login: "login",
    Connect: "connect",
    Stop: "stop",
    Status: "status",
    Remove: "remove",
} as const;
type DevicesVerb = typeof DevicesVerb[keyof typeof DevicesVerb];

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

/**
 * @param background how `-b`, `stop`, `status` and `remove` reach the daemon's agent. A test passes a fake.
 */
export async function handleDevices(args: string[],
                                    background: BackgroundAgentDependencies = machineBackgroundAgentDependencies()):
    Promise<void> {
    // First, for every verb: login runs the same agent, and its shells copy the environment too. So does a
    // daemon that `-b` starts.
    const environmentToken = takeEnvironmentToken();

    if (args.length === 0) {
        printDevicesHelp();
        return;
    }

    const verb = args[0];
    const flagArgs = args.slice(1);

    // --token, --manage, --name and -b already exist in cliOptions, so no option is added and every
    // existing one keeps its exact shape. Subcommand mode returns from main.ts before global flags
    // are handled, so the logger is configured here, the way handleStart does it.
    const { values } = parseCliArgs(cliOptions, flagArgs);
    configureLogger(values);
    const inBackground = Boolean(values.b);

    switch (verb as DevicesVerb) {
        case DevicesVerb.Login:
            exitUnlessOk(await handleDevicesLogin(values.manage, values.name, inBackground, background));
            return;

        case DevicesVerb.Connect:
            exitUnlessOk(await handleDevicesConnect(values.token, environmentToken, values.manage, inBackground,
                background));
            return;

        case DevicesVerb.Stop:
            exitUnlessOk(await stopAgentInBackground(background));
            return;

        case DevicesVerb.Status:
            await handleDevicesStatus(background);
            return;

        case DevicesVerb.Remove:
            exitUnlessOk(await handleDevicesRemove(background));
            return;

        default:
            if (verb === "help" || verb === "--help" || verb === "-h") {
                printDevicesHelp();
                return;
            }
            CLIPrinter.error(`Unknown command "${verb}". Valid commands: login, connect, stop, status, remove.`);
            process.exit(1);
    }
}

function exitUnlessOk(exitCode: number): void {
    if (exitCode !== EXIT_OK) {
        process.exit(exitCode);
    }
}

/** A foreground agent while the daemon runs one: refuse, and say so. @returns false when refused */
async function mayRunInForeground(background: BackgroundAgentDependencies): Promise<boolean> {
    const refusal = await foregroundRefusal(background);
    if (refusal) {
        CLIPrinter.error(refusal);
        return false;
    }
    return true;
}

async function handleDevicesLogin(manage: string | undefined, name: string | undefined, inBackground: boolean,
                                  background: BackgroundAgentDependencies): Promise<number> {
    if (!inBackground) {
        if (!(await mayRunInForeground(background))) return EXIT_FAILED;
        return runDeviceLogin({ manage, name });
    }
    return runDeviceLogin({ manage, name }, {
        ...machineDeviceLoginDependencies(),
        runAgent: (token, agentManage) => startAgentInBackground({ token, manage: agentManage }, background),
    });
}

async function handleDevicesConnect(flagToken: string | undefined, environmentToken: string | undefined,
                                    manage: string | undefined, inBackground: boolean,
                                    background: BackgroundAgentDependencies): Promise<number> {
    const target = resolveConnectTarget(flagToken, environmentToken, manage, background.readIdentity());

    if (!target) {
        CLIPrinter.error("This machine is not enrolled. Sign it in with your email:\n"
            + "  pinggy devices login\n"
            + "Or add a device in the dashboard, then run:\n"
            + "  pinggy devices connect --token <TOKEN>");
        return EXIT_FAILED;
    }

    if (inBackground) {
        return startAgentInBackground(target, background);
    }
    if (!(await mayRunInForeground(background))) return EXIT_FAILED;
    await runDeviceAgent(target.token, target.manage);
    return EXIT_OK;
}

async function handleDevicesStatus(background: BackgroundAgentDependencies): Promise<void> {
    const identity = background.readIdentity();
    if (!identity) {
        CLIPrinter.print("This machine is not enrolled. Run: pinggy devices login");
        return;
    }

    CLIPrinter.print(`  Device id  ${identity.device_agent_id ?? pico.gray("not yet assigned")}`);
    CLIPrinter.print(`  Server     ${identity.server}`);
    CLIPrinter.print(`  Token      ${maskToken(identity.token)}`);
    CLIPrinter.print(`  Enrolled   ${identity.enrolled_at ?? pico.gray("never")}`);
    await printBackgroundStatus(background);
}

async function handleDevicesRemove(background: BackgroundAgentDependencies): Promise<number> {
    // A background agent left running keeps the machine online and writes the file back on its next welcome.
    if (!(await stopAgentBeforeRemove(background))) {
        return EXIT_FAILED;
    }
    if (clearDeviceIdentity()) {
        CLIPrinter.success("Local device credential removed.");
        CLIPrinter.print(pico.gray("The device still exists in the dashboard. Delete it there to revoke it."));
    } else {
        CLIPrinter.print("This machine is not enrolled.");
    }
    return EXIT_OK;
}
