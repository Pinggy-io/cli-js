import { logger } from "../logger.js";
import CLIPrinter from "../utils/printer.js";
import { getDaemonLogPath } from "../utils/configDir.js";
import { errorMessage } from "../utils/util.js";
import { isErrorResponse } from "../types.js";
import { DaemonInfo } from "../daemon/lifecycle/daemonChild.js";
import { ensureDaemonRunning, getDaemonInfo, isIpcCompatible } from "../daemon/lifecycle/daemonManager.js";
import { HTTP_NOT_FOUND, IPCClient, IPCHttpError } from "../daemon/ipc/ipcClient.js";
import { DaemonHost, DeviceAgentState, DeviceAgentStatus } from "../daemon/ipc/ipcRoutes.js";
import { DeviceIdentity, readDeviceIdentity } from "./deviceIdentity.js";
import { DEFAULT_SERVER, DeviceAgentEnd, startDeviceAgent } from "./deviceAgent.js";
import { DeviceAgentReporter, printingReporter } from "./deviceAgentReporter.js";
import { EXIT_FAILED, EXIT_OK } from "./login/deviceLogin.js";

/**
 * The CLI's half of `pinggy devices connect -b` and `pinggy devices login -b`: hand the agent to the daemon,
 * as `pinggy start -b` hands it a tunnel, then exit once the device is connected.
 *
 * The token never goes over IPC. device.json is the hand-off: the CLI writes it, and the daemon reads it.
 * A token that differs from device.json is checked here first, with 1 handshake that ends at `welcome`.
 * `welcome` writes device.json, as in the foreground. A token the dashboard refuses never reaches the file.
 *
 * `devices stop`, `devices status`, `devices remove`, and the refusal of a foreground agent while the
 * daemon runs one, read the daemon's agent here too.
 *
 * See docs/pinggy-devices/slices/17-background-agent.md in the pinggy_backend repo.
 */

/** How often `-b` asks the daemon whether the device connected. */
const POLL_INTERVAL_MILLIS = 500;

/** How long `-b` waits for `connected` before it leaves the daemon to it. */
const CONNECT_WAIT_MILLIS = 15_000;

/** The daemon calls this file makes. A subset of IPCClient, so a test needs no daemon. */
export type DeviceAgentDaemonClient = Pick<IPCClient, "getDeviceAgentStatus" | "startDeviceAgent" | "stopDeviceAgent">;

/** Everything this file touches, so a test runs it with no daemon, no dashboard and no terminal. */
export interface BackgroundAgentDependencies {
    readIdentity(): DeviceIdentity | null;
    /** The running daemon, from daemon.json. Never starts one. */
    findDaemon(): DaemonInfo | null;
    /** The running daemon, or a new one. Throws when the one running speaks another IPC version. */
    ensureDaemon(): Promise<DaemonInfo>;
    client(port: number): DeviceAgentDaemonClient;
    /** 1 handshake with this token, ended at `welcome`, which writes device.json. */
    verify(token: string, manage: string | undefined): Promise<DeviceAgentEnd>;
    sleep(millis: number): Promise<void>;
    now(): number;
    print(message: string): void;
    printSuccess(message: string): void;
    printWarning(message: string): void;
    printError(message: string): void;
    daemonLogPath(): string;
}

/** The token and the server a command resolved, as `resolveConnectTarget()` returns them. */
export interface AgentTarget {
    token: string;
    /** Undefined dials dashboard.pinggy.io. */
    manage: string | undefined;
}

/** What the running daemon reports about its agent. */
export interface BackgroundAgentReading {
    daemon: DaemonInfo;
    status: DeviceAgentStatus;
}

/** A verify prints only what goes wrong. The daemon's run reports the device once it connects. */
const verifyingReporter: DeviceAgentReporter = {
    connecting: () => undefined,
    connected: () => undefined,
    reconnecting: () => undefined,
    warn: (message) => CLIPrinter.warn(message),
    // The caller prints the error the run ends with.
    failed: () => undefined,
    replacingDevice: printingReporter.replacingDevice,
};

export function machineBackgroundAgentDependencies(): BackgroundAgentDependencies {
    return {
        readIdentity: readDeviceIdentity,
        findDaemon: getDaemonInfo,
        ensureDaemon: ensureDaemonRunning,
        client: (port) => new IPCClient(port, "cli"),
        verify: (token, manage) => startDeviceAgent(token, manage, {
            verifyOnly: true, reporter: verifyingReporter,
        }).done,
        sleep: (millis) => new Promise((resolve) => setTimeout(resolve, millis)),
        now: () => Date.now(),
        print: (message) => CLIPrinter.print(message),
        printSuccess: (message) => CLIPrinter.success(message),
        printWarning: (message) => CLIPrinter.warn(message),
        printError: (message) => CLIPrinter.error(message),
        daemonLogPath: getDaemonLogPath,
    };
}

export function isAgentRunning(status: DeviceAgentStatus): boolean {
    return status.state !== DeviceAgentState.Stopped;
}

/** True when the token or the server is not what device.json holds, so the target is not yet proven. */
export function differsFromStored(target: AgentTarget, stored: DeviceIdentity | null): boolean {
    if (!stored?.token) return true;
    return stored.token !== target.token || stored.server !== (target.manage || DEFAULT_SERVER);
}

/** What a newer CLI says to a daemon from before slice 17, which answers the device routes with 404. */
export function olderDaemonMessage(daemon: DaemonInfo): string {
    if (daemon.host === DaemonHost.APP) {
        return "The Pinggy app runs an older daemon. Update the Pinggy app, or quit it and run this again.";
    }
    return "The running daemon predates background devices. Run pinggy daemon stop, then retry. "
        + "This stops all running tunnels.";
}

/**
 * The daemon's agent. Null with no daemon, one on another IPC version, one from before slice 17, or one
 * that does not answer. Never starts a daemon.
 */
export async function readBackgroundAgent(dependencies: BackgroundAgentDependencies):
    Promise<BackgroundAgentReading | null> {
    const daemon = dependencies.findDaemon();
    if (!daemon || !isIpcCompatible(daemon)) {
        return null;
    }
    try {
        return { daemon, status: await dependencies.client(daemon.port).getDeviceAgentStatus() };
    } catch (err) {
        logger.debug("No background device agent to read", { error: errorMessage(err) });
        return null;
    }
}

/**
 * `connect -b` and `login -b`: the daemon runs the agent on `target`. Checks a target device.json does not
 * hold yet, then starts the daemon's agent and waits for it to connect.
 *
 * @returns the process exit code
 */
export async function startAgentInBackground(target: AgentTarget,
                                             dependencies: BackgroundAgentDependencies): Promise<number> {
    if (differsFromStored(target, dependencies.readIdentity())) {
        const verified = await dependencies.verify(target.token, target.manage);
        if (verified.error || !verified.welcomed) {
            dependencies.printError(verified.error?.message ?? "The device did not connect. Nothing changed.");
            return EXIT_FAILED;
        }
    }

    dependencies.print("Starting the device agent in the background.");
    let daemon: DaemonInfo;
    try {
        daemon = await dependencies.ensureDaemon();
    } catch (err) {
        dependencies.printError(errorMessage(err));
        return EXIT_FAILED;
    }

    const client = dependencies.client(daemon.port);
    try {
        const started = await client.startDeviceAgent();
        if (isErrorResponse(started)) {
            dependencies.printError(started.message);
            return EXIT_FAILED;
        }
    } catch (err) {
        dependencies.printError(daemonFailureMessage(err, daemon));
        return EXIT_FAILED;
    }
    return waitUntilConnected(client, daemon, dependencies);
}

/** `pinggy devices stop`. @returns the process exit code */
export async function stopAgentInBackground(dependencies: BackgroundAgentDependencies): Promise<number> {
    const reading = await readBackgroundAgent(dependencies);
    if (!reading || !isAgentRunning(reading.status)) {
        dependencies.print("No device agent is running in the background.");
        return EXIT_OK;
    }
    if (!(await stopReadAgent(reading, dependencies))) {
        return EXIT_FAILED;
    }
    dependencies.printSuccess("Stopped. The device shows offline in the dashboard.");
    return EXIT_OK;
}

/**
 * `pinggy devices remove` runs this before it deletes device.json. A running agent would keep the machine
 * online and write the file back on its next `welcome`.
 *
 * @returns true when no background agent runs any more
 */
export async function stopAgentBeforeRemove(dependencies: BackgroundAgentDependencies): Promise<boolean> {
    const reading = await readBackgroundAgent(dependencies);
    if (!reading || !isAgentRunning(reading.status)) {
        return true;
    }
    return stopReadAgent(reading, dependencies);
}

/**
 * Why a foreground `connect` or `login` must not run, or null. 2 agents on 1 credential refuse each other
 * with `already_connected`, and a `login` that adds a device would race the daemon's run for device.json.
 */
export async function foregroundRefusal(dependencies: BackgroundAgentDependencies): Promise<string | null> {
    const reading = await readBackgroundAgent(dependencies);
    if (!reading || !isAgentRunning(reading.status)) {
        return null;
    }
    const device = reading.status.deviceAgentId ? `device ${reading.status.deviceAgentId}` : "a device";
    return `This machine already runs as ${device} in the background. Stop it first: pinggy devices stop`;
}

/** The lines `pinggy devices status` adds when a daemon runs. Nothing when none does. */
export async function printBackgroundStatus(dependencies: BackgroundAgentDependencies): Promise<void> {
    const reading = await readBackgroundAgent(dependencies);
    if (!reading) {
        return;
    }
    dependencies.print(`  Background ${describeAgent(reading)}`);
    if (reading.status.lastError) {
        dependencies.print(`  Last error ${reading.status.lastError.message}`);
    }
}

/** 1 line for `pinggy daemon status`. */
export function describeAgentForDaemonStatus(status: DeviceAgentStatus): string {
    switch (status.state) {
        case DeviceAgentState.Connected:
            return `connected as ${status.deviceAgentId}`;
        case DeviceAgentState.Connecting:
            return "connecting";
        case DeviceAgentState.Reconnecting:
            return "reconnecting";
        default:
            return "not running";
    }
}

function describeAgent({ daemon, status }: BackgroundAgentReading): string {
    const host = daemon.host === DaemonHost.APP ? "inside the Pinggy app" : `in the daemon, PID ${daemon.pid}`;
    switch (status.state) {
        case DeviceAgentState.Connected:
            return `connected since ${status.connectedAt}, ${host}`;
        case DeviceAgentState.Connecting:
            return `connecting, ${host}`;
        case DeviceAgentState.Reconnecting:
            return `reconnecting, ${host}`;
        default:
            return "not running";
    }
}

async function stopReadAgent(reading: BackgroundAgentReading,
                             dependencies: BackgroundAgentDependencies): Promise<boolean> {
    try {
        await dependencies.client(reading.daemon.port).stopDeviceAgent();
        return true;
    } catch (err) {
        dependencies.printError(`Could not stop the background device agent: ${errorMessage(err)}`);
        return false;
    }
}

function daemonFailureMessage(err: unknown, daemon: DaemonInfo): string {
    if (err instanceof IPCHttpError && err.statusCode === HTTP_NOT_FOUND) {
        return olderDaemonMessage(daemon);
    }
    return `Could not reach the daemon: ${errorMessage(err)}`;
}

async function waitUntilConnected(client: DeviceAgentDaemonClient, daemon: DaemonInfo,
                                  dependencies: BackgroundAgentDependencies): Promise<number> {
    const deadline = dependencies.now() + CONNECT_WAIT_MILLIS;
    for (;;) {
        let status: DeviceAgentStatus;
        try {
            status = await client.getDeviceAgentStatus();
        } catch (err) {
            dependencies.printError(daemonFailureMessage(err, daemon));
            return EXIT_FAILED;
        }
        if (status.state === DeviceAgentState.Connected) {
            printRunning(status, daemon, dependencies);
            return EXIT_OK;
        }
        if (status.state === DeviceAgentState.Stopped) {
            dependencies.printError(status.lastError?.message ?? "The device agent stopped before it connected.");
            return EXIT_FAILED;
        }
        if (dependencies.now() >= deadline) {
            dependencies.printWarning("Still connecting in the background. Check with: pinggy devices status");
            return EXIT_OK;
        }
        await dependencies.sleep(POLL_INTERVAL_MILLIS);
    }
}

function printRunning(status: DeviceAgentStatus, daemon: DaemonInfo, dependencies: BackgroundAgentDependencies): void {
    dependencies.printSuccess(`Running in the background as device ${status.deviceAgentId}`);
    if (status.email) {
        dependencies.print(`Signed in as ${status.email}`);
    }
    if (status.deviceUrl) {
        dependencies.print("Open the device in a browser:");
        dependencies.print(`  ${status.deviceUrl}`);
    }
    if (daemon.host === DaemonHost.APP) {
        dependencies.print("It runs inside the Pinggy app, and stops when the app quits.");
    }
    dependencies.print(`Logs: ${dependencies.daemonLogPath()}`);
    dependencies.print("Stop it with: pinggy devices stop");
}
