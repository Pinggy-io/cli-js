/**
 * libpinggy writes its log lines to one file for the whole process, whichever tunnel they belong
 * to. This process points it at libpinggy.log once, from the main thread, and tunnel workers never
 * set a path: a worker that did would take the output of every other tunnel.
 */
import { Pinggy } from "@pinggy/pinggy";
import { logger } from "../logger.js";
import { ensureLibpinggyLogDir, getLibpinggyLogPath } from "../utils/configDir.js";
import { maybeRotate } from "./rotateLog.js";

export interface NativeLogAddon {
    setLogPath(path: string): void;
    setLogEnable(enable: boolean): void;
}

let pathSet = false;
let warned = false;

/** The SDK keeps the addon it loaded on the main thread in a private static. */
function sdkAddon(): NativeLogAddon | undefined {
    return (Pinggy as unknown as { addon?: NativeLogAddon }).addon;
}

/**
 * Turn libpinggy logging on or off for every tunnel in this process. The file is opened the first
 * time logging is turned on, so nothing is created while it stays off.
 */
export function setNativeLogging(enabled: boolean, addon: NativeLogAddon | undefined = sdkAddon()): void {
    if (!addon) {
        if (!warned) {
            warned = true;
            logger.warn("libpinggy logging unavailable: the SDK does not expose its native addon");
        }
        return;
    }
    try {
        if (enabled && !pathSet) {
            ensureLibpinggyLogDir();
            const logPath = getLibpinggyLogPath();
            // libpinggy keeps the file open from here on, so this is the one moment to rotate it.
            maybeRotate(logPath);
            addon.setLogPath(logPath);
            pathSet = true;
        }
        addon.setLogEnable(enabled);
    } catch (err) {
        logger.error("Failed to configure libpinggy logging", { error: err instanceof Error ? err.message : String(err) });
    }
}
