/**
 * The foreground device agent's record, device-agent.json, and how `pinggy device remove` stops it.
 *
 * A foreground agent runs in its own CLI process, so the daemon cannot see it. While it runs, it keeps
 * its PID in device-agent.json and checks once a second that the file still exists. `remove` deletes
 * the file, and the agent stops on its next check. No signal goes to the PID: a record left by a
 * crash can name an unrelated process that reused the number.
 */
import fs from "fs";
import os from "os";
import { ensurePinggyConfigDir, getForegroundAgentPath } from "../utils/configDir.js";
import { isProcessAlive } from "../daemon/lifecycle/daemonManager.js";
import { logger } from "../logger.js";
import { errorMessage } from "../utils/util.js";
import CLIPrinter from "../utils/printer.js";

export interface ForegroundAgentRecord {
    pid: number;
    started_at: string;
}

/** How often a running agent checks that its record still exists. */
const RECORD_CHECK_INTERVAL_MILLIS = 1_000;

/** How long `remove` waits for the agent to exit: 1 check, the agent's 3s close timeout, and margin. */
const STOP_WAIT_MILLIS = 10_000;
const STOP_POLL_INTERVAL_MILLIS = 200;

/** os.uptime() counts whole seconds, and the clock can move. A record older than boot by more is stale. */
const BOOT_TIME_TOLERANCE_MILLIS = 60_000;

function readRecordFile(filePath: string): ForegroundAgentRecord | null {
    try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ForegroundAgentRecord;
        return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
    } catch {
        return null;
    }
}

function deleteRecordFile(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        logger.debug("No foreground agent record to delete", { error: errorMessage(err) });
    }
}

/** A PID from before the last boot can name another process now, so its record is stale. */
function startedBeforeBoot(record: ForegroundAgentRecord): boolean {
    const startedAtMillis = Date.parse(record.started_at);
    const bootMillis = Date.now() - os.uptime() * 1000;
    return Number.isNaN(startedAtMillis) || startedAtMillis < bootMillis - BOOT_TIME_TOLERANCE_MILLIS;
}

/** The running foreground agent, or null. Deletes a record whose process is gone. */
export function readForegroundAgent(): ForegroundAgentRecord | null {
    const filePath = getForegroundAgentPath();
    const record = readRecordFile(filePath);
    if (!record) {
        return null;
    }
    if (record.pid === process.pid) {
        return null;
    }
    if (startedBeforeBoot(record) || !isProcessAlive(record.pid)) {
        logger.info("Stale device-agent.json found, cleaning up", { stalePid: record.pid });
        deleteRecordFile(filePath);
        return null;
    }
    return record;
}

/**
 * Writes this process's record, and calls `onRecordDeleted` once when the file disappears. A config dir
 * that cannot be written leaves the agent running with no record.
 *
 * @returns a release that stops the check and deletes the record, if it still names this process
 */
export function recordForegroundAgent(onRecordDeleted: () => void): () => void {
    const filePath = getForegroundAgentPath();
    const record: ForegroundAgentRecord = { pid: process.pid, started_at: new Date().toISOString() };
    try {
        ensurePinggyConfigDir();
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
    } catch (err) {
        logger.warn("Could not write device-agent.json. pinggy device remove cannot stop this agent.",
            { error: errorMessage(err) });
        return () => undefined;
    }

    const timer = setInterval(() => {
        if (!fs.existsSync(filePath)) {
            clearInterval(timer);
            onRecordDeleted();
        }
    }, RECORD_CHECK_INTERVAL_MILLIS);
    // The agent's socket keeps the process alive. This check never should.
    timer.unref();

    return () => {
        clearInterval(timer);
        if (readRecordFile(filePath)?.pid === process.pid) {
            deleteRecordFile(filePath);
        }
    };
}

export interface ForegroundStopDependencies {
    readAgent(): ForegroundAgentRecord | null;
    deleteRecord(): void;
    isAlive(pid: number): boolean;
    sleep(millis: number): Promise<void>;
    now(): number;
    print(message: string): void;
    printError(message: string): void;
}

export function machineForegroundStopDependencies(): ForegroundStopDependencies {
    return {
        readAgent: readForegroundAgent,
        deleteRecord: () => deleteRecordFile(getForegroundAgentPath()),
        isAlive: isProcessAlive,
        sleep: (millis) => new Promise((resolve) => setTimeout(resolve, millis)),
        now: () => Date.now(),
        print: (message) => CLIPrinter.print(message),
        printError: (message) => CLIPrinter.error(message),
    };
}

/**
 * `pinggy device remove` runs this before it deletes device.json. A running agent would keep the machine
 * online and write the file back on its next `welcome`.
 *
 * @returns true when no foreground agent runs any more
 */
export async function stopForegroundAgentBeforeRemove(
    dependencies: ForegroundStopDependencies = machineForegroundStopDependencies()): Promise<boolean> {
    const record = dependencies.readAgent();
    if (!record) {
        return true;
    }

    dependencies.deleteRecord();
    const deadline = dependencies.now() + STOP_WAIT_MILLIS;
    while (dependencies.isAlive(record.pid)) {
        if (dependencies.now() >= deadline) {
            dependencies.printError(`The device agent in another terminal (PID ${record.pid}) did not stop. `
                + "Press Ctrl+C in that terminal, then run: pinggy device remove");
            return false;
        }
        await dependencies.sleep(STOP_POLL_INTERVAL_MILLIS);
    }
    dependencies.print(`Stopped the device agent running in another terminal (PID ${record.pid}).`);
    return true;
}

/** Why another agent must not start, or null. 2 agents on 1 credential refuse each other. */
export function foregroundAgentRefusal(record: ForegroundAgentRecord | null = readForegroundAgent()):
    string | null {
    if (!record) {
        return null;
    }
    return `This machine already runs as a device in another terminal (PID ${record.pid}). `
        + "Press Ctrl+C in that terminal first.";
}
