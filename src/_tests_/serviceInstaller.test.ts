import { describe, test, expect } from "@jest/globals";
import { generateLauncherVbs, generateTaskXml } from "../daemon/lifecycle/serviceInstaller.js";

describe("generateLauncherVbs", () => {
    test("pkg binary: runs pinggy.exe hidden and waits for it", () => {
        const vbs = generateLauncherVbs({ program: "C:\\Program Files\\Pinggy\\pinggy.exe", args: [] });
        expect(vbs).toContain(
            'WScript.Quit shell.Run("""C:\\Program Files\\Pinggy\\pinggy.exe"" --_daemon-child", 0, True)'
        );
    });

    test("npm install: runs node.exe with the CLI script", () => {
        const vbs = generateLauncherVbs({
            program: "C:\\Program Files\\nodejs\\node.exe",
            args: ["C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@pinggy\\cli\\dist\\index.cjs"],
        });
        expect(vbs).toContain(
            'shell.Run("""C:\\Program Files\\nodejs\\node.exe"" ' +
            '""C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@pinggy\\cli\\dist\\index.cjs"" --_daemon-child", 0, True)'
        );
    });
});

describe("generateTaskXml", () => {
    test("runs wscript with the launcher path escaped for XML", () => {
        const xml = generateTaskXml("C:\\Users\\Tom & Jerry\\AppData\\Roaming\\pinggy\\pinggy-daemon.vbs");
        expect(xml).toContain("<Command>%SystemRoot%\\System32\\wscript.exe</Command>");
        expect(xml).toContain(
            "<Arguments>//B //Nologo &quot;C:\\Users\\Tom &amp; Jerry\\AppData\\Roaming\\pinggy\\pinggy-daemon.vbs&quot;</Arguments>"
        );
    });
});
