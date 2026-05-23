/**
 * DaemonHealth: monitors liveness of the daemon process and decides when
 * to declare it lost. Two signals drive it:
 *
 *   1. WS abnormal close → triggers a short reconnect loop (3 × 1s).
 *      During the loop we verify daemon.json still points to the same PID
 *      we connected to; a PID change means the daemon was respawned and
 *      the previous session is unrecoverable.
 *   2. Heartbeat ping every 5s → after 2 consecutive failures the daemon
 *      is treated as hung; no reconnect (it won't help).
 *
 * Subscriptions are owned by WsStream. DaemonHealth asks it to snapshot
 * and restore them across a successful reconnect.
 */
import { IPCClient } from "./ipc/ipcClient.js";
import { getDaemonInfo } from "./lifecycle/daemonManager.js";
import { logger } from "../logger.js";
import { WsStream, WS_NORMAL_CLOSE } from "./ws/wsStream.js";

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 2000;
const HEARTBEAT_FAILURE_THRESHOLD = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type DaemonLostReason = "dead" | "respawned" | "hung" | "heartbeat";
export type DaemonLostCallback = (reason: DaemonLostReason, detail?: string) => void;
export type DaemonReconnectingCallback = (attempt: number, max: number) => void;
export type DaemonReconnectedCallback = () => void;

export class DaemonHealth {
    private originalPid: number | null = null;
    private lost = false;
    private reconnecting = false;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private lostCallbacks: DaemonLostCallback[] = [];
    private reconnectingCallbacks: DaemonReconnectingCallback[] = [];
    private reconnectedCallbacks: DaemonReconnectedCallback[] = [];

    constructor(
        private getIpc: () => IPCClient | null,
        private stream: WsStream,
    ) {
        // React to WS lifecycle: heartbeat tracks the open socket; an abnormal
        // close kicks off the reconnect loop (if there's anything to recover).
        this.stream.onOpen(() => this.startHeartbeat());
        this.stream.onClose((code) => {
            this.stopHeartbeat();
            if (code === WS_NORMAL_CLOSE) return;
            if (this.lost || this.reconnecting) return;
            if (!this.stream.hasSubscriptions()) return;
            this.reconnecting = true;
            this.attemptReconnect()
                .catch((err) => logger.debug("Reconnect loop threw", { error: err?.message }))
                .finally(() => { this.reconnecting = false; });
        });
    }

    bindPid(pid: number): void {
        this.originalPid = pid; 
    }

    isLost(): boolean {
        return this.lost; 
    }

    onLost(cb: DaemonLostCallback): void { this.lostCallbacks.push(cb); }
    onReconnecting(cb: DaemonReconnectingCallback): void { this.reconnectingCallbacks.push(cb); }
    onReconnected(cb: DaemonReconnectedCallback): void { this.reconnectedCallbacks.push(cb); }

    startHeartbeat(): void {
        this.stopHeartbeat();
        let consecutiveFailures = 0;
        this.heartbeatTimer = setInterval(async () => {
            if (this.lost || this.reconnecting) return;
            const ipc = this.getIpc();
            if (!ipc) return;
            try {
                await ipc.ping(HEARTBEAT_TIMEOUT_MS);
                consecutiveFailures = 0;
            } catch (err: any) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
                    this.triggerLost("heartbeat", err?.message);
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private async attemptReconnect(): Promise<void> {
        const snapshot = this.stream.snapshotSubscriptions();

        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
            for (const cb of this.reconnectingCallbacks) {
                try { cb(attempt, RECONNECT_ATTEMPTS); } catch { /* consumer errors must not break loop */ }
            }
            await sleep(RECONNECT_INTERVAL_MS);
            if (this.lost) return;

            const info = getDaemonInfo();
            if (!info) {
                this.triggerLost("dead");
                return;
            }
            if (info.pid !== this.originalPid) {
                this.triggerLost("respawned", `was pid ${this.originalPid}, now pid ${info.pid}`);
                return;
            }
            try {
                const ipc = this.getIpc();
                if (!ipc) throw new Error("IPC client missing");
                await ipc.ping(HEARTBEAT_TIMEOUT_MS);
                await this.stream.restoreSubscriptions(snapshot);
                for (const cb of this.reconnectedCallbacks) {
                    try { cb(); } catch { /* ignore */ }
                }
                return;
            } catch (err: any) {
                logger.debug("Reconnect attempt failed", { attempt, error: err?.message });
            }
        }
        this.triggerLost("hung");
    }

    private triggerLost(reason: DaemonLostReason, detail?: string): void {
        if (this.lost) return;
        this.lost = true;
        this.stopHeartbeat();
        this.stream.terminate();
        for (const cb of this.lostCallbacks) {
            try { cb(reason, detail); } catch (err: any) {
                logger.debug("daemon-lost callback threw", { error: err?.message });
            }
        }
    }
}
