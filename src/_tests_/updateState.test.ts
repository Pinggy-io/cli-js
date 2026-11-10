import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUpdateState, recordLatestVersion, writeUpdateState } from "../update/updateState.js";
import { getUpdateStatePath } from "../utils/configDir.js";

let temporaryDirectory: string;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-update-state-"));
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = temporaryDirectory;
    }
});

afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function writeRaw(content: string): void {
    fs.mkdirSync(path.dirname(getUpdateStatePath()), { recursive: true });
    fs.writeFileSync(getUpdateStatePath(), content);
}

describe("update.json", () => {
    test("a missing file reads as empty", () => {
        expect(readUpdateState()).toEqual({});
    });

    test("corrupt JSON reads as empty", () => {
        writeRaw("{not json");
        expect(readUpdateState()).toEqual({});
    });

    test("a JSON value that is not an object reads as empty", () => {
        writeRaw("[1,2]");
        expect(readUpdateState()).toEqual({});
    });

    test("a field of the wrong type is dropped and the others survive", () => {
        writeRaw(JSON.stringify({ latestVersion: 5, lastCheckEpochSeconds: 10, unknownField: "x" }));
        expect(readUpdateState()).toEqual({ lastCheckEpochSeconds: 10 });
    });

    test("a patch keeps the other fields", () => {
        writeUpdateState({ latestVersion: "0.6.5" });
        writeUpdateState({ lastNoticeVersion: "0.6.5" });
        expect(readUpdateState()).toEqual({ latestVersion: "0.6.5", lastNoticeVersion: "0.6.5" });
    });

    test("a field set to undefined is removed", () => {
        writeUpdateState({ updatedFromVersion: "0.6.4", latestVersion: "0.6.5" });
        writeUpdateState({ updatedFromVersion: undefined });
        expect(readUpdateState()).toEqual({ latestVersion: "0.6.5" });
    });

    test("a failed write returns false and does not throw", () => {
        fs.writeFileSync(path.join(temporaryDirectory, "pinggy"), "a file where the folder should be");
        expect(writeUpdateState({ latestVersion: "0.6.5" })).toBe(false);
    });

    test("recordLatestVersion sets the seen time only when the version changes", () => {
        recordLatestVersion("0.6.5");
        writeUpdateState({ latestSeenEpochSeconds: 100 });
        recordLatestVersion("0.6.5");
        expect(readUpdateState().latestSeenEpochSeconds).toBe(100);
        recordLatestVersion("0.6.6");
        expect(readUpdateState().latestVersion).toBe("0.6.6");
        expect(readUpdateState().latestSeenEpochSeconds).not.toBe(100);
    });
});
