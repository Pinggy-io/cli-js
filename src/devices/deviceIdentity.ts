import fs from "fs";
import { ensurePinggyConfigDir, getDeviceConfigPath } from "../utils/configDir.js";
import { logger } from "../logger.js";

/**
 * What this machine remembers about its enrolment.
 *
 * device_agent_id is minted by the dashboard and learned from the welcome frame. The agent never
 * invents one.
 */
export interface DeviceIdentity {
    device_agent_id: string | null;
    token: string;
    server: string;
    enrolled_at: string | null;
    /**
     * The answer to the file access question (`fileAccess.ts`). Absent until a person answers it or passes
     * `--files`. Absent counts as allowed.
     */
    file_manager?: boolean;
}

/**
 * 0600, because this file holds a live credential.
 *
 * Deliberately unlike configStore.ts, which writes saved tunnel configs with no mode and lands them
 * at 0644 under a normal umask despite containing tunnel tokens.
 */
const SECRET_FILE_MODE = 0o600;

export function readDeviceIdentity(): DeviceIdentity | null {
    const filePath = getDeviceConfigPath();
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DeviceIdentity;
    } catch (e) {
        logger.warn("Could not read device identity file", { error: String(e) });
        return null;
    }
}

export function writeDeviceIdentity(identity: DeviceIdentity): void {
    const written = keepStoredFileManager(identity, readDeviceIdentity());
    ensurePinggyConfigDir();
    const filePath = getDeviceConfigPath();
    // Both lines are load-bearing, and neither replaces the other.
    //
    // mode covers a create: without it the file is born at 0644 under a normal umask and holds the
    // token for however long it takes the chmod below to run. The end state would be identical, so
    // no test can see the difference; the window is the point.
    fs.writeFileSync(filePath, JSON.stringify(written, null, 2), {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
    });
    // chmod covers a rewrite: writeFileSync applies mode only when it creates the file, so a
    // device.json left behind by an older build would keep whatever mode it already had.
    fs.chmodSync(filePath, SECRET_FILE_MODE);
}

/**
 * An identity with no `file_manager` keeps the answer device.json holds for the same token. A running agent writes
 * device.json on each `welcome`, and `connect --files` can change the answer while it runs. A new token starts with
 * no answer.
 */
function keepStoredFileManager(identity: DeviceIdentity, stored: DeviceIdentity | null): DeviceIdentity {
    if (identity.file_manager !== undefined || !stored || stored.token !== identity.token
        || typeof stored.file_manager !== "boolean") {
        return identity;
    }
    return { ...identity, file_manager: stored.file_manager };
}

export function clearDeviceIdentity(): boolean {
    const filePath = getDeviceConfigPath();
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    return true;
}

/** Masked for display. The full value is never printed. */
export function maskToken(token: string): string {
    return token.length <= 8 ? "***" : `${token.slice(0, 8)}...${token.slice(-4)}`;
}
