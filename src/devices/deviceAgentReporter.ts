import CLIPrinter from "../utils/printer.js";
import { DeviceAgentError } from "../daemon/ipc/ipcRoutes.js";
import { Welcome } from "./device_schema.js";

/**
 * What a device agent run tells its host. The loop prints nothing itself.
 *
 * The foreground agent prints each event to the terminal. The daemon's agent (`pinggy devices connect -b`)
 * has no terminal: it logs each event and keeps the latest for `GET /device`.
 */
export interface DeviceAgentReporter {
    connecting(server: string): void;
    connected(welcome: Welcome): void;
    /** The socket dropped. The next attempt starts after `delayMillis`. */
    reconnecting(delayMillis: number, attempt: number): void;
    /** A problem the loop retries past. */
    warn(message: string): void;
    /** The dashboard refused the credential or ended the device. The run ends. */
    failed(error: DeviceAgentError): void;
    /** The token of this run is not the stored one, so this machine becomes a new device. */
    replacingDevice(oldDeviceAgentId: string): void;
}

/** Who this device connected as, and where to open it. */
export function printConnected(welcome: Welcome): void {
    CLIPrinter.success(`Connected as device ${welcome.device_agent_id}`);
    if (welcome.email) {
        CLIPrinter.print(`Signed in as ${welcome.email}`);
    }
    if (welcome.device_url) {
        CLIPrinter.print("Open the device in a browser:");
        CLIPrinter.print(`  ${welcome.device_url}`);
    }
}

function formatSeconds(millis: number): string {
    return (millis / 1000).toFixed(1);
}

/** The foreground agent's terminal output. */
export const printingReporter: DeviceAgentReporter = {
    connecting: (server) => CLIPrinter.print(`Connecting to ${server}`),
    connected: printConnected,
    reconnecting: (delayMillis, attempt) => CLIPrinter.warn(
        `Disconnected. Reconnecting in ${formatSeconds(delayMillis)} seconds (attempt ${attempt}).`),
    warn: (message) => CLIPrinter.warn(message),
    failed: (error) => CLIPrinter.error(error.message),
    replacingDevice: (oldDeviceAgentId) => CLIPrinter.print(`This machine was device ${oldDeviceAgentId}. `
        + "Connecting it with the token from the command."),
};
