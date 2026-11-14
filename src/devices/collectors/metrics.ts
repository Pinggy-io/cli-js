import os from "os";
import { DeviceMetrics } from "../device_schema.js";

/**
 * Gap between the 2 CPU samples of a report that has no saved ticks to measure from: the first report of a
 * connection, or one whose saved ticks did not move forward.
 */
export const CPU_SAMPLE_WINDOW_MS = 200;

export interface CpuTicks {
    idleTicks: number;
    totalTicks: number;
}

export interface CpuReading {
    cpuPercent: number;
    /** The ticks the reading ends on. The next report measures from them. */
    endTicks: CpuTicks;
}

export type ReadCpus = () => os.CpuInfo[];

export interface MetricsReadings {
    cpuPercent: number;
    loadAverages: number[];
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    uptimeSeconds: number;
    collectedAtEpochSeconds: number;
}

/** Sums the tick counters of every core. */
export function sumCpuTicks(cpus: os.CpuInfo[]): CpuTicks {
    let idleTicks = 0;
    let totalTicks = 0;
    for (const cpu of cpus) {
        const { user, nice, sys, idle, irq } = cpu.times;
        idleTicks += idle;
        totalTicks += user + nice + sys + idle + irq;
    }
    return { idleTicks, totalTicks };
}

/**
 * Busy percentage across all cores between 2 samples, rounded to 1 decimal, in [0, 100].
 *
 * os.cpus() counters are cumulative since boot. 1 reading divided out is the average over the whole
 * uptime: a flat, plausible, wrong number. Only the difference between 2 readings means anything.
 */
export function cpuPercentBetween(earlier: CpuTicks, later: CpuTicks): number {
    const totalDelta = later.totalTicks - earlier.totalTicks;
    if (totalDelta <= 0) {
        return 0;
    }
    const busyDelta = totalDelta - (later.idleTicks - earlier.idleTicks);
    const percent = Math.min(100, Math.max(0, (100 * busyDelta) / totalDelta));
    return Math.round(percent * 10) / 10;
}

/**
 * Builds the payload. All 3 load averages are always sent: os.loadavg() is [0, 0, 0] on Windows, and
 * the payload shape must not vary by platform.
 */
export function buildMetrics(readings: MetricsReadings): DeviceMetrics {
    const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = readings.loadAverages;
    return {
        cpu_percent: readings.cpuPercent,
        load_avg_1m: oneMinute,
        load_avg_5m: fiveMinutes,
        load_avg_15m: fifteenMinutes,
        memory_used_bytes: readings.totalMemoryBytes - readings.freeMemoryBytes,
        memory_total_bytes: readings.totalMemoryBytes,
        uptime_seconds: Math.floor(readings.uptimeSeconds),
        collected_at: readings.collectedAtEpochSeconds,
    };
}

/** False when the counters stood still or went back, as after a VM pause or a CPU removal. */
export function ticksMovedForward(earlier: CpuTicks, later: CpuTicks): boolean {
    return later.totalTicks > earlier.totalTicks && later.idleTicks >= earlier.idleTicks;
}

/**
 * `cpu_percent` since `previousTicks`, the ticks the previous report ended on. With none, or with ticks
 * that did not move forward, it samples twice, `CPU_SAMPLE_WINDOW_MS` apart.
 *
 * Windows charges CPU time in whole clock ticks of about 15.6 ms. 200 ms on a 2-core VM holds about 25
 * ticks, and a lightly loaded VM often has 0 busy ticks among them, so a 200 ms window reads 0.0% there.
 * The whole report interval holds thousands of ticks.
 */
export async function readCpuPercent(previousTicks: CpuTicks | null, readCpus: ReadCpus): Promise<CpuReading> {
    const currentTicks = sumCpuTicks(readCpus());
    if (previousTicks && ticksMovedForward(previousTicks, currentTicks)) {
        return { cpuPercent: cpuPercentBetween(previousTicks, currentTicks), endTicks: currentTicks };
    }
    await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_WINDOW_MS));
    const laterTicks = sumCpuTicks(readCpus());
    return { cpuPercent: cpuPercentBetween(currentTicks, laterTicks), endTicks: laterTicks };
}

/**
 * The `device/metrics` collector for 1 connection. Each call measures `cpu_percent` from the ticks the
 * previous call ended on. Create 1 per connection: after a reconnect, the saved ticks would span the time
 * offline.
 */
export function createMetricsCollector(readCpus: ReadCpus = () => os.cpus()): () => Promise<DeviceMetrics> {
    let previousTicks: CpuTicks | null = null;
    return async () => {
        const cpuReading = await readCpuPercent(previousTicks, readCpus);
        previousTicks = cpuReading.endTicks;
        return buildMetrics({
            cpuPercent: cpuReading.cpuPercent,
            loadAverages: os.loadavg(),
            totalMemoryBytes: os.totalmem(),
            freeMemoryBytes: os.freemem(),
            uptimeSeconds: os.uptime(),
            collectedAtEpochSeconds: Math.floor(Date.now() / 1000),
        });
    };
}