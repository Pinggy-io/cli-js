/**
 * Log paths for `pinggy logs` and `pinggy log path`. Asks the running daemon, which also knows its
 * running tunnels. With no daemon, reads the log files directly and starts nothing.
 */
import { TunnelClient } from "../../../daemon/tunnelClient.js";
import { ResolveLogPathResponse } from "../../../daemon/ipc/ipcRoutes.js";
import { resolveStoppedLogPath } from "../../../daemon/logPaths.js";
import { getDaemonLogPath, getLibpinggyLogPath } from "../../../utils/configDir.js";

/** `pinggy logs libpinggy` selects the native library's log, the one file all tunnels share. */
export const LIBPINGGY_LOG_NAME = "libpinggy";

export type LogLookupResult = ResolveLogPathResponse | { status: "libpinggy"; path: string };

export interface LogLookup {
    daemonLogPath(): Promise<string>;
    resolve(nameOrId: string): Promise<LogLookupResult>;
    close(): void;
}

/** A tunnel or a saved config called "libpinggy" keeps its own log. Otherwise the name means the library's. */
function orLibpinggyLog(nameOrId: string, result: ResolveLogPathResponse): LogLookupResult {
    if (nameOrId === LIBPINGGY_LOG_NAME && result.status === "not-found") {
        return { status: "libpinggy", path: getLibpinggyLogPath() };
    }
    return result;
}

/** Throws when the running daemon speaks another IPC version. */
export function openLogLookup(): LogLookup {
    const client = new TunnelClient();
    if (!client.connectIfRunning()) {
        return {
            daemonLogPath: () => Promise.resolve(getDaemonLogPath()),
            resolve: (nameOrId) => Promise.resolve(orLibpinggyLog(nameOrId, resolveStoppedLogPath(nameOrId))),
            close: () => undefined,
        };
    }
    return {
        daemonLogPath: async () => (await client.getLogPaths()).daemon,
        resolve: async (nameOrId) => orLibpinggyLog(nameOrId, await client.resolveLogPath(nameOrId)),
        close: () => client.close(),
    };
}
