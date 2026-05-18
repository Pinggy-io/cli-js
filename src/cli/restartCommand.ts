/**
 * `pinggy restart <name|id>` — Restart a running tunnel.
 */
import { TunnelClient } from "../daemon/tunnelClient.js";
import { isErrorResponse } from "../types.js";
import CLIPrinter from "../utils/printer.js";
import { findTunnel } from "./startCli.js";

export async function handleRestart(args: string[]): Promise<void> {
    if (args.length === 0 || args[0].startsWith("-")) {
        CLIPrinter.error("Tunnel name or ID is required. Usage: pinggy restart <name|id>");
        process.exit(1);
    }

    const nameOrId = args[0];
    const client = new TunnelClient();

    try {
        await client.ensureDaemon();
    } catch (err: any) {
        CLIPrinter.error(`Cannot connect to daemon: ${err.message}`);
        return;
    }

    try {
        const tunnels = await client.handleListV2();
        if (isErrorResponse(tunnels)) {
            CLIPrinter.error(`Failed to list tunnels: ${tunnels.message}`);
            return;
        }

        const match = findTunnel(tunnels, nameOrId);
        if (!match) {
            CLIPrinter.error(`No running tunnel matching "${nameOrId}". Use: pinggy ps`);
            process.exit(1);
        }

        const result = await client.handleRestart(match.tunnelid);
        if (isErrorResponse(result)) {
            CLIPrinter.error(`Failed to restart tunnel: ${result.message}`);
            return;
        }

        const name = (match.tunnelconfig as any)?.name || (match.tunnelconfig as any)?.configname || match.tunnelid.slice(0, 12);
        CLIPrinter.success(`Tunnel "${name}" is restarting.`);
    } catch (err: any) {
        CLIPrinter.error(`Failed to restart tunnel: ${err.message}`);
    } finally {
        client.close();
    }
}
