/**
 * `pinggy device remove`: show the device and whether it is connected, ask, stop every agent, then delete
 * device.json. The device stays in the dashboard.
 */
import pico from "picocolors";
import { DeviceIdentity, clearDeviceIdentity } from "./deviceIdentity.js";
import {
    BackgroundAgentDependencies, BackgroundAgentReading, describeAgent, isAgentRunning, readBackgroundAgent,
    stopAgentBeforeRemove,
} from "./backgroundAgent.js";
import {
    ForegroundAgentRecord, ForegroundStopDependencies, machineForegroundStopDependencies,
    stopForegroundAgentBeforeRemove,
} from "./foregroundAgent.js";
import { Prompter, isInteractiveTerminal, terminalPrompter } from "./login/prompts.js";
import { EXIT_FAILED, EXIT_OK } from "./login/deviceLogin.js";
import CLIPrinter from "../utils/printer.js";

const YES_ANSWER = /^y(es)?$/i;

const NO_TERMINAL_MESSAGE = "pinggy device remove asks before it removes the device. "
    + "Run it in a terminal, or add -f to remove without asking.";

export interface DeviceRemoveOptions {
    /** `-f`: remove without asking. */
    skipConfirmation: boolean;
}

export interface DeviceRemoveDependencies {
    background: BackgroundAgentDependencies;
    foreground: ForegroundStopDependencies;
    clearIdentity(): boolean;
    isInteractive(): boolean;
    prompter: Prompter;
    print(message: string): void;
    printSuccess(message: string): void;
    printError(message: string): void;
}

export function machineDeviceRemoveDependencies(background: BackgroundAgentDependencies): DeviceRemoveDependencies {
    return {
        background,
        foreground: machineForegroundStopDependencies(),
        clearIdentity: clearDeviceIdentity,
        isInteractive: isInteractiveTerminal,
        prompter: terminalPrompter,
        print: (message) => CLIPrinter.print(message),
        printSuccess: (message) => CLIPrinter.success(message),
        printError: (message) => CLIPrinter.error(message),
    };
}

/** What runs on this machine now. */
interface DeviceActivity {
    identity: DeviceIdentity | null;
    background: BackgroundAgentReading | null;
    foreground: ForegroundAgentRecord | null;
}

async function readActivity(dependencies: DeviceRemoveDependencies): Promise<DeviceActivity> {
    const reading = await readBackgroundAgent(dependencies.background);
    return {
        identity: dependencies.background.readIdentity(),
        background: reading && isAgentRunning(reading.status) ? reading : null,
        foreground: dependencies.background.readForegroundAgent(),
    };
}

/** The device, and every agent that keeps it online, before the question. */
export function describeActivity(activity: DeviceActivity): string[] {
    const { identity, background, foreground } = activity;
    const lines: string[] = [];
    if (identity) {
        const deviceAgentId = identity.device_agent_id ?? "(id not yet assigned)";
        lines.push(`This machine is device ${deviceAgentId} on ${identity.server}.`);
    }
    if (background) {
        lines.push(`The device agent runs in the background: ${describeAgent(background)}.`);
    }
    if (foreground) {
        lines.push(`The device agent runs in another terminal, PID ${foreground.pid}.`);
    }
    if (background || foreground) {
        lines.push("Removing it stops the agent, and the device shows offline in the dashboard.");
    } else {
        lines.push("The device is not connected now.");
    }
    return lines;
}

async function confirmed(options: DeviceRemoveOptions, dependencies: DeviceRemoveDependencies): Promise<boolean> {
    if (options.skipConfirmation) {
        return true;
    }
    const answer = await dependencies.prompter.ask("Remove this device from this machine? [y/N] ");
    return YES_ANSWER.test(answer.trim());
}

/** @returns the process exit code */
export async function runDeviceRemove(options: DeviceRemoveOptions,
                                      dependencies: DeviceRemoveDependencies): Promise<number> {
    const activity = await readActivity(dependencies);
    if (!activity.identity && !activity.background && !activity.foreground) {
        dependencies.print(pico.yellow("This machine is not enrolled."));
        return EXIT_OK;
    }
    if (!options.skipConfirmation && !dependencies.isInteractive()) {
        dependencies.printError(NO_TERMINAL_MESSAGE);
        return EXIT_FAILED;
    }

    describeActivity(activity).forEach((line) => dependencies.print(line));
    if (!(await confirmed(options, dependencies))) {
        dependencies.print("Nothing removed.");
        return EXIT_OK;
    }

    // A running agent keeps the machine online and writes device.json back on its next welcome.
    if (!(await stopAgentBeforeRemove(dependencies.background))) {
        return EXIT_FAILED;
    }
    if (!(await stopForegroundAgentBeforeRemove(dependencies.foreground))) {
        return EXIT_FAILED;
    }
    dependencies.background.forgetSavedAgent();
    if (dependencies.clearIdentity()) {
        dependencies.printSuccess("Local device credential removed.");
        dependencies.print(pico.gray("The device still exists in the dashboard. Delete it there to revoke it."));
    }
    return EXIT_OK;
}
