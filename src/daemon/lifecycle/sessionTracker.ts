/**
 * Session Tracker for daemon tunnel ownership.
 * Tracks which tunnels are "foreground-attached" vs "detached".
 * Implements orphan cleanup: if a foreground tunnel's WS session drops,
 * waits 5 seconds then auto-kills the tunnel.
 */
import { TunnelManager } from "../tunnel_manager/TunnelManager.js";
import { logger } from "../logger.js";
import { WsSession } from "./ipcServer.js";
import { trackTunnelStop } from "./daemonChild.js";

export interface TunnelOwnership {
    tunnelId: string;
    sessionId: string;
    mode: "foreground" | "detached";
}

const GRACE_PERIOD_MS = 5000;

export class SessionTracker {
    private ownership: Map<string, TunnelOwnership> = new Map(); // tunnelId → ownership
    private graceTimers: Map<string, NodeJS.Timeout> = new Map(); // tunnelId → timer

    /**
     * Register a tunnel as owned by a session in a specific mode.
     */
    attach(tunnelId: string, sessionId: string, mode: "foreground" | "detached"): void {
        // Cancel any pending grace timer for this tunnel
        this.cancelGraceTimer(tunnelId);

        this.ownership.set(tunnelId, { tunnelId, sessionId, mode });
        logger.info(`Tunnel ${tunnelId} attached to session ${sessionId} (${mode})`);
    }

    /**
     * Mark a tunnel as detached (persists without session).
     */
    markDetached(tunnelId: string): void {
        const existing = this.ownership.get(tunnelId);
        if (existing) {
            existing.mode = "detached";
            existing.sessionId = "";
            logger.info(`Tunnel ${tunnelId} marked as detached`);
        }
    }

    /**
     * Get the ownership info for a tunnel.
     */
    getOwnership(tunnelId: string): TunnelOwnership | undefined {
        return this.ownership.get(tunnelId);
    }

    /**
     * Get all tunnels owned by a session.
     */
    getTunnelsForSession(sessionId: string): TunnelOwnership[] {
        return Array.from(this.ownership.values()).filter(o => o.sessionId === sessionId);
    }

    /**
     * Called when a WS session disconnects.
     * Starts grace timers for all foreground tunnels owned by that session.
     */
    onSessionDisconnect(session: WsSession): void {
        const sessionId = session.id;
        const tunnels = this.getTunnelsForSession(sessionId);

        for (const ownership of tunnels) {
            if (ownership.mode === "foreground") {
                logger.info(`Session ${sessionId} disconnected. Starting ${GRACE_PERIOD_MS}ms grace for tunnel ${ownership.tunnelId}`);
                this.startGraceTimer(ownership.tunnelId);
            }
            // Detached tunnels are unaffected by session disconnect
        }
    }

    /**
     * Called when a session re-attaches to a tunnel (e.g. CLI reconnects WS).
     * Cancels any pending grace timer.
     */
    onSessionReconnect(tunnelId: string, sessionId: string): void {
        this.cancelGraceTimer(tunnelId);
        const existing = this.ownership.get(tunnelId);
        if (existing) {
            existing.sessionId = sessionId;
            logger.info(`Tunnel ${tunnelId} re-attached to session ${sessionId}`);
        }
    }

    /**
     * Remove ownership tracking for a tunnel (called when tunnel stops).
     */
    removeTunnel(tunnelId: string): void {
        this.cancelGraceTimer(tunnelId);
        this.ownership.delete(tunnelId);
    }

    /**
     * Check if a tunnel is in foreground mode.
     */
    isForeground(tunnelId: string): boolean {
        const o = this.ownership.get(tunnelId);
        return o?.mode === "foreground";
    }

    private startGraceTimer(tunnelId: string): void {
        // Clear any existing timer
        this.cancelGraceTimer(tunnelId);

        const timer = setTimeout(() => {
            this.graceTimers.delete(tunnelId);
            this.killOrphanedTunnel(tunnelId);
        }, GRACE_PERIOD_MS);

        this.graceTimers.set(tunnelId, timer);
    }

    private cancelGraceTimer(tunnelId: string): void {
        const timer = this.graceTimers.get(tunnelId);
        if (timer) {
            clearTimeout(timer);
            this.graceTimers.delete(tunnelId);
        }
    }

    private killOrphanedTunnel(tunnelId: string): void {
        const ownership = this.ownership.get(tunnelId);
        if (!ownership || ownership.mode !== "foreground") {
            return; // Already detached or removed
        }

        logger.info(`Grace period expired for tunnel ${tunnelId}. Stopping orphaned foreground tunnel.`);
        try {
            const manager = TunnelManager.getInstance();
            manager.stopTunnel(tunnelId);
        } catch (err: any) {
            logger.error(`Failed to stop orphaned tunnel ${tunnelId}`, { error: err.message });
        }
        trackTunnelStop(tunnelId);
        this.ownership.delete(tunnelId);
    }

    /**
     * Cleanup all timers (for daemon shutdown).
     */
    destroy(): void {
        for (const timer of this.graceTimers.values()) {
            clearTimeout(timer);
        }
        this.graceTimers.clear();
        this.ownership.clear();
    }
}
