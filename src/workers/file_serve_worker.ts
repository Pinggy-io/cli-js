import { parentPort, workerData } from "worker_threads";
import { FileServerError, startFileServer } from "../utils/FileServer.js";
import { logger } from "../logger.js";
import { FileServerMessage, FileServerWorkerMessage } from "./fileServerMessages.js";

function post(msg: FileServerWorkerMessage): void {
    parentPort?.postMessage(msg);
}

void (async () => {
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
        post({ type: FileServerMessage.Started, portNum });
        if (result.hasInvalidPath && result.error) {
            logger.warn("file_serve_worker invalid path warning", { message: result.error.message, code: result.error.code });
            post({
                type: FileServerMessage.Warning,
                message: result.error.message,
                code: result.error.code,
            });
        }



    } catch (err) {
        console.log(err);
        if (err instanceof FileServerError) {
            post({ type: FileServerMessage.Error, error: err.message, code: err.code });
        } else if (err instanceof Error) {
            post({ type: FileServerMessage.Error, error: err.message });
        } else {
            post({ type: FileServerMessage.Error, error: String(err) });
        }
        logger.debug("Error in FileServer thread", err);
        process.exit(1);
    }
})();
