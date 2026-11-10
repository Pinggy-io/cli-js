/**
 * Log paths for `pinggy logs` and `pinggy log path`. Asks the running daemon, which also knows its
 * running tunnels. With no daemon, reads the log files directly and starts nothing.
 */
import { TunnelClient } from "../../../daemon/tunnelClient.js";
import { ResolveLogPathResponse } from "../../../daemon/ipc/ipcRoutes.js";
import { resolveStoppedLogPath } from "../../../daemon/logPaths.js";
import { getDaemonLogPath } from "../../../utils/configDir.js";

export interface LogLookup {
    daemonLogPath(): Promise<string>;
    resolve(nameOrId: string): Promise<ResolveLogPathResponse>;
    close(): void;
}

/** Throws when the running daemon speaks another IPC version. */
export function openLogLookup(): LogLookup {
    const client = new TunnelClient();
    if (!client.connectIfRunning()) {
        return {
            daemonLogPath: async () => getDaemonLogPath(),
            resolve: async (nameOrId) => resolveStoppedLogPath(nameOrId),
            close: () => undefined,
        };
    }
    return {
        daemonLogPath: async () => (await client.getLogPaths()).daemon,
        resolve: (nameOrId) => client.resolveLogPath(nameOrId),
        close: () => client.close(),
    };
}
