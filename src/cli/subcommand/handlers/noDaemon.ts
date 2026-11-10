/**
 * What a command prints when no daemon runs. Commands that act on running tunnels never start a daemon:
 * a new daemon would start every auto-start tunnel.
 */
import { findConfig } from "../../configStore.js";

function startCommand(name: string): string {
    return /\s/.test(name) ? `pinggy start "${name}"` : `pinggy start ${name}`;
}

/** For `restart` and `attach`. Names the start command when a saved config matches. */
export function tunnelNotRunningMessage(nameOrId: string): string {
    const saved = findConfig(nameOrId);
    if (saved) {
        return `Tunnel "${saved.name}" is not running. Start it with: ${startCommand(saved.name)}`;
    }
    return `No tunnel matches "${nameOrId}". No tunnels are running.`;
}
