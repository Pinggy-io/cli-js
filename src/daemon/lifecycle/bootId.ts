/**
 * Tells whether a record in daemon.json, daemon.lock or device-agent.json comes from an earlier boot. After a
 * reboot, the PID in such a record can name another program, so a live PID alone does not prove the process runs.
 *
 * The OS boot ID decides when the record and this machine both have one. It changes on every boot, and a clock step
 * leaves it alone. Comparing times alone takes a running process for one from an earlier boot after the clock jumps
 * forward, and the CLI then deletes a running daemon's daemon.json.
 */
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
/** By full path: launchd and systemd may start the daemon with a PATH that lacks /usr/sbin. */
const MACOS_SYSCTL_PATH = "/usr/sbin/sysctl";
const MACOS_BOOT_ID_KEY = "kern.bootsessionuuid";
const SYSCTL_TIMEOUT_MILLIS = 2_000;

/** os.uptime() counts whole seconds, and the clock can move. A record older than boot by more is stale. */
const BOOT_TIME_TOLERANCE_MILLIS = 60_000;

/** Where the boot ID comes from. A test passes its own. */
export interface BootIdSources {
    platform: NodeJS.Platform;
    readFile(filePath: string): string;
    runCommand(command: string, args: string[]): string;
}

const machineBootIdSources: BootIdSources = {
    platform: process.platform,
    readFile: (filePath) => fs.readFileSync(filePath, "utf-8"),
    runCommand: (command, args) => execFileSync(command, args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SYSCTL_TIMEOUT_MILLIS,
    }),
};

/** Undefined until the first read. The boot ID cannot change while this process runs. */
let cachedBootId: string | null | undefined;

/** This boot's ID, or null when the OS gives none (Windows) or the read fails. Never throws. */
export function readBootId(sources: BootIdSources): string | null {
    try {
        switch (sources.platform) {
            case "linux":
                return nonEmpty(sources.readFile(LINUX_BOOT_ID_PATH));
            case "darwin":
                return nonEmpty(sources.runCommand(MACOS_SYSCTL_PATH, ["-n", MACOS_BOOT_ID_KEY]));
            default:
                return null;
        }
    } catch {
        return null;
    }
}

/** This boot's ID, read once per process. Null when the OS gives none. */
export function currentBootId(): string | null {
    if (cachedBootId === undefined) {
        cachedBootId = readBootId(machineBootIdSources);
    }
    return cachedBootId;
}

/**
 * True when a record names a process from an earlier boot. Compares boot IDs when the record and this machine both
 * have one. Otherwise compares times, as before boot IDs existed.
 *
 * @param recordedBootId the record's boot ID, absent in records that older versions wrote
 * @param bootId this boot's ID, or null when the OS gives none
 */
export function startedInEarlierBoot(recordedBootId: unknown, startedAt: string,
                                     bootId: string | null = currentBootId()): boolean {
    if (typeof recordedBootId === "string" && recordedBootId.length > 0 && bootId) {
        return recordedBootId !== bootId;
    }
    return startedBeforeBoot(startedAt);
}

/**
 * The fallback with no boot ID. A forward clock step moves the boot time this computes later, so after a step bigger
 * than the tolerance it takes a process that started soon after boot for one from an earlier boot. An unparseable
 * time counts as before.
 */
function startedBeforeBoot(startedAt: string): boolean {
    const startedAtMillis = Date.parse(startedAt);
    const bootMillis = Date.now() - os.uptime() * 1000;
    return Number.isNaN(startedAtMillis) || startedAtMillis < bootMillis - BOOT_TIME_TOLERANCE_MILLIS;
}

function nonEmpty(text: string): string | null {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
}
