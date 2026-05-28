/**
 * `pinggy ps` — List all running tunnels in the daemon.
 */
import { TunnelConfigurationV1 } from "@pinggy/pinggy";
import { TunnelClient } from "../../../daemon/tunnelClient.js";
import { isErrorResponse } from "../../../types.js";
import CLIPrinter from "../../../utils/printer.js";
import { errorMessage, getLocalAddress } from "../../../utils/util.js";
import pico from "picocolors";

export async function handlePs(): Promise<void> {
    const client = new TunnelClient();

    try {
        await client.ensureDaemon();
    } catch (err) {
        CLIPrinter.error(`Cannot connect to daemon: ${errorMessage(err)}`);
        return;
    }

    try {
        const tunnels = await client.handleListV2();

        if (isErrorResponse(tunnels)) {
            CLIPrinter.error(`Failed to list tunnels: ${tunnels.message}`);
            return;
        }

        if (tunnels.length === 0) {
            CLIPrinter.print("No tunnels running.");
            return;
        }

        // Print table header
        const header = `${pad("ID", 14)} ${pad("NAME", 16)} ${pad("STATUS", 10)} ${pad("LOCAL", 20)} URL`;
        CLIPrinter.print(pico.gray(header));
        CLIPrinter.print(pico.gray("─".repeat(90)));

        for (const t of tunnels) {
            const id = t.tunnelid.slice(0, 12);
            const name = (t.tunnelconfig as TunnelConfigurationV1)?.name || "-";
            const status = t.status.state;
            const local = getLocalAddress(t.tunnelconfig);
            const url = t.remoteurls?.[0] || "-";

            const statusColor = status === "running" ? pico.green : status === "starting" ? pico.yellow : pico.red;

            CLIPrinter.print(
                `${pico.cyan(pad(id, 14))} ${pad(name, 16)} ${statusColor(pad(status, 10))} ${pad(local, 20)} ${pico.magentaBright(url)}`
            );
        }
    } catch (err) {
        CLIPrinter.error(`Failed to list tunnels: ${errorMessage(err)}`);
    } finally {
        client.close();
    }
}

function pad(str: string, len: number): string {
    return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}
