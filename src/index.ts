#!/usr/bin/env node

import {
    hasVCRedist,
    getVCRedistMessage,
    openDownloadPage,
} from "./utils/detect_vc_redist_on_windows.js";
import CLIPrinter from "./utils/printer.js";

async function verifyAndLoad() {
    if (process.platform === "win32" && !hasVCRedist()) {
        const msg = getVCRedistMessage();

        CLIPrinter.warn(msg?.title || "Missing Microsoft Visual C++ Runtime" );
        CLIPrinter.warn(
            msg?.message ??
            "This application requires the Microsoft Visual C++ Runtime on Windows."
        );
        CLIPrinter.info(`Download url -> ${msg?.downloadUrl|| "https://aka.ms/vc14/vc_redist.x64.exe"}`);

        // open browser
        openDownloadPage();

        process.exit(1);
    }

    await import("./main.js");
}

verifyAndLoad().catch((err) => {
    CLIPrinter.error(`Failed to start CLI:, ${err}`);
    process.exit(1);
});
