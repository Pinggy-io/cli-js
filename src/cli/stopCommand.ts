/**
 * `pinggy stop <name|id>` — Stop a tunnel running in the daemon.
 */
import { TunnelClient } from "../daemon/tunnelClient.js";
import { isErrorResponse } from "../types.js";
import CLIPrinter from "../utils/printer.js";
import { findTunnel } from "./startCli.js";

export async function handleStop(args: string[]): Promise<void> {
    if (args.length === 0) {
        CLIPrinter.error("Usage: pinggy stop <name|id>");
        return;
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
        // First, list tunnels to resolve name/short-id to full tunnel ID
        const tunnels = await client.handleListV2();

        if (isErrorResponse(tunnels)) {
            CLIPrinter.error(`Failed to list tunnels: ${tunnels.message}`);
            return;
        }

        const match = findTunnel(tunnels, nameOrId);
        if (!match) {
            CLIPrinter.error(`No running tunnel found matching "${nameOrId}". Use: pinggy ps`);
            return;
        }

        const result = await client.handleStop(match.tunnelid);

        if (isErrorResponse(result)) {
            CLIPrinter.error(`Failed to stop tunnel: ${result.message}`);
        } else {
            const name = (match.tunnelconfig as any)?.name || (match.tunnelconfig as any)?.configname || match.tunnelid.slice(0, 12);
            CLIPrinter.success(`Tunnel "${name}" stopped.`);
        }
    } catch (err: any) {
        CLIPrinter.error(`Failed to stop tunnel: ${err.message}`);
    } finally {
        client.close();
    }
}

