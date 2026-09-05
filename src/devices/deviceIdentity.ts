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
    ensurePinggyConfigDir();
    const filePath = getDeviceConfigPath();
    fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), {
        encoding: "utf-8",
        mode: SECRET_FILE_MODE,
    });
    // writeFileSync only applies mode when it creates the file, so a rewrite of an existing file
    // would keep whatever mode it already had.
    fs.chmodSync(filePath, SECRET_FILE_MODE);
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
