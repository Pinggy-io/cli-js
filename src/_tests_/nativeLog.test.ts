import { describe, test, expect, beforeAll, afterAll, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setNativeLogging, NativeLogAddon } from "../logger/nativeLog.js";
import { getLibpinggyLogPath } from "../utils/configDir.js";

/** Records the calls libpinggy would get. */
function fakeAddon(): NativeLogAddon & { paths: string[]; enables: boolean[] } {
    const paths: string[] = [];
    const enables: boolean[] = [];
    return {
        paths,
        enables,
        setLogPath: (p: string) => { paths.push(p); },
        setLogEnable: (e: boolean) => { enables.push(e); },
    };
}

const ENV_KEYS = ["XDG_STATE_HOME", "LOCALAPPDATA"] as const;
const saved: Record<string, string | undefined> = {};
let logHome: string;

beforeAll(() => {
    // The log directory comes from the home directory on macOS and from a variable elsewhere.
    logHome = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-nativelog-"));
    jest.spyOn(os, "homedir").mockReturnValue(logHome);
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        process.env[key] = logHome;
    }
});

afterAll(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    fs.rmSync(logHome, { recursive: true, force: true });
});

describe("setNativeLogging", () => {
    // One test: the module remembers that the path is set, for the life of the process.
    test("opens the log file once, and only when logging is turned on", () => {
        const addon = fakeAddon();

        setNativeLogging(false, addon);
        expect(addon.paths).toEqual([]);
        expect(addon.enables).toEqual([false]);
        expect(fs.existsSync(path.dirname(getLibpinggyLogPath()))).toBe(false);

        setNativeLogging(true, addon);
        expect(addon.paths).toEqual([getLibpinggyLogPath()]);
        expect(getLibpinggyLogPath().startsWith(logHome)).toBe(true);
        expect(fs.existsSync(path.dirname(getLibpinggyLogPath()))).toBe(true);

        setNativeLogging(false, addon);
        setNativeLogging(true, addon);
        expect(addon.paths).toHaveLength(1);
        expect(addon.enables).toEqual([false, true, false, true]);
    });
});
