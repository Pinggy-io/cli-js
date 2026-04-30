import { parentPort, workerData } from "worker_threads";
import { FileServerError, startFileServer } from "../utils/FileServer.js";
import { logger } from "../logger.js";

(async () => {
    try {
        const { dir, forwarding } = workerData;
        logger.debug("file_serve_worker received workerData", { dir, forwarding: JSON.stringify(forwarding) });

        let address: string | undefined;
        if (typeof forwarding === "string") {
            address = forwarding;
        } else if (Array.isArray(forwarding) && forwarding.length > 0) {
            address = forwarding[0]?.address;
        }
        logger.debug("file_serve_worker resolved address", { address });

        const match = typeof address === "string" ? address.match(/:(\d+)\/?$/) : null;
        const portNum = match ? parseInt(match[1], 10) : undefined;
        logger.debug("file_serve_worker resolved port", { portNum, defaultPort: portNum ?? 8080 });

        const result = await startFileServer(dir, portNum);
        logger.info("file_serve_worker static file server started", { dir, port: portNum ?? 8080 });
        parentPort?.postMessage({ type: "started", portNum });
        if (result.hasInvalidPath && result.error) {
            logger.warn("file_serve_worker invalid path warning", { message: result.error.message, code: result.error.code });
            parentPort?.postMessage({
                type: "warning",
                message: result.error.message,
                code: result.error.code,
            });
        }



    } catch (err) {
        console.log(err);
        if (err instanceof FileServerError) {
            parentPort?.postMessage({ type: "error", error: err.message, code: err.code });
        } else if (err instanceof Error) {
            parentPort?.postMessage({ type: "error", error: err.message });
        } else {
            parentPort?.postMessage({ type: "error", error: String(err) });
        }
        logger.debug("Error in FileServer thread", err);
        process.exit(1);
    }
})();
