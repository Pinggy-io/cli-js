import { describe, test, expect } from "@jest/globals";
import { BootIdSources, currentBootId, readBootId, startedInEarlierBoot } from "../daemon/lifecycle/bootId.js";

const BOOT_ID = "6f1c0e52-3b1d-4c55-9a3e-2d1f0b7c9e11";
const OTHER_BOOT_ID = "0a9b8c7d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
/** Long before any boot, so the time check alone calls it stale. */
const BEFORE_BOOT = "2000-01-01T00:00:00.000Z";

function sources(platform: NodeJS.Platform, output: string | Error): BootIdSources {
    const answer = () => {
        if (output instanceof Error) throw output;
        return output;
    };
    return { platform, readFile: answer, runCommand: answer };
}

describe("readBootId", () => {
    test("reads /proc on Linux, without the newline", () => {
        const linux: BootIdSources = { ...sources("linux", ""), readFile: (filePath) => `${filePath}\n` };
        expect(readBootId(linux)).toBe("/proc/sys/kernel/random/boot_id");
    });

    test("runs sysctl by full path on macOS, without the newline", () => {
        const macos: BootIdSources = {
            ...sources("darwin", ""),
            runCommand: (command, args) => `${command} ${args.join(" ")}\n`,
        };
        expect(readBootId(macos)).toBe("/usr/sbin/sysctl -n kern.bootsessionuuid");
    });

    test("gives none on Windows, so the time check runs there", () => {
        expect(readBootId(sources("win32", BOOT_ID))).toBeNull();
    });

    test("gives none when the read fails or returns nothing", () => {
        expect(readBootId(sources("linux", new Error("ENOENT")))).toBeNull();
        expect(readBootId(sources("darwin", new Error("ETIMEDOUT")))).toBeNull();
        expect(readBootId(sources("darwin", " \n"))).toBeNull();
    });
});

describe("startedInEarlierBoot", () => {
    test("the same boot ID is this boot, even when the clock puts the start before boot", () => {
        expect(startedInEarlierBoot(BOOT_ID, BEFORE_BOOT, BOOT_ID)).toBe(false);
    });

    test("another boot ID is an earlier boot, even when the start time is recent", () => {
        expect(startedInEarlierBoot(OTHER_BOOT_ID, new Date().toISOString(), BOOT_ID)).toBe(true);
    });

    test("a record with no boot ID falls back to the time", () => {
        expect(startedInEarlierBoot(undefined, BEFORE_BOOT, BOOT_ID)).toBe(true);
        expect(startedInEarlierBoot(undefined, new Date().toISOString(), BOOT_ID)).toBe(false);
        expect(startedInEarlierBoot("", BEFORE_BOOT, BOOT_ID)).toBe(true);
        expect(startedInEarlierBoot(42, BEFORE_BOOT, BOOT_ID)).toBe(true);
    });

    test("a machine with no boot ID falls back to the time", () => {
        expect(startedInEarlierBoot(BOOT_ID, BEFORE_BOOT, null)).toBe(true);
        expect(startedInEarlierBoot(BOOT_ID, new Date().toISOString(), null)).toBe(false);
    });

    test("an unparseable time with no boot ID counts as an earlier boot", () => {
        expect(startedInEarlierBoot(undefined, "not a time", null)).toBe(true);
    });
});

describe("currentBootId", () => {
    test("reads this machine's boot ID once, or none on Windows", () => {
        const bootId = currentBootId();
        if (process.platform === "linux" || process.platform === "darwin") {
            expect(bootId).toMatch(/^[0-9a-fA-F-]{36}$/);
        } else {
            expect(bootId).toBeNull();
        }
        expect(currentBootId()).toBe(bootId);
    });
});
