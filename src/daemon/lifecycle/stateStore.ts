/**
 * Daemon state persistence for crash recovery.
 * Writes active tunnel configs to daemon-state.json so the daemon
 * can restore tunnels after an unexpected crash.
 *
 * Behavior:
 * - On clean shutdown: state file is deleted (no recovery needed)
 * - On crash: state file remains, daemon restores detached tunnels on restart
 * - On reboot (OS service start): only autoStart configs are used (not state file)
 */
import fs from "node:fs";
import path from "node:path";
import { TunnelConfigurationV1 } from "@pinggy/pinggy";
import { getPinggyConfigDir, ensurePinggyConfigDir } from "../../utils/configDir.js";
import { logger } from "../../logger.js";
import { TunnelOrigin } from "../../tunnel_manager/TunnelManager.js";

// Types

export interface DaemonStateTunnel {
    tunnelId: string;
    configId: string;
    name: string;
    origin: TunnelOrigin;
    config: TunnelConfigurationV1;
    mode: "foreground" | "detached";
    startedAt: string;
}

export interface DaemonState {
    tunnels: DaemonStateTunnel[];
    lastUpdated: string;
}

// State Store

const STATE_FILENAME = "daemon-state.json";

function getStatePath(): string {
    return path.join(getPinggyConfigDir(), STATE_FILENAME);
}

/**
 * Load the daemon state from disk.
 * Returns null if file doesn't exist or is malformed.
 */
export function loadDaemonState(): DaemonState | null {
    const statePath = getStatePath();
    try {
        if (!fs.existsSync(statePath)) return null;
        const raw = fs.readFileSync(statePath, "utf-8");
        const state = JSON.parse(raw) as DaemonState;
        if (!Array.isArray(state.tunnels)) return null;
        return state;
    } catch {
        return null;
    }
}

/**
 * Persist the current daemon state to disk.
 * Called after every tunnel start/stop.
 */
export function persistDaemonState(state: DaemonState): void {
    ensurePinggyConfigDir();
    const statePath = getStatePath();
    const tmpPath = statePath + ".tmp";
    try {
        state.lastUpdated = new Date().toISOString();
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
        fs.renameSync(tmpPath, statePath);
    } catch (err: any) {
        logger.error("Failed to persist daemon state", { error: err.message });
    }
}

/**
 * Remove the state file (called on clean shutdown).
 */
export function clearDaemonState(): void {
    const statePath = getStatePath();
    try {
        if (fs.existsSync(statePath)) {
            fs.unlinkSync(statePath);
        }
    } catch {
        // Best effort
    }
}

/**
 * Add a tunnel to the state.
 */
export function addTunnelToState(
    state: DaemonState,
    tunnel: DaemonStateTunnel
): void {
    // Remove existing entry for same tunnelId if present
    state.tunnels = state.tunnels.filter(t => t.tunnelId !== tunnel.tunnelId);
    state.tunnels.push(tunnel);
}

/**
 * Remove a tunnel from the state.
 */
export function removeTunnelFromState(state: DaemonState, tunnelId: string): void {
    state.tunnels = state.tunnels.filter(t => t.tunnelId !== tunnelId);
}

/**
 * Check if this is a crash recovery situation.
 * True if: daemon-state.json exists (daemon didn't shut down cleanly).
 */
export function isCrashRecovery(): boolean {
    return loadDaemonState() !== null;
}
