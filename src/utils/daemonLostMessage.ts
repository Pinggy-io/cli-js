import { DaemonLostReason } from "../daemon/tunnelClient.js";

export function daemonLostMessage(reason: DaemonLostReason, detail?: string): string {
    switch (reason) {
        case "dead":      return "Daemon process is no longer running. Tunnel stopped.";
        case "respawned": return `Daemon was restarted${detail ? ` (${detail})` : ""}. The previous session is gone.`;
        case "hung":      return "Daemon stopped responding after retries. Tunnel stopped.";
        case "heartbeat": return "Daemon stopped responding to health checks. Tunnel stopped.";
    }
}