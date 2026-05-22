/**
 * `pinggy stop <name|id> [<name|id> ...]` — Stop one or more tunnels.
 *
 */
import { TunnelClient } from "../daemon/tunnelClient.js";
import { isErrorResponse } from "../types.js";
import { TunnelResponseV2 } from "../remote_management/handler.js";
import CLIPrinter from "../utils/printer.js";
import { findTunnel } from "./startCli.js";

export async function handleStop(args: string[]): Promise<void> {
    if (args.length === 0) {
        CLIPrinter.error("Usage: pinggy stop <name|id> [<name|id> ...]");
        return;
    }

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

        const targets = resolveTargets(tunnels, args);

        if (targets.matched.length === 0) {
            CLIPrinter.error(`No tunnel found matching: ${args.join(", ")}. Use: pinggy ps`);
            return;
        }

        for (const { input, tunnel } of targets.matched) {
            const result = await client.handleStop(tunnel.tunnelid);
            if (isErrorResponse(result)) {
                CLIPrinter.error(`Failed to stop "${input}": ${result.message}`);
                continue;
            }
            const name =
                (tunnel.tunnelconfig as any)?.name ||
                (tunnel.tunnelconfig as any)?.configname ||
                tunnel.tunnelid.slice(0, 12);
            CLIPrinter.success(`Tunnel "${name}" stopped.`);
        }

        for (const m of targets.missing) {
            CLIPrinter.warn(`No tunnel found matching "${m}".`);
        }
    } catch (err: any) {
        CLIPrinter.error(`Failed to stop tunnel: ${err.message}`);
    } finally {
        client.close();
    }
}

interface ResolvedTargets {
    matched: { input: string; tunnel: TunnelResponseV2 }[];
    missing: string[];
}

function resolveTargets(tunnels: TunnelResponseV2[], args: string[]): ResolvedTargets {
    // If args could form a single name with spaces (e.g. `stop tls tunnel`
    if (args.length > 1) {
        const input = args.join(" ");
        const tunnel = findTunnel(tunnels, input);
        if (tunnel) return { matched: [{ input, tunnel }], missing: [] };
    }

    const matched: { input: string; tunnel: TunnelResponseV2 }[] = [];
    const missing: string[] = [];
    for (const input of args) {
        const tunnel = findTunnel(tunnels, input);
        if (tunnel) matched.push({ input, tunnel });
        else missing.push(input);
    }
  return { matched, missing };
}

