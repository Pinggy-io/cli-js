import { describe, expect, test } from "@jest/globals";
import { findPinggyCommand, PathLookup, windowsCommandNames } from "../install/pinggyOnPath.js";

interface FakeFile {
    executable?: boolean;
    realPath?: string;
    link?: boolean;
}

function lookup(platform: NodeJS.Platform, pathValue: string, files: Record<string, FakeFile>, pathExtensions?: string): PathLookup {
    const known = (filePath: string): FakeFile | undefined => (platform === "win32"
        ? Object.entries(files).find(([name]) => name.toLowerCase() === filePath.toLowerCase())?.[1]
        : files[filePath]);
    return {
        platform,
        pathValue,
        pathExtensions,
        files: {
            isExecutableFile: (filePath) => {
                const file = known(filePath);
                return file !== undefined && !file.link && (platform === "win32" || file.executable !== false);
            },
            isFile: (filePath) => known(filePath) !== undefined && !known(filePath)?.link,
            realPath: (filePath) => (known(filePath) ? known(filePath)?.realPath ?? filePath : null),
            isLink: (filePath) => known(filePath)?.link === true,
        },
    };
}

describe("findPinggyCommand on macOS and Linux", () => {
    test("an npm copy names its global folder", () => {
        const found = findPinggyCommand(lookup("darwin", "/opt/homebrew/bin:/usr/bin", {
            "/opt/homebrew/bin/pinggy": { realPath: "/opt/homebrew/lib/node_modules/pinggy/dist/index.cjs" },
        }));
        expect(found).toEqual({
            commandPath: "/opt/homebrew/bin/pinggy",
            npm: { prefix: "/opt/homebrew", packageFolder: "/opt/homebrew/lib/node_modules/pinggy" },
        });
    });

    test.each([
        ["npm link", "/Users/me/cli-js/dist/index.cjs"],
        ["yarn", "/Users/me/.config/yarn/global/node_modules/pinggy/dist/index.cjs"],
        ["bun", "/Users/me/.bun/install/global/node_modules/pinggy/dist/index.cjs"],
        ["a downloaded binary", "/usr/local/bin/pinggy"],
    ])("%s is not an npm copy", (_name, realPath) => {
        const found = findPinggyCommand(lookup("linux", "/usr/local/bin", { "/usr/local/bin/pinggy": { realPath } }));
        expect(found).toEqual({ commandPath: "/usr/local/bin/pinggy", npm: null });
    });

    test("the current folder never counts, as an empty entry or as .", () => {
        const found = findPinggyCommand(lookup("linux", "::.:/opt/bin", { "pinggy": {}, "/opt/bin/pinggy": {} }));
        expect(found?.commandPath).toBe("/opt/bin/pinggy");
    });

    test("a file without the executable bit is skipped", () => {
        const found = findPinggyCommand(lookup("linux", "/a:/b", { "/a/pinggy": { executable: false }, "/b/pinggy": {} }));
        expect(found?.commandPath).toBe("/b/pinggy");
    });

    test("no pinggy on PATH", () => {
        expect(findPinggyCommand(lookup("linux", "/usr/bin", {}))).toBeNull();
    });
});

describe("findPinggyCommand on Windows", () => {
    const npmFolder = "C:\\Users\\me\\AppData\\Roaming\\npm";

    test("npm's launcher folder with the package beside it is an npm copy", () => {
        const found = findPinggyCommand(lookup("win32", `C:\\Windows;${npmFolder}`, {
            [`${npmFolder}\\pinggy.cmd`]: {},
            [`${npmFolder}\\node_modules\\pinggy\\package.json`]: {},
        }));
        expect(found).toEqual({
            commandPath: `${npmFolder}\\pinggy.cmd`,
            npm: { prefix: npmFolder, packageFolder: `${npmFolder}\\node_modules\\pinggy` },
        });
    });

    test("an npm link junction is not an npm copy", () => {
        const found = findPinggyCommand(lookup("win32", npmFolder, {
            [`${npmFolder}\\pinggy.cmd`]: {},
            [`${npmFolder}\\node_modules\\pinggy`]: { link: true },
            [`${npmFolder}\\node_modules\\pinggy\\package.json`]: {},
        }));
        expect(found?.npm).toBeNull();
    });

    test("PATHEXT order picks the .exe before the .cmd in 1 folder", () => {
        const found = findPinggyCommand(lookup("win32", "C:\\Tools", { "C:\\Tools\\pinggy.cmd": {}, "C:\\Tools\\pinggy.exe": {} }));
        expect(found).toEqual({ commandPath: "C:\\Tools\\pinggy.exe", npm: null });
    });

    test("cmd's current folder does not count", () => {
        const found = findPinggyCommand(lookup("win32", ".;C:\\Tools", { "pinggy.exe": {}, "C:\\Tools\\pinggy.exe": {} }));
        expect(found?.commandPath).toBe("C:\\Tools\\pinggy.exe");
    });

    test("PowerShell's .ps1 launcher counts after PATHEXT", () => {
        expect(windowsCommandNames("pinggy", ".EXE;.CMD")).toEqual(["pinggy.exe", "pinggy.cmd", "pinggy.ps1"]);
    });
});
