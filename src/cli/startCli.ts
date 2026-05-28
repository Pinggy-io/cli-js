import CLIPrinter from "../utils/printer.js";
import { ErrorCode, FinalConfig, isErrorResponse } from "../types.js";
import { getFreePort } from "../utils/getFreePort.js";
import pico from "picocolors";
import { TunnelClient, DaemonLostReason } from "../daemon/tunnelClient.js";
import { SessionMode } from "../daemon/ipc/ipcRoutes.js";
import { SavedTunnelConfig } from "./configStore.js";
import { buildFinalConfig } from "./buildConfig.js";
import { parseCliArgs } from "../utils/parseArgs.js";
import { cliOptions } from "./options.js";
import { TunnelResponseV2 } from "../remote_management/handler.js";
import { daemonLostMessage } from "../utils/daemonLostMessage.js";

type CliValues = ReturnType<typeof parseCliArgs<typeof cliOptions>>["values"];

// Exit code 3 is reserved for "daemon connection lost" so supervisors and
// scripts can distinguish it from normal failures (1) or user-initiated exit (0).
const EXIT_DAEMON_LOST = 3;


interface DaemonLostHandlers {
    onReconnecting: (attempt: number, max: number) => void;
    onReconnected: () => void;
    onLost: (reason: DaemonLostReason, detail?: string) => void;
}

/**
 * Wire daemon-loss callbacks on the client. Caller provides UI-specific
 * handlers (TUI modal updates, plain-stdout messages, etc).
 */
function wireDaemonLost(client: TunnelClient, handlers: DaemonLostHandlers): void {
    client.onDaemonReconnecting(handlers.onReconnecting);
    client.onDaemonReconnected(handlers.onReconnected);
    client.onDaemonLost((reason, detail) => {
        handlers.onLost(reason, detail);
        CLIPrinter.error(daemonLostMessage(reason, detail));
        // TODO: print pinggy restart <tunnel_name> if it was a saved tunnel
        setImmediate(() => process.exit(EXIT_DAEMON_LOST));
    });
}


function installShutdownHandlers(handler: () => void | Promise<void>): void {
    let fired = false;
    const wrapped = () => {
        if (fired) return;
        fired = true;
        void handler();
    };
    process.on("SIGINT", wrapped);
    process.on("SIGTERM", wrapped);
    process.on("SIGHUP", wrapped);
}

async function initTunnelClient(): Promise<TunnelClient> {
    const client = new TunnelClient();
    CLIPrinter.startSpinner("Initializing...");
    try {
        await client.ensureDaemon();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        CLIPrinter.stopSpinnerFail(`Failed to start daemon: ${msg}`);
        process.exit(1);
    }
    CLIPrinter.stopSpinnerSuccess("Initialized");
    return client;
}

function printRemoteUrls(urls?: string[]): void {
    for (const url of urls || []) {
        CLIPrinter.print("  " + pico.magentaBright(url));
    }
}

async function printAlreadyRunning(
    client: TunnelClient,
    configId: string | undefined,
    label?: string,
): Promise<TunnelResponseV2 | null> {
    const prefix = label ? `"${label}" ` : "";
    const list = await client.handleListV2();
    if (isErrorResponse(list)) {
        CLIPrinter.warn(`${prefix}is already running, but could not fetch its state: ${list.message}`);
        return null;
    }
    const tunnel = configId ? list.find(t => t.tunnelconfig?.configId === configId) : undefined;
    if (!tunnel) {
        CLIPrinter.warn(`${prefix}is already running, but it is no longer in the tunnel list.`);
        return null;
    }
    const shortId = tunnel.tunnelid.slice(0, 8);
    const name = tunnel.tunnelconfig?.name || label || shortId;
    CLIPrinter.info(pico.cyanBright(`Tunnel "${name}" is already running.`));
    CLIPrinter.print(pico.gray("───────────────────────────────"));
    CLIPrinter.print(`  ID:     ${pico.bold(shortId)}`);
    CLIPrinter.print(`  Status: ${tunnel.status?.state || "unknown"}`);
    if (tunnel.remoteurls?.length) {
        CLIPrinter.print("  URLs:");
        printRemoteUrls(tunnel.remoteurls);
    }
    CLIPrinter.print(pico.gray("───────────────────────────────"));
    CLIPrinter.print(pico.gray(`Use 'pinggy attach ${name}' to view live output, or 'pinggy stop ${name}' to stop it.`));
    return tunnel;
}

async function startTunnel(
    client: TunnelClient,
    config: FinalConfig,
    opts: { label?: string; onError: "fatal"; mode: SessionMode },
): Promise<TunnelResponseV2>;
async function startTunnel(
    client: TunnelClient,
    config: FinalConfig,
    opts: { label?: string; onError: "continue"; mode: SessionMode },
): Promise<TunnelResponseV2 | null>;
async function startTunnel(
    client: TunnelClient,
    config: FinalConfig,
    opts: { label?: string; onError: "fatal" | "continue"; mode: SessionMode },
): Promise<TunnelResponseV2 | null> {
    const result = await client.handleStartV2(config, false, opts.mode);
    const prefix = opts.label ? `[${opts.label}] ` : "";

    const fail = (reason: string): null => {
        const msg = `${prefix}Failed to start tunnel: ${reason}`;
        if (opts.onError === "fatal") {
            CLIPrinter.error(msg);
            client.close();
            process.exit(1);
        }
        CLIPrinter.error(msg);
        return null;
    };

    if (isErrorResponse(result)) {
        if (result.code === ErrorCode.TunnelAlreadyRunningError) {
            await printAlreadyRunning(client, config.configId, opts.label);
            return null;
        }
        return fail(result.message);
    }

    // Tunnel may "start" but a fatal SDK-side error (e.g. polling) surfaced via status.lastError.
    const lastError = (result as TunnelResponseV2).status?.lastError;
    if (lastError?.isFatal) {
        return fail(lastError.message);
    }

    return result as TunnelResponseV2;
}

async function waitForShutdownAndStopAll(client: TunnelClient, ids: string[]): Promise<void> {
    client.onDisconnect((id, error) => {
        CLIPrinter.warn(`[${id.slice(0, 8)}] Disconnected: ${error}`);
    });
    client.onReconnected((id, newUrls) => {
        CLIPrinter.success(`[${id.slice(0, 8)}] Reconnected: ${newUrls.join(", ")}`);
    });
    client.onReconnecting((id, retryCnt) => {
        CLIPrinter.print(pico.gray(`[${id.slice(0, 8)}] Reconnecting (attempt #${retryCnt})...`));
    });
    client.onReconnectionFailed((id, retryCnt) => {
        CLIPrinter.error(`[${id.slice(0, 8)}] Reconnection failed after ${retryCnt} attempts`);
    });

    wireDaemonLost(client, {
        onReconnecting: (attempt, max) => CLIPrinter.warn(`Daemon connection dropped — reconnecting (${attempt}/${max})...`),
        onReconnected: () => CLIPrinter.success("Daemon reconnected."),
        onLost: () => { /* shared printer + exit handled by wireDaemonLost */ },
    });

    await new Promise<void>((resolve) => {
        installShutdownHandlers(async () => {
            CLIPrinter.print("\nStopping all tunnels...");
            if (!client.isDaemonLost()) {
                for (const id of ids) {
                    try { await client.handleStop(id); } catch { /* daemon may have died mid-shutdown */ }
                }
            }
            client.close();
            resolve();
        });
    });
}

// Tunnel lookup

/**
 * Resolve a tunnel by name, ID, short ID prefix, or configId.
 * Priority: exact tunnelid > tunnelid prefix > name > configId.
 */
export function findTunnel(tunnels: TunnelResponseV2[], nameOrId: string): TunnelResponseV2 | null {
    let byShortId: TunnelResponseV2 | undefined;
    let byName: TunnelResponseV2 | undefined;
    let byConfigId: TunnelResponseV2 | undefined;

    for (const t of tunnels) {
        if (t.tunnelid === nameOrId) return t;
        if (!byShortId && t.tunnelid.startsWith(nameOrId)) byShortId = t;
        if (!byName && t.tunnelconfig?.name === nameOrId) byName = t;
        if (!byConfigId && t.tunnelconfig?.configId === nameOrId) byConfigId = t;
    }

    return byShortId ?? byName ?? byConfigId ?? null;
}

// Shared TUI / non-TUI event wiring

export interface ConnectTuiOptions {
    client: TunnelClient;
    tunnelId: string;
    urls: string[];
    greet: string;
    tunnelConfig: FinalConfig;
    /** Called when TUI exits or Ctrl+C in non-TUI mode */
    onExit: () => Promise<void>;
    /** Called on SIGINT in non-TUI mode (before onExit). Defaults to "Stopping tunnel..." */
    exitMessage?: string;
    /** If true, skip TUI even if TTY is available */
    noTui?: boolean;
}

/**
 * Wire TUI (or non-TUI fallback) to a TunnelClient's event stream.
 * Shared between foreground start and attach commands.
 */
export async function connectTui(opts: ConnectTuiOptions): Promise<void> {
    const { client, tunnelId, urls, greet, tunnelConfig, onExit, noTui } = opts;
    const exitMessage = opts.exitMessage || "Stopping tunnel...";

    if (!noTui && process.stdin.isTTY) {
        try {
            const { TunnelTui } = await import("../tui/blessed/TunnelTui.js");

            const tui = new TunnelTui({
                urls,
                greet,
                tunnelConfig,
                // Skip the user-provided onStop if the daemon is already gone:
                onStop: async () => {
                    if (client.isDaemonLost()) return;
                    await onExit();
                },
            });

            client.onStats((id, stats) => {
                if (id === tunnelId) tui.updateStats(stats);
            });

            client.onDisconnect((id, error, messages) => {
                if (id === tunnelId) tui.showDisconnectModal(error, messages);
            });

            client.onReconnecting((id, retryCnt) => {
                if (id === tunnelId) tui.updateReconnectingInfo(retryCnt);
            });

            client.onReconnected((id, newUrls) => {
                if (id === tunnelId) {
                    tui.closeReconnectingInfo();
                    tui.updateUrls(newUrls);
                }
            });

            client.onReconnectionFailed((id, retryCnt) => {
                if (id === tunnelId) tui.updateReconnectionFailed(retryCnt);
            });

            client.onStopped((id) => {
                if (id === tunnelId) tui.stop();
            });

            wireDaemonLost(client, {
                onReconnecting: (attempt, max) => tui.updateReconnectingInfo(attempt, `Daemon disconnected — reconnecting (${attempt}/${max})...`),
                onReconnected: () => tui.closeReconnectingInfo(),
                onLost: () => tui.stop(),
            });

            tui.start();
            await tui.waitUntilExit();
            // Tunnel stop is handled inside tui.destroy() via onStop, so no
            // explicit onExit() call here
        } catch {
            // TUI unavailable, fall through to non-TUI path
        }
    } else {
        client.onStats((id, stats) => {
            if (id === tunnelId) {
                process.stdout.write(`\r${pico.gray(`Connections: ${stats.numTotalConnections} | Bytes: ${stats.numTotalTxBytes}`)}`);
            }
        });

        client.onDisconnect((id, error) => {
            if (id === tunnelId) CLIPrinter.warn(`Disconnected: ${error}`);
        });

        client.onReconnected((id, newUrls) => {
            if (id === tunnelId) CLIPrinter.success(`Reconnected: ${newUrls.join(", ")}`);
        });

        client.onStopped((id) => {
            if (id === tunnelId) {
                CLIPrinter.print("\nTunnel stopped.");
                process.exit(0);
            }
        });

        wireDaemonLost(client, {
            onReconnecting: (attempt, max) => CLIPrinter.warn(`\nDaemon connection dropped — reconnecting (${attempt}/${max})...`),
            onReconnected: () => CLIPrinter.success("Daemon reconnected."),
            onLost: () => { /* shared printer + exit handled by wireDaemonLost */ },
        });

        await new Promise<void>((resolve) => {
            installShutdownHandlers(async () => {
                CLIPrinter.print(`\n${exitMessage}`);
                if (!client.isDaemonLost()) {
                    try { await onExit(); } catch { /* daemon may be dead */ }
                }
                client.close();
                resolve();
            });
        });
    }
}

// Single foreground tunnel

export async function startForegroundViaDaemon(finalConfig: FinalConfig): Promise<void> {
    if (!finalConfig.optional?.noTui && finalConfig.webDebugger === "") {
        const freePort = await getFreePort(finalConfig.webDebugger || "");
        finalConfig.webDebugger = `localhost:${freePort}`;
    }

    const client = await initTunnelClient();

    CLIPrinter.startSpinner("Submitting tunnel to daemon...");
    const pending = await client.handleStartV2(finalConfig, true, SessionMode.Foreground);

    if (isErrorResponse(pending)) {
        if (pending.code === ErrorCode.TunnelAlreadyRunningError) {
            CLIPrinter.stopSpinnerSuccess("Already running");
            await printAlreadyRunning(client, finalConfig.configId, finalConfig.name);
            client.close();
            process.exit(0);
        }
        CLIPrinter.stopSpinnerFail("Failed to start");
        CLIPrinter.error(`Failed to start tunnel: ${pending.message}`);
        client.close();
        process.exit(1);
    }

    const tunnelId = pending.tunnelid;
    CLIPrinter.startSpinner(`Tunnel ${tunnelId.slice(0, 8)} created — ${pending.status?.state || "starting"}...`);

    await client.attach(tunnelId, "foreground");
    CLIPrinter.startSpinner(`Tunnel ${tunnelId.slice(0, 8)} — waiting for connection...`);

    const outcome = await waitForTunnelLive(client, tunnelId);
    if ("error" in outcome) {
        CLIPrinter.stopSpinnerFail("Failed to connect");
        CLIPrinter.error(`Failed to start tunnel: ${outcome.error}`);
        client.close();
        process.exit(1);
    }

    CLIPrinter.stopSpinnerSuccess(" Connected to Pinggy");

    const tunnel = await fetchTunnelV2(client, tunnelId);
    const urls: string[] = outcome.urls.length ? outcome.urls : (tunnel?.remoteurls || []);
    const greetmsg = tunnel?.greetmsg || "";

    CLIPrinter.success(pico.bold("Tunnel established!"));
    CLIPrinter.print(pico.gray("───────────────────────────────"));
    CLIPrinter.info(pico.cyanBright("Remote URLs:"));
    printRemoteUrls(urls);
    CLIPrinter.print(pico.gray("───────────────────────────────"));

    if (greetmsg.includes("not authenticated")) {
        CLIPrinter.warn(pico.yellowBright(greetmsg));
    } else if (greetmsg.includes("authenticated as")) {
        const emailMatch = /authenticated as (.+)/.exec(greetmsg);
        if (emailMatch) {
            CLIPrinter.info(pico.cyanBright("Authenticated as: " + emailMatch[1]));
        }
    }

    CLIPrinter.print(pico.gray("───────────────────────────────"));
    CLIPrinter.print(pico.gray("\nPress Ctrl+C to stop the tunnel.\n"));

    await connectTui({
        client,
        tunnelId,
        urls,
        greet: greetmsg,
        tunnelConfig: finalConfig,
        noTui: !!finalConfig.optional?.noTui,
        onExit: async () => {
            await client.handleStop(tunnelId);
        },
    });

    client.close();
}

/**
 * Resolve when the tunnel reports URLs (live) or surfaces a fatal error.
 */
async function waitForTunnelLive(
    client: TunnelClient,
    tunnelId: string,
): Promise<{ urls: string[] } | { error: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (val: { urls: string[] } | { error: string }) => {
            if (settled) return;
            settled = true;
            resolve(val);
        };

        client.onUrlReady((id, urls) => { if (id === tunnelId) done({ urls }); });
        client.onError((id, message, isFatal) => { if (id === tunnelId && isFatal) done({ error: message }); });
        client.onDisconnect((id, error) => { if (id === tunnelId) done({ error }); });

        // Race guard: if startTunnel() finished before our subscribe registered,
        // the url_ready event already fired. Catch up via a one-shot fetch.
        client.handleListV2().then((res) => {
            if (settled || isErrorResponse(res)) return;
            const t = res.find((x) => x.tunnelid === tunnelId);
            if (t?.remoteurls?.length) done({ urls: t.remoteurls });
            if (t?.status?.lastError?.isFatal) done({ error: t.status.lastError.message });
        }).catch(() => { /* ignore — events will resolve */ });
    });
}

async function fetchTunnelV2(client: TunnelClient, tunnelId: string): Promise<TunnelResponseV2 | null> {
    const res = await client.handleListV2();
    if (isErrorResponse(res)) return null;
    return res.find((t) => t.tunnelid === tunnelId) || null;
}

// Single background tunnel

export async function startBackgroundViaDaemon(finalConfig: FinalConfig): Promise<void> {
    const client = await initTunnelClient();

    CLIPrinter.info("Starting tunnel...");
    const result = await startTunnel(client, finalConfig, { onError: "fatal", mode: SessionMode.Detached });

    const tunnelId = result.tunnelid;
    CLIPrinter.success(`Tunnel started (ID: ${tunnelId})`);
    printRemoteUrls(result.remoteurls);
    CLIPrinter.print(pico.gray("\nTunnel running in background. Use 'pinggy ps' to list, 'pinggy stop " + tunnelId.slice(0, 8) + "' to stop."));
    client.close();
}

// Multiple foreground tunnels

export async function startMultipleForegroundViaDaemon(
    configs: SavedTunnelConfig[],
    values: CliValues,
    positionals: string[]
): Promise<void> {
    const client = await initTunnelClient();
    const startedIds: string[] = [];

    CLIPrinter.print(pico.cyanBright(`Starting ${configs.length} tunnel(s)...`));
    for (const saved of configs) {
        const config = { ...saved.tunnelConfig, configId: saved.configId, name: saved.name };
        const result = await startTunnel(client, config, { label: saved.name, onError: "continue", mode: SessionMode.Foreground });
        if (!result) continue;

        startedIds.push(result.tunnelid);
        CLIPrinter.success(`"${saved.name}" started`);
        printRemoteUrls(result.remoteurls);
    }

    if (startedIds.length === 0) {
        CLIPrinter.error("No tunnels started.");
        client.close();
        return;
    }

    for (const id of startedIds) {
        await client.attach(id, "foreground");
    }

    CLIPrinter.print(pico.gray("\nAll tunnels launched. Press Ctrl+C to stop.\n"));
    await waitForShutdownAndStopAll(client, startedIds);
}

// Background tunnels 

export async function startBackgroundTunnels(
    configs: SavedTunnelConfig[],
    values: CliValues,
    positionals: string[]
): Promise<void> {
    const client = await initTunnelClient();

    const buildConfig = configs.length === 1
        ? (saved: SavedTunnelConfig) => buildFinalConfig(values, positionals, saved.tunnelConfig)
        :  (saved: SavedTunnelConfig) =>
            ({ ...saved.tunnelConfig, configId: saved.configId, name: saved.name } as FinalConfig);

    for (const saved of configs) {
        const finalConfig = buildConfig(saved);

        const result = await startTunnel(client, finalConfig, { label: saved.name, onError: "continue", mode: SessionMode.Detached });
        if (!result) continue;

        CLIPrinter.success(`"${saved.name}" started (ID: ${result.tunnelid})`);
        printRemoteUrls(result.remoteurls);
    }

    CLIPrinter.print(pico.gray("\nTunnel(s) running in background. Use 'pinggy ps' to list, 'pinggy stop <name|id>' to stop."));
    client.close();
}

// Auto-start tunnels 

export async function startAutoStartTunnels(): Promise<void> {
    const { getAutoStartConfigs } = await import("./configStore.js");
    const configs = getAutoStartConfigs();
    if (configs.length === 0) {
        CLIPrinter.warn("No configs marked for auto-start. Use: pinggy config auto <name>");
        return;
    }

    const client = await initTunnelClient();
    const startedIds: string[] = [];

    CLIPrinter.print(pico.cyanBright(`Starting ${configs.length} auto-start tunnel(s)...`));
    for (const saved of configs) {
        const config = { ...saved.tunnelConfig, configId: saved.configId, name: saved.name };
        const result = await startTunnel(client, config, { label: saved.name, onError: "continue", mode: SessionMode.Foreground });
        if (!result) continue;

        startedIds.push(result.tunnelid);
        CLIPrinter.success(`"${saved.name}" started`);
        printRemoteUrls(result.remoteurls);
    }

    if (startedIds.length === 0) {
        CLIPrinter.error("No tunnels started.");
        client.close();
        return;
    }

    for (const id of startedIds) {
        await client.attach(id, "foreground");
    }

    CLIPrinter.print(pico.gray("\nAll auto-start tunnels launched. Press Ctrl+C to stop.\n"));
    await waitForShutdownAndStopAll(client, startedIds);
}
