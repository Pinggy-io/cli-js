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
import { clearDeviceIdentity, maskToken, readDeviceIdentity } from "../../../devices/deviceIdentity.js";

const DevicesVerb = {
    Connect: "connect",
    Status: "status",
    Remove: "remove",
} as const;
type DevicesVerb = typeof DevicesVerb[keyof typeof DevicesVerb];

export async function handleDevices(args: string[]): Promise<void> {
    if (args.length === 0) {
        printDevicesHelp();
        return;
    }

    const verb = args[0];
    const flagArgs = args.slice(1);

    // --token and --manage already exist in cliOptions, so no option is added and every existing
    // one keeps its exact shape. Subcommand mode returns from main.ts before global flags are
    // handled, so the logger is configured here, the way handleStart does it.
    const { values } = parseCliArgs(cliOptions, flagArgs);
    configureLogger(values);

    switch (verb as DevicesVerb) {
        case DevicesVerb.Connect:
            await handleDevicesConnect(values.token, values.manage);
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
            CLIPrinter.error(`Unknown command "${verb}". Valid commands: connect, status, remove.`);
            process.exit(1);
    }
}

async function handleDevicesConnect(token: string | undefined, manage: string | undefined): Promise<void> {
    const stored = readDeviceIdentity();
    const resolvedToken = token ?? stored?.token;

    if (!resolvedToken) {
        CLIPrinter.error("A device token is required. Add a device in the dashboard, then run:\n"
            + "  pinggy devices connect --token <TOKEN>");
        process.exit(1);
    }

    await runDeviceAgent(resolvedToken, manage ?? stored?.server);
}

function handleDevicesStatus(): void {
    const identity = readDeviceIdentity();
    if (!identity) {
        CLIPrinter.print("This machine is not enrolled. Run: pinggy devices connect --token <TOKEN>");
        return;
    }

    CLIPrinter.print(`  Device id  ${identity.device_agent_id ?? pico.gray("not yet assigned")}`);
    CLIPrinter.print(`  Server     ${identity.server}`);
    CLIPrinter.print(`  Token      ${maskToken(identity.token)}`);
    CLIPrinter.print(`  Enrolled   ${identity.enrolled_at ?? pico.gray("never")}`);
}
