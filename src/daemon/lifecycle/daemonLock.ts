/**
 * daemon.lock keeps 1 daemon per user.
 *
 * The CLI checks daemon.json before it spawns a daemon, but systemd and launchd run --_daemon-child
 * directly, and 2 CLIs can both find no daemon.json and both spawn one. So each daemon takes this
 * lock before it opens its IPC port, and a daemon that finds a live holder exits.
 *
 * 2 daemons that both find the same stale lock can both replace it. That needs a crashed daemon and
 * 2 starts within the same few milliseconds.
 */
import fs from "node:fs";
import { ensurePinggyConfigDir, getDaemonLockPath } from "../../utils/configDir.js";
import { isProcessAlive, startedBeforeBoot } from "./daemonManager.js";
import { logger } from "../../logger.js";

export interface DaemonLockRecord {
    pid: number;
    started_at: string;
}

/** The holder creates the file, then writes it. A lock still empty after this long is left by a crash. */
const UNREADABLE_LOCK_GRACE_MILLIS = 10_000;

function readLock(lockPath: string): DaemonLockRecord | null {
    try {
        const record = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as DaemonLockRecord;
        return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
    } catch {
        return null;
    }
}

function isUnreadableLockOld(lockPath: string): boolean {
    try {
        return Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_LOCK_GRACE_MILLIS;
    } catch {
        return true;
    }
}

function isStale(lockPath: string, holder: DaemonLockRecord | null): boolean {
    if (!holder) return isUnreadableLockOld(lockPath);
    return startedBeforeBoot(holder.started_at) || !isProcessAlive(holder.pid);
}

/** Creates the lock only if no file exists. False when one does. */
function createLock(lockPath: string, record: DaemonLockRecord): boolean {
    try {
        fs.writeFileSync(lockPath, JSON.stringify(record), { encoding: "utf-8", flag: "wx" });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
    }
}

/** Takes daemon.lock for this process. False when another live daemon holds it. */
export function acquireDaemonLock(): boolean {
    ensurePinggyConfigDir();
    const lockPath = getDaemonLockPath();
    const record: DaemonLockRecord = { pid: process.pid, started_at: new Date().toISOString() };
    if (createLock(lockPath, record)) return true;

    const holder = readLock(lockPath);
    if (holder?.pid === process.pid) return true;
    if (!isStale(lockPath, holder)) return false;

    logger.info("Stale daemon.lock found, replacing it", { stalePid: holder?.pid });
    fs.rmSync(lockPath, { force: true });
    return createLock(lockPath, record);
}

/** Deletes daemon.lock if this process holds it. */
export function releaseDaemonLock(): void {
    const lockPath = getDaemonLockPath();
    if (readLock(lockPath)?.pid === process.pid) {
        fs.rmSync(lockPath, { force: true });
    }
}
