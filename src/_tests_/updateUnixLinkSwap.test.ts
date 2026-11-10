import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateError, UpdateErrorCode } from "../update/binaryUpdater.js";
import { UnixLayoutPaths, unixLayoutPaths } from "../update/installKind.js";
import {
    installVersion,
    pruneVersions,
    readLinkVersion,
    removeStaleUnixFiles,
    rollbackUnixVersion,
    unixDownloadPath,
    UnixSwapEnvironment,
    versionBinaryPath,
} from "../update/unixLinkSwap.js";
import { readUpdateState } from "../update/updateState.js";

let home: string;
let layout: UnixLayoutPaths;
let fsyncCalls: string[];
let daemonVersion: string | undefined;
let serviceEntry: string;
let alivePids: number[];
const savedEnvironment: Record<string, string | undefined> = {};

const environment: UnixSwapEnvironment = {
    fsyncFile: (filePath) => { fsyncCalls.push(`file:${filePath}`); },
    fsyncDirectory: (directory) => { fsyncCalls.push(`directory:${directory}`); },
    daemonVersion: () => daemonVersion,
    serviceEntryText: () => serviceEntry,
    isAlive: (pid) => alivePids.includes(pid),
};

function addVersion(version: string): void {
    fs.mkdirSync(path.dirname(versionBinaryPath(layout, version)), { recursive: true });
    fs.writeFileSync(versionBinaryPath(layout, version), version);
}

function pointLinkAt(version: string): void {
    fs.mkdirSync(layout.binDirectory, { recursive: true });
    fs.rmSync(layout.link, { force: true });
    fs.symlinkSync(versionBinaryPath(layout, version), layout.link);
}

function placeDownload(content: string): void {
    fs.mkdirSync(layout.versionsDirectory, { recursive: true });
    fs.writeFileSync(unixDownloadPath(layout), content);
}

const versions = (): string[] => fs.readdirSync(layout.versionsDirectory).sort();
const install = (newVersion: string, runningVersion = "0.6.4", plainFileToConvert: string | null = null): void =>
    installVersion({ layout, plainFileToConvert, newVersion, runningVersion }, environment);

function failureOf(action: () => unknown): UpdateError {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(UpdateError);
        return error as UpdateError;
    }
    throw new Error("expected a failure");
}

beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pinggy-link-swap-")));
    layout = unixLayoutPaths(home);
    fsyncCalls = [];
    daemonVersion = undefined;
    serviceEntry = "";
    alivePids = [];
    for (const name of ["XDG_CONFIG_HOME", "APPDATA"]) {
        savedEnvironment[name] = process.env[name];
        process.env[name] = path.join(home, "config");
    }
});

afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
});

const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

describeOnUnix("installVersion", () => {
    test("the link points at the new version after the install", () => {
        addVersion("0.6.4");
        pointLinkAt("0.6.4");
        placeDownload("0.6.5");
        install("0.6.5");
        expect(readLinkVersion(layout)).toBe("0.6.5");
        expect(fs.readFileSync(layout.link, "utf-8")).toBe("0.6.5");
        expect(fs.existsSync(unixDownloadPath(layout))).toBe(false);
    });

    test("fsync runs on the version folder before the link move and on bin after it", () => {
        addVersion("0.6.4");
        pointLinkAt("0.6.4");
        placeDownload("0.6.5");
        install("0.6.5");
        expect(fsyncCalls).toEqual([
            `directory:${path.dirname(versionBinaryPath(layout, "0.6.5"))}`,
            `directory:${layout.binDirectory}`,
        ]);
    });

    test("conversion turns a plain file into a version and a link", () => {
        fs.mkdirSync(layout.binDirectory, { recursive: true });
        fs.writeFileSync(layout.link, "0.6.4", { mode: 0o755 });
        placeDownload("0.6.5");
        install("0.6.5", "0.6.4", layout.link);
        expect(fs.lstatSync(layout.link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(layout.link, "utf-8")).toBe("0.6.5");
        expect(fs.readFileSync(versionBinaryPath(layout, "0.6.4"), "utf-8")).toBe("0.6.4");
        expect(fs.statSync(versionBinaryPath(layout, "0.6.4")).mode & 0o111).not.toBe(0);
    });

    test("a missing download fails and leaves the link on a working file", () => {
        addVersion("0.6.4");
        pointLinkAt("0.6.4");
        expect(failureOf(() => install("0.6.5")).code).toBe(UpdateErrorCode.RenameFailed);
        expect(fs.readFileSync(layout.link, "utf-8")).toBe("0.6.4");
    });

    test("a plain file stays usable when conversion fails", () => {
        fs.mkdirSync(layout.binDirectory, { recursive: true });
        fs.writeFileSync(layout.link, "0.6.4");
        placeDownload("0.6.5");
        const failingEnvironment: UnixSwapEnvironment = {
            ...environment,
            fsyncFile: () => { throw new Error("disk error"); },
        };
        const error = failureOf(() => installVersion(
            { layout, plainFileToConvert: layout.link, newVersion: "0.6.5", runningVersion: "0.6.4" },
            failingEnvironment,
        ));
        expect(error.code).toBe(UpdateErrorCode.RenameFailed);
        expect(fs.readFileSync(layout.link, "utf-8")).toBe("0.6.4");
    });
});

describeOnUnix("rollbackUnixVersion", () => {
    beforeEach(() => {
        addVersion("0.6.4");
        addVersion("0.6.5");
        pointLinkAt("0.6.5");
    });

    test("picks the next version down, writes the field, and removes the version it left", () => {
        expect(rollbackUnixVersion(layout, environment)).toEqual({ from: "0.6.5", to: "0.6.4" });
        expect(readLinkVersion(layout)).toBe("0.6.4");
        expect(readUpdateState().rolledBackFromVersion).toBe("0.6.5");
        expect(versions()).toEqual(["0.6.4"]);
    });

    test("keeps the version a live daemon reports", () => {
        daemonVersion = "0.6.5";
        rollbackUnixVersion(layout, environment);
        expect(versions()).toEqual(["0.6.4", "0.6.5"]);
    });

    test("with no lower version there is nothing to go back to", () => {
        rollbackUnixVersion(layout, environment);
        expect(failureOf(() => rollbackUnixVersion(layout, environment)).code).toBe(UpdateErrorCode.NothingToRollBack);
    });

    test("a plain file has nothing to go back to", () => {
        fs.rmSync(layout.link);
        fs.writeFileSync(layout.link, "plain");
        expect(failureOf(() => rollbackUnixVersion(layout, environment)).code).toBe(UpdateErrorCode.NothingToRollBack);
    });
});

describeOnUnix("pruneVersions", () => {
    beforeEach(() => {
        for (const version of ["0.6.2", "0.6.3", "0.6.4", "0.6.5"]) addVersion(version);
        pointLinkAt("0.6.5");
    });

    test("keeps the target and the next highest", () => {
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.4", "0.6.5"]);
    });

    test("keeps the version a live daemon reports", () => {
        daemonVersion = "0.6.2";
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.2", "0.6.4", "0.6.5"]);
    });

    test("keeps a version the service entry names", () => {
        serviceEntry = `ExecStart=${versionBinaryPath(layout, "0.6.3")} --_daemon-child`;
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.3", "0.6.4", "0.6.5"]);
    });

    test("a service entry naming the link keeps nothing extra", () => {
        serviceEntry = `ExecStart=${layout.link} --_daemon-child`;
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.4", "0.6.5"]);
    });

    test("leaves a name that is not a version alone", () => {
        fs.mkdirSync(path.join(layout.versionsDirectory, "backup"));
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.4", "0.6.5", "backup"]);
    });

    test("deletes a download whose pid is dead and keeps one whose pid is alive", () => {
        alivePids = [11];
        fs.writeFileSync(path.join(layout.versionsDirectory, "pinggy.download.11"), "x");
        fs.writeFileSync(path.join(layout.versionsDirectory, "pinggy.download.22"), "x");
        fs.writeFileSync(path.join(layout.binDirectory, "pinggy.link.22"), "x");
        pruneVersions(layout, environment);
        expect(versions()).toContain("pinggy.download.11");
        expect(versions()).not.toContain("pinggy.download.22");
        expect(fs.existsSync(path.join(layout.binDirectory, "pinggy.link.22"))).toBe(false);
    });

    test("does nothing to versions when the link names none", () => {
        fs.rmSync(layout.link);
        fs.writeFileSync(layout.link, "plain");
        pruneVersions(layout, environment);
        expect(versions()).toEqual(["0.6.2", "0.6.3", "0.6.4", "0.6.5"]);
    });
});

describeOnUnix("removeStaleUnixFiles", () => {
    test("is safe before the layout exists", () => {
        expect(() => removeStaleUnixFiles(layout, environment)).not.toThrow();
    });
});
