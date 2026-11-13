import { describe, expect, test } from "@jest/globals";
import { serviceInstallRefusal, ServiceInstallContext } from "../daemon/lifecycle/serviceInstaller.js";

function npmContext(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): ServiceInstallContext {
    return { platform, isPkg: false, execPath: "/usr/local/bin/node", home: "/home/user", env };
}

describe("serviceInstallRefusal for the npm version", () => {
    // The installer updates an npm copy with npm, so the install command alone would bring the user back here.
    test("removes the npm copy before the install command", () => {
        expect(serviceInstallRefusal(npmContext("linux"))?.split("\n")).toEqual([
            "The npm version of pinggy cannot run as a service.",
            "Remove it, install pinggy with the Pinggy installer, then run this command again:",
            "  npm uninstall -g pinggy",
            "  curl -fsSL https://pinggy.io/install.sh | sh",
            "  pinggy daemon service-install",
        ]);
    });

    test("names the PowerShell install command on Windows", () => {
        expect(serviceInstallRefusal(npmContext("win32"))).toContain("  irm https://pinggy.io/install.ps1 | iex");
    });

    test("PINGGY_SERVICE_ANY_LOCATION does not allow the npm version", () => {
        const refusal = serviceInstallRefusal(npmContext("darwin", { PINGGY_SERVICE_ANY_LOCATION: "1" }));
        expect(refusal).toContain("npm uninstall -g pinggy");
    });
});

describe("serviceInstallRefusal for a downloaded binary", () => {
    const downloaded: ServiceInstallContext = {
        platform: "linux", isPkg: true, execPath: "/home/user/Downloads/pinggy", home: "/home/user", env: {},
    };

    // A downloaded binary can install itself and then run the command the user typed.
    test("names the installed copy when one exists", () => {
        expect(serviceInstallRefusal(downloaded, (filePath) => filePath === "/home/user/.pinggy/bin/pinggy")?.split("\n")).toEqual([
            "This pinggy is not the installed one. Run this command with the installed copy:",
            "  /home/user/.pinggy/bin/pinggy daemon service-install",
        ]);
    });

    test("names the install command when none exists", () => {
        expect(serviceInstallRefusal(downloaded, () => false)).toContain("  curl -fsSL https://pinggy.io/install.sh | sh");
    });
});
