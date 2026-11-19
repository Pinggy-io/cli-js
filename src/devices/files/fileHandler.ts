import { logger } from "../../logger.js";
import { Envelope, response } from "../envelope.js";
import {
    ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_TIMEOUT, ERROR_INVALID_PAYLOAD, ERROR_UNSUPPORTED_OP, FileError,
    FileListRequestSchema, FileListResult, FileStatRequestSchema, FileStatResult, OP_LIST, OP_STAT, fileError,
} from "./file_schema.js";
import { listFolder } from "./fileList.js";
import { statPath } from "./fileStat.js";
import { FileSystemDependencies, machineFileSystemDependencies, withTimeout } from "./fileSystem.js";

/**
 * The `file` channel: `list` and `stat`. Answers every request on its own id and op, and never throws.
 *
 * Off until a `welcome` says `file_manager_enabled: true`. A dashboard that predates the file manager
 * sends no such field, and every request is then refused with `file_manager_disabled`.
 *
 * Each request gets {@link DEFAULT_READ_TIMEOUT_MILLIS}. A path on a network drive that stopped answering
 * can block its read forever, so the request is answered `file_timeout` and the read, if it ever
 * finishes, is dropped.
 *
 * Log lines carry the op, the id and the outcome, never a path: paths are the user's data.
 */

const DEFAULT_READ_TIMEOUT_MILLIS = 20_000;
const MILLIS_PER_SECOND = 1000;

/** The payload's own bytes inside a frame measured with `null` as its payload. */
const NULL_PAYLOAD_BYTES = Buffer.byteLength("null", "utf8");

const OUTCOME_ANSWERED = "answered";

type FileResult = FileListResult | FileStatResult;

export interface FileHandlerDependencies {
    send(frame: Envelope): void;
    fileSystem?: FileSystemDependencies;
    readTimeoutMillis?: number;
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
        if (envelope.op !== OP_LIST && envelope.op !== OP_STAT) {
            this.answer(envelope, fileError(ERROR_UNSUPPORTED_OP, `Unsupported operation: file/${envelope.op}`));
            return;
        }
        if (!this.enabled) {
            this.answer(envelope, fileError(ERROR_FILE_MANAGER_DISABLED, "The file manager is disabled."));
            return;
        }
        const answer = envelope.op === OP_LIST ? this.list(envelope) : this.stat(envelope);
        this.answer(envelope, await answer);
    }

    private list(envelope: Envelope): Promise<FileResult> {
        const parsed = FileListRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        const listing = listFolder(parsed.data, this.payloadBudget(envelope), this.fileSystem());
        return withTimeout<FileResult>(listing, this.readTimeoutMillis(), this.timedOut("The folder"));
    }

    private stat(envelope: Envelope): Promise<FileResult> {
        const parsed = FileStatRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        const details = statPath(parsed.data, this.payloadBudget(envelope), this.fileSystem());
        return withTimeout<FileResult>(details, this.readTimeoutMillis(), this.timedOut("The path"));
    }

    private fileSystem(): FileSystemDependencies {
        return this.dependencies.fileSystem ?? machineFileSystemDependencies;
    }

    private readTimeoutMillis(): number {
        return this.dependencies.readTimeoutMillis ?? DEFAULT_READ_TIMEOUT_MILLIS;
    }

    /** "The folder took longer than 20 s to read." */
    private timedOut(subject: string): FileError {
        const seconds = Math.round(this.readTimeoutMillis() / MILLIS_PER_SECOND);
        return fileError(ERROR_FILE_TIMEOUT, `${subject} took longer than ${seconds} s to read.`);
    }

    /** What is left of `max_frame_bytes` once the answer's envelope is counted. */
    private payloadBudget(envelope: Envelope): number {
        const envelopeBytes = Buffer.byteLength(JSON.stringify(response(envelope, envelope.op, null)), "utf8");
        return this.maxFrameBytes - (envelopeBytes - NULL_PAYLOAD_BYTES);
    }

    private answer(envelope: Envelope, result: FileResult): void {
        logger.debug("Device agent file request", {
            op: envelope.op,
            id: envelope.id,
            outcome: "error" in result ? result.error.code : OUTCOME_ANSWERED,
        });
        // On whichever socket is live now, or nowhere. The browser times out on its own.
        this.dependencies.send(response(envelope, envelope.op, result));
    }
}

function invalidPayload(): FileError {
    return fileError(ERROR_INVALID_PAYLOAD, "The file request could not be read.");
}
