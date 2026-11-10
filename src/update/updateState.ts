/**
 * update.json: what the update checks found and which lines already printed.
 *
 * Every field is optional, and a missing or corrupt file reads as empty. Installed updaters read and write these
 * names for years, so a field keeps its name once it ships.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePinggyConfigDir, getUpdateStatePath } from "../utils/configDir.js";
import { logger } from "../logger.js";
import { errorMessage } from "../utils/util.js";

export interface UpdateState {
    lastCheckEpochSeconds?: number;
    lastAttemptEpochSeconds?: number;
    latestVersion?: string;
    latestSeenEpochSeconds?: number;
    lastNoticeVersion?: string;
    lastDaemonNoticeVersion?: string;
    lastCheckFailureNoticeEpochSeconds?: number;
    rolledBackFromVersion?: string;
    updatedFromVersion?: string;
    updatedToVersion?: string;
    failedVersion?: string;
    failedAttempts?: number;
    deferredVersion?: string;
    deferredIpcVersion?: number;
}

const NUMBER_FIELDS = [
    "lastCheckEpochSeconds",
    "lastAttemptEpochSeconds",
    "latestSeenEpochSeconds",
    "lastCheckFailureNoticeEpochSeconds",
    "failedAttempts",
    "deferredIpcVersion",
] as const;

const STRING_FIELDS = [
    "latestVersion",
    "lastNoticeVersion",
    "lastDaemonNoticeVersion",
    "rolledBackFromVersion",
    "updatedFromVersion",
    "updatedToVersion",
    "failedVersion",
    "deferredVersion",
] as const;

export function nowEpochSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** A file from another build can hold anything, so only fields of the right type survive the read. */
function keepKnownFields(parsed: Record<string, unknown>): UpdateState {
    const state: UpdateState = {};
    for (const field of NUMBER_FIELDS) {
        const value = parsed[field];
        if (typeof value === "number" && Number.isFinite(value)) state[field] = value;
    }
    for (const field of STRING_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string") state[field] = value;
    }
    return state;
}

export function readUpdateState(): UpdateState {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(getUpdateStatePath(), "utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        return keepKnownFields(parsed as Record<string, unknown>);
    } catch {
        return {};
    }
}

/**
 * Merges the patch over the current file. A field set to undefined is removed. Last write wins.
 *
 * @returns false when the write failed. It never throws, so a caller that must not go on without the record can stop.
 */
export function writeUpdateState(patch: UpdateState): boolean {
    try {
        ensurePinggyConfigDir();
        const statePath = getUpdateStatePath();
        const temporaryPath = path.join(path.dirname(statePath), `update.json.${process.pid}.tmp`);
        fs.writeFileSync(temporaryPath, JSON.stringify({ ...readUpdateState(), ...patch }, null, 2), "utf-8");
        fs.renameSync(temporaryPath, statePath);
        return true;
    } catch (error) {
        logger.debug("Could not write update.json", { error: errorMessage(error) });
        return false;
    }
}

/** Every writer of `latestVersion` uses this, so `latestSeenEpochSeconds` always moves with it. */
export function recordLatestVersion(version: string): boolean {
    const changed = readUpdateState().latestVersion !== version;
    return writeUpdateState(changed ? { latestVersion: version, latestSeenEpochSeconds: nowEpochSeconds() } : { latestVersion: version });
}
