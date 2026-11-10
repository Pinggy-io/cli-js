/**
 * update.lock: only 1 process replaces the binary at a time.
 *
 * `wx` creates the file before the pid is written, so an empty or unreadable lock counts as held. Age comes from the
 * file's modified time, so a lock nobody could read still goes stale.
 */
import fs from "node:fs";
import { isProcessAlive } from "../daemon/lifecycle/daemonManager.js";
import { ensurePinggyConfigDir, getUpdateLockPath } from "../utils/configDir.js";

const STALE_AFTER_MILLIS = 30 * 60 * 1000;
const REPLACEMENT_SETTLE_MILLIS = 200;

const LockState = {
    Absent: "absent",
    Held: "held",
    Stale: "stale",
} as const;
type LockState = typeof LockState[keyof typeof LockState];

function readLockPid(lockPath: string): number | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: unknown };
        return typeof parsed.pid === "number" && parsed.pid > 0 ? parsed.pid : null;
    } catch {
        return null;
    }
}

function lockState(lockPath: string): LockState {
    let modifiedMillis: number;
    try {
        modifiedMillis = fs.statSync(lockPath).mtimeMs;
    } catch {
        return LockState.Absent;
    }
    if (Date.now() - modifiedMillis >= STALE_AFTER_MILLIS) return LockState.Stale;
    const pid = readLockPid(lockPath);
    return pid === null || isProcessAlive(pid) ? LockState.Held : LockState.Stale;
}

function lockContents(): string {
    return JSON.stringify({ pid: process.pid, startedAt: Date.now() });
}

function createLock(lockPath: string): boolean {
    try {
        const fileDescriptor = fs.openSync(lockPath, "wx");
        fs.writeSync(fileDescriptor, lockContents());
        fs.closeSync(fileDescriptor);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    }
}

function wait(millis: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

/** A rename, not delete then create, so 2 processes that both see the stale lock cannot both win. */
async function replaceStaleLock(lockPath: string): Promise<boolean> {
    const temporaryPath = `${lockPath}.${process.pid}`;
    fs.writeFileSync(temporaryPath, lockContents());
    fs.renameSync(temporaryPath, lockPath);
    await wait(REPLACEMENT_SETTLE_MILLIS);
    return readLockPid(lockPath) === process.pid;
}

/** @returns false when another live process holds the lock */
export async function acquireUpdateLock(): Promise<boolean> {
    ensurePinggyConfigDir();
    const lockPath = getUpdateLockPath();
    if (createLock(lockPath)) return true;
    switch (lockState(lockPath)) {
        case LockState.Held:
            return false;
        case LockState.Absent:
            return createLock(lockPath);
        case LockState.Stale:
            return replaceStaleLock(lockPath);
    }
}

export function isUpdateLockHeld(): boolean {
    return lockState(getUpdateLockPath()) === LockState.Held;
}

export function isUpdateLockOurs(): boolean {
    return readLockPid(getUpdateLockPath()) === process.pid;
}

export function releaseUpdateLock(): void {
    if (isUpdateLockOurs()) fs.rmSync(getUpdateLockPath(), { force: true });
}
