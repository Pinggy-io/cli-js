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
    DeviceIdentity, clearDeviceIdentity, maskToken, readDeviceIdentity,
} from "../../../devices/deviceIdentity.js";
import { EXIT_OK, runDeviceLogin } from "../../../devices/login/deviceLogin.js";

const DevicesVerb = {
    Login: "login",
    Connect: "connect",
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

export async function handleDevices(args: string[]): Promise<void> {
    // First, for every verb: login runs the same agent, and its shells copy the environment too.
    const environmentToken = takeEnvironmentToken();

    if (args.length === 0) {
        printDevicesHelp();
        return;
    }

    const verb = args[0];
    const flagArgs = args.slice(1);

    // --token, --manage and --name already exist in cliOptions, so no option is added and every
    // existing one keeps its exact shape. Subcommand mode returns from main.ts before global flags
    // are handled, so the logger is configured here, the way handleStart does it.
    const { values } = parseCliArgs(cliOptions, flagArgs);
    configureLogger(values);

    switch (verb as DevicesVerb) {
        case DevicesVerb.Login: {
            const exitCode = await runDeviceLogin({ manage: values.manage, name: values.name });
            if (exitCode !== EXIT_OK) {
                process.exit(exitCode);
            }
            return;
        }

        case DevicesVerb.Connect:
            await handleDevicesConnect(values.token, environmentToken, values.manage);
            return;

        case DevicesVerb.Status:
            handleDevicesStatus();
            return;

        case DevicesVerb.Remove:
            if (clearDeviceIdentity()) {
                CLIPrinter.success("Local device credential removed.");
                CLIPrinter.print(pico.gray("The device still exists in the dashboard. Delete it there to revoke it."));
            } else {
                CLIPrinter.print("This machine is not enrolled.");
            }
            return;

        default:
            if (verb === "help" || verb === "--help" || verb === "-h") {
                printDevicesHelp();
                return;
            }
            CLIPrinter.error(`Unknown command "${verb}". Valid commands: login, connect, status, remove.`);
            process.exit(1);
    }
}

async function handleDevicesConnect(flagToken: string | undefined, environmentToken: string | undefined,
                                    manage: string | undefined): Promise<void> {
    const target = resolveConnectTarget(flagToken, environmentToken, manage, readDeviceIdentity());

    if (!target) {
        CLIPrinter.error("This machine is not enrolled. Sign it in with your email:\n"
            + "  pinggy devices login\n"
            + "Or add a device in the dashboard, then run:\n"
            + "  pinggy devices connect --token <TOKEN>");
        process.exit(1);
    }

    await runDeviceAgent(target.token, target.manage);
}

function handleDevicesStatus(): void {
    const identity = readDeviceIdentity();
    if (!identity) {
        CLIPrinter.print("This machine is not enrolled. Run: pinggy devices login");
        return;
    }

    CLIPrinter.print(`  Device id  ${identity.device_agent_id ?? pico.gray("not yet assigned")}`);
    CLIPrinter.print(`  Server     ${identity.server}`);
    CLIPrinter.print(`  Token      ${maskToken(identity.token)}`);
    CLIPrinter.print(`  Enrolled   ${identity.enrolled_at ?? pico.gray("never")}`);
}
