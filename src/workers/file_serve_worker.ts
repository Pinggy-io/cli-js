import { parentPort, workerData } from "worker_threads";
import { FileServerError, startFileServer } from "../utils/FileServer.js";
import { logger } from "../logger.js";

(async () => {
    try {
        const { dir, port } = workerData;
        const portNum = parseInt(port.split(":")[1]);
        const result = await startFileServer(dir, portNum);
        parentPort?.postMessage({ type: "started", portNum });
        if (result.hasInvalidPath && result.error) {
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
