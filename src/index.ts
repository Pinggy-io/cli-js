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
        CLIPrinter.warn(
            msg?.message ??
            "This application requires the Microsoft Visual C++ Runtime on Windows."
        );

        // open browser
        await openDownloadPage();

        process.exit(1);
    }

    await import("./main.js");
}

verifyAndLoad().catch((err) => {
    CLIPrinter.error(`Failed to start CLI:, ${err}`);
    process.exit(1);
});
