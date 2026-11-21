import { describe, test, expect, jest, afterEach } from '@jest/globals';
import os from 'os';

import {
    CPU_SAMPLE_WINDOW_MS, ReadCpus, buildMetrics, cpuPercentBetween, createMetricsCollector, sumCpuTicks, ticksMovedForward,
} from '../devices/collectors/metrics.js';
import { collectSystemInfo } from '../devices/collectors/systemInfo.js';
import { startMetricsReporting } from '../devices/deviceAgent.js';
import { DeviceMetrics } from '../devices/device_schema.js';

function core(user: number, sys: number, idle: number): os.CpuInfo {
    return { model: 'test', speed: 0, times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe('cpu_percent', () => {
    // 2 cores. Between the samples each core spends 150 ticks busy and 50 idle: 75% busy.
    const earlier = [core(100, 50, 850), core(100, 50, 850)];
    const later = [core(200, 100, 900), core(200, 100, 900)];

    test('is the busy share of the ticks between 2 samples', () => {
        expect(cpuPercentBetween(sumCpuTicks(earlier), sumCpuTicks(later))).toBe(75);
    });

    // The single-reading bug: cumulative counters give the average since boot, 25% here.
    test('is not what 1 cumulative reading would give', () => {
        const singleReading = sumCpuTicks(later);
        const averageSinceBoot = 100 * (singleReading.totalTicks - singleReading.idleTicks) / singleReading.totalTicks;
        expect(averageSinceBoot).toBe(25);
        expect(cpuPercentBetween(sumCpuTicks(earlier), sumCpuTicks(later))).not.toBe(averageSinceBoot);
    });

    test('is 0 when no ticks elapsed', () => {
        expect(cpuPercentBetween(sumCpuTicks(later), sumCpuTicks(later))).toBe(0);
    });

    test('stays inside [0, 100] when counters move oddly', () => {
        expect(cpuPercentBetween({ idleTicks: 100, totalTicks: 100 }, { idleTicks: 50, totalTicks: 200 })).toBe(100);
        expect(cpuPercentBetween({ idleTicks: 0, totalTicks: 100 }, { idleTicks: 300, totalTicks: 200 })).toBe(0);
    });

    test('counters move forward only when the total grows and idle does not shrink', () => {
        expect(ticksMovedForward({ idleTicks: 10, totalTicks: 100 }, { idleTicks: 10, totalTicks: 101 })).toBe(true);
        expect(ticksMovedForward({ idleTicks: 10, totalTicks: 100 }, { idleTicks: 10, totalTicks: 100 })).toBe(false);
        expect(ticksMovedForward({ idleTicks: 10, totalTicks: 100 }, { idleTicks: 20, totalTicks: 90 })).toBe(false);
        expect(ticksMovedForward({ idleTicks: 10, totalTicks: 100 }, { idleTicks: 5, totalTicks: 200 })).toBe(false);
    });
});

describe('cpu_percent window', () => {
    // 1 core. Measured on a 2-core Windows VM at idle on 2026-11-14: over 60 s the cores counted 120202 ms,
    // 6187 ms of them busy. The 200 ms sample before it caught no busy tick.
    const sampleStart = [core(1000, 0, 9000)];
    const sampleEnd = [core(1000, 0, 9406)];
    const minuteLater = [core(1000 + 6187, 0, 9406 + 114015)];

    function readCpusReturning(...readings: os.CpuInfo[][]) {
        const readCpus = jest.fn<ReadCpus>();
        for (const reading of readings) {
            readCpus.mockReturnValueOnce(reading);
        }
        return readCpus;
    }

    // Resolves the first report, which waits CPU_SAMPLE_WINDOW_MS between its 2 samples.
    async function firstReport(collect: ReturnType<typeof createMetricsCollector>) {
        const report = collect();
        await jest.advanceTimersByTimeAsync(CPU_SAMPLE_WINDOW_MS);
        return report;
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    test('the first report samples twice, CPU_SAMPLE_WINDOW_MS apart', async () => {
        jest.useFakeTimers();
        const readCpus = readCpusReturning(sampleStart, sampleEnd);
        const collect = createMetricsCollector(readCpus);

        const report = collect();
        await jest.advanceTimersByTimeAsync(CPU_SAMPLE_WINDOW_MS - 1);
        expect(readCpus).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(readCpus).toHaveBeenCalledTimes(2);
        expect((await report).cpu_percent).toBe(0);
    });

    // The VM bug: a 200 ms sample reads 0.0%, the minute since the previous report reads 5.1%.
    test('the next report measures from the ticks the previous one ended on, without waiting', async () => {
        jest.useFakeTimers();
        const readCpus = readCpusReturning(sampleStart, sampleEnd, minuteLater);
        const collect = createMetricsCollector(readCpus);
        expect((await firstReport(collect)).cpu_percent).toBe(0);

        let settled = false;
        const report = collect().then((metrics) => {
            settled = true;
            return metrics;
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(settled).toBe(true);
        expect(readCpus).toHaveBeenCalledTimes(3);
        expect((await report).cpu_percent).toBe(5.1);
    });

    test('samples twice again when the counters did not move since the previous report', async () => {
        jest.useFakeTimers();
        const readCpus = readCpusReturning(sampleStart, sampleEnd, sampleEnd, minuteLater);
        const collect = createMetricsCollector(readCpus);
        await firstReport(collect);

        const report = collect();
        await jest.advanceTimersByTimeAsync(CPU_SAMPLE_WINDOW_MS);

        expect(readCpus).toHaveBeenCalledTimes(4);
        expect((await report).cpu_percent).toBe(5.1);
    });

    test('a new collector, as after a reconnect, does not measure from the old one\'s ticks', async () => {
        jest.useFakeTimers();
        await firstReport(createMetricsCollector(readCpusReturning(sampleStart, sampleEnd)));

        const readCpus = readCpusReturning(minuteLater, minuteLater);
        const report = createMetricsCollector(readCpus)();
        await jest.advanceTimersByTimeAsync(CPU_SAMPLE_WINDOW_MS);

        expect(readCpus).toHaveBeenCalledTimes(2);
        expect((await report).cpu_percent).toBe(0);
    });
});

describe('metrics payload', () => {
    const readings = {
        cpuPercent: 12.4,
        loadAverages: [0.82, 0.61, 0.55],
        totalMemoryBytes: 64_000,
        freeMemoryBytes: 46_000,
        uptimeSeconds: 184023.7,
        collectedAtEpochSeconds: 1750000200,
    };

    test('carries every field', () => {
        expect(buildMetrics(readings)).toEqual({
            cpu_percent: 12.4,
            load_avg_1m: 0.82,
            load_avg_5m: 0.61,
            load_avg_15m: 0.55,
            memory_used_bytes: 18_000,
            memory_total_bytes: 64_000,
            uptime_seconds: 184023,
            collected_at: 1750000200,
        });
    });

    // os.loadavg() is [0, 0, 0] on Windows. The fields are sent, not dropped.
    test('sends zero load averages rather than omitting them', () => {
        const metrics = buildMetrics({ ...readings, loadAverages: [0, 0, 0] });
        expect(metrics).toHaveProperty('load_avg_1m', 0);
        expect(metrics).toHaveProperty('load_avg_5m', 0);
        expect(metrics).toHaveProperty('load_avg_15m', 0);
    });

    test('a real reading from this machine is plausible', async () => {
        const metrics = await createMetricsCollector()();
        expect(metrics.cpu_percent).toBeGreaterThanOrEqual(0);
        expect(metrics.cpu_percent).toBeLessThanOrEqual(100);
        expect(metrics.memory_used_bytes).toBeLessThan(metrics.memory_total_bytes);
        expect(Number.isInteger(metrics.collected_at)).toBe(true);
    });
});

describe('system info', () => {
    test('carries every field with the right type', () => {
        const info = collectSystemInfo();
        for (const field of ['hostname', 'os', 'os_version', 'arch', 'kernel', 'cpu_model'] as const) {
            expect(typeof info[field]).toBe('string');
        }
        expect(info.os).toBe(os.platform());
        expect(info.cpu_cores).toBeGreaterThan(0);
        expect(info.total_memory_bytes).toBeGreaterThan(0);
    });

    test('names the user the agent runs as', () => {
        const info = collectSystemInfo();
        expect(info.username).toBe(os.userInfo().username);
        expect(info.uid).toBe(process.getuid?.());
    });

    test('still sends the uid when the OS has no name for it', () => {
        const spy = jest.spyOn(os, 'userInfo').mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory, uv_os_get_passwd');
        });
        try {
            const info = collectSystemInfo();
            expect(info).not.toHaveProperty('username');
            expect(info.uid).toBe(process.getuid?.());
        } finally {
            spy.mockRestore();
        }
    });
});

describe('metrics reporting cadence', () => {
    const reading: DeviceMetrics = buildMetrics({
        cpuPercent: 1, loadAverages: [0, 0, 0], totalMemoryBytes: 2, freeMemoryBytes: 1,
        uptimeSeconds: 1, collectedAtEpochSeconds: 1,
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // The interval is whatever welcome said, here 10 s, not a constant compiled into the agent.
    test('sends at once, then every interval from welcome, until stopped', async () => {
        jest.useFakeTimers();
        const collect = jest.fn(async () => reading);
        const send = jest.fn();

        const stop = startMetricsReporting(10, collect, send);
        await jest.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(9_999);
        expect(send).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);

        stop();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(send).toHaveBeenCalledTimes(2);
    });
});