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
