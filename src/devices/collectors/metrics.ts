import os from "os";
import { DeviceMetrics } from "../device_schema.js";

/** Gap between the 2 CPU samples. Long enough for the tick counters to move. */
export const CPU_SAMPLE_WINDOW_MS = 200;

export interface CpuTicks {
    idleTicks: number;
    totalTicks: number;
}

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

export async function collectMetrics(): Promise<DeviceMetrics> {
    const earlier = sumCpuTicks(os.cpus());
    await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_WINDOW_MS));
    const later = sumCpuTicks(os.cpus());

    return buildMetrics({
        cpuPercent: cpuPercentBetween(earlier, later),
        loadAverages: os.loadavg(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        uptimeSeconds: os.uptime(),
        collectedAtEpochSeconds: Math.floor(Date.now() / 1000),
    });
}