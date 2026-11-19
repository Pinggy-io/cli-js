import { logger } from "../../logger.js";
import { Envelope, response } from "../envelope.js";
import {
    ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PAYLOAD, ERROR_UNSUPPORTED_OP,
    FileListRequestSchema, FileListResult, OP_LIST, fileError,
} from "./file_schema.js";
import { FileListDependencies, listFolder, machineFileListDependencies, withTimeout } from "./fileList.js";

/**
 * The `file` channel. Answers every request on its own id and op, and never throws.
 *
 * Off until a `welcome` says `file_manager_enabled: true`. A dashboard that predates the file manager
 * sends no such field, and every request is then refused with `file_manager_disabled`.
 *
 * A `list` gets {@link DEFAULT_LIST_TIMEOUT_MILLIS}. A folder on a network drive that stopped answering
 * can block its read forever, so the request is answered `file_timeout` and the read, if it ever
 * finishes, is dropped.
 *
 * Log lines carry the op, the id and the outcome, never a path: paths are the user's data.
 */

const DEFAULT_LIST_TIMEOUT_MILLIS = 20_000;

/** The payload's own bytes inside a frame measured with `null` as its payload. */
const NULL_PAYLOAD_BYTES = Buffer.byteLength("null", "utf8");

export interface FileHandlerDependencies {
    send(frame: Envelope): void;
    fileList?: FileListDependencies;
    listTimeoutMillis?: number;
}

export class FileHandler {
    private enabled = false;
    private maxFrameBytes = 0;

    constructor(private readonly dependencies: FileHandlerDependencies) {}

    /** From each `welcome`. `max_frame_bytes` is the dashboard's cap on 1 frame from this agent. */
    configure(fileManagerEnabled: boolean | undefined, maxFrameBytes: number): void {
        this.enabled = fileManagerEnabled === true;
        this.maxFrameBytes = maxFrameBytes;
    }

    async handle(envelope: Envelope): Promise<void> {
        if (envelope.kind !== "req") {
            return;
        }
        if (envelope.op !== OP_LIST) {
            this.answer(envelope, fileError(ERROR_UNSUPPORTED_OP, `Unsupported operation: file/${envelope.op}`));
            return;
        }
        if (!this.enabled) {
            this.answer(envelope, fileError(ERROR_FILE_MANAGER_DISABLED, "The file manager is disabled."));
            return;
        }
        const parsed = FileListRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            this.answer(envelope, fileError(ERROR_INVALID_PAYLOAD, "The file request could not be read."));
            return;
        }

        const timeoutMillis = this.dependencies.listTimeoutMillis ?? DEFAULT_LIST_TIMEOUT_MILLIS;
        const timedOut = fileError(ERROR_FILE_TIMEOUT,
            `The folder took longer than ${Math.round(timeoutMillis / 1000)} s to read.`);
        const listing = listFolder(parsed.data, this.payloadBudget(envelope),
            this.dependencies.fileList ?? machineFileListDependencies);
        this.answer(envelope, await withTimeout(listing, timeoutMillis, timedOut));
    }

    /** What is left of `max_frame_bytes` once the answer's envelope is counted. */
    private payloadBudget(envelope: Envelope): number {
        const envelopeBytes = Buffer.byteLength(JSON.stringify(response(envelope, envelope.op, null)), "utf8");
        return this.maxFrameBytes - (envelopeBytes - NULL_PAYLOAD_BYTES);
    }

    private answer(envelope: Envelope, result: FileListResult): void {
        logger.debug("Device agent file request", {
            op: envelope.op,
            id: envelope.id,
            outcome: "error" in result ? result.error.code : "listed",
        });
        // On whichever socket is live now, or nowhere. The browser times out on its own.
        this.dependencies.send(response(envelope, envelope.op, result));
    }
}
