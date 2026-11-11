/** The lines the explicit command and the background update share. */
import { DaemonHost } from "../daemon/ipc/ipcRoutes.js";

/** A release with another IPC version would break every daemon command until the daemon restarts. */
export function daemonRestartLine(version: string, host: DaemonHost | undefined): string {
    const firstSentence = `pinggy ${version} needs a daemon restart.`;
    if (host === DaemonHost.APP) return `${firstSentence} Update the Pinggy app, then run "pinggy update".`;
    return `${firstSentence} Run "pinggy daemon stop", then "pinggy update". This stops all running tunnels.`;
}
