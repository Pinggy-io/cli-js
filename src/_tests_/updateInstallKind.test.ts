import { describe, expect, test } from "@jest/globals";
import { detectInstallKind, InstallKind, InstallProbe } from "../update/installKind.js";

const HOME = "/home/me";

function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
    return {
        isPackaged: true,
        isElectron: false,
        platform: "linux",
        execPath: `${HOME}/.pinggy/versions/0.6.5/pinggy`,
        scriptRealPath: "/snapshot/app/dist/index.cjs",
        homeRealPath: HOME,
        directoryIsWritable: () => true,
        ...overrides,
    };
}

describe("detectInstallKind", () => {
    test("rule 1: an Electron host counts as npm", () => {
        expect(detectInstallKind(probe({ isPackaged: false, isElectron: true }))).toBe(InstallKind.Npm);
    });

    test("rule 2: a script under node_modules counts as npm", () => {
        const script = "/usr/lib/node_modules/pinggy/dist/index.cjs";
        expect(detectInstallKind(probe({ isPackaged: false, scriptRealPath: script }))).toBe(InstallKind.Npm);
    });

    test("rule 3: any other unpackaged run is a dev checkout", () => {
        const script = "/work/cli-js/dist/index.cjs";
        expect(detectInstallKind(probe({ isPackaged: false, scriptRealPath: script }))).toBe(InstallKind.DevCheckout);
    });

    test("a folder merely containing node_modules in its name is not npm", () => {
        const script = "/work/my_node_modules_copy/dist/index.cjs";
        expect(detectInstallKind(probe({ isPackaged: false, scriptRealPath: script }))).toBe(InstallKind.DevCheckout);
    });

    test("rule 4: Windows with a writable folder", () => {
        const windows = probe({ platform: "win32", execPath: "C:\\Users\\me\\Downloads\\pinggy.exe" });
        expect(detectInstallKind(windows)).toBe(InstallKind.WindowsWritable);
    });

    test("rule 5: Windows with a read-only folder", () => {
        const windows = probe({
            platform: "win32",
            execPath: "C:\\Program Files\\pinggy\\pinggy.exe",
            directoryIsWritable: () => false,
        });
        expect(detectInstallKind(windows)).toBe(InstallKind.WindowsReadOnly);
    });

    test("rule 6: a binary under the versions folder", () => {
        expect(detectInstallKind(probe())).toBe(InstallKind.UnixLayout);
    });

    test("rule 7: a plain file at the link path", () => {
        expect(detectInstallKind(probe({ execPath: `${HOME}/.pinggy/bin/pinggy` }))).toBe(InstallKind.UnixPlainFile);
    });

    test("rule 8: anything else only gets a hint", () => {
        expect(detectInstallKind(probe({ execPath: `${HOME}/Downloads/pinggy` }))).toBe(InstallKind.UnixLoose);
        expect(detectInstallKind(probe({ execPath: "/usr/local/bin/pinggy" }))).toBe(InstallKind.UnixLoose);
    });

    test("a home reached through a symlink still matches, because the probe holds its real path", () => {
        const realHome = "/Volumes/data/me";
        const layoutProbe = probe({ homeRealPath: realHome, execPath: `${realHome}/.pinggy/versions/0.6.5/pinggy` });
        expect(detectInstallKind(layoutProbe)).toBe(InstallKind.UnixLayout);
    });

    test("a path that only starts like the versions folder is loose", () => {
        expect(detectInstallKind(probe({ execPath: `${HOME}/.pinggy/versions-old/pinggy` }))).toBe(InstallKind.UnixLoose);
    });
});
