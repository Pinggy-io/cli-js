import { logger } from "../../logger.js";
import { Envelope, event, response } from "../envelope.js";
import {
    CHANNEL_FILE, ERROR_FILE_BUSY, ERROR_FILE_MANAGER_DISABLED, ERROR_FILE_OPERATION_FAILED, ERROR_FILE_TIMEOUT,
    ERROR_INVALID_PAYLOAD,
    ERROR_UNSUPPORTED_OP, FileCopyRequest, FileCopyRequestSchema, FileCopyResult, FileDeleteRequest,
    FileDeleteRequestSchema, FileDeleteResult, FileError, FileListRequestSchema, FileListResult,
    FileMkdirRequestSchema, FileMkdirResult, FileProgress, FileStatRequestSchema, FileStatResult, OP_COPY,
    OP_DELETE, OP_LIST, OP_MKDIR, OP_PROGRESS, OP_STAT, fileError,
} from "./file_schema.js";
import { FileCallGate, gatedCopier, gatedMaker, gatedReader, gatedRemover } from "./fileCallGate.js";
import { CopyDependencies, prepareCopy, randomHiddenNameSuffix, runCopy } from "./fileCopy.js";
import { DeleteDependencies, prepareDelete, runDelete } from "./fileDelete.js";
import { listFolder } from "./fileList.js";
import { makeFolder } from "./fileMkdir.js";
import { ProtectedSources, machineProtectedSources } from "./fileProtectedPaths.js";
import { statPath } from "./fileStat.js";
import {
    FileSystemCopier, FileSystemDependencies, FileSystemMaker, FileSystemRemover, errorCodeOf,
    machineFileSystemCopier, machineFileSystemDependencies, machineFileSystemMaker, machineFileSystemRemover,
    withTimeout,
} from "./fileSystem.js";

/**
 * The `file` channel: `list`, `stat`, `delete`, `mkdir` and `copy`. Answers every request on its own id and op,
 * and never throws.
 *
 * Off until a `welcome` says `file_manager_enabled: true`. A dashboard that predates the file manager
 * sends no such field, and every request is then refused with `file_manager_disabled`.
 *
 * A `list` or `stat` gets {@link DEFAULT_READ_TIMEOUT_MILLIS} in all. A path on a network drive that
 * stopped answering can block its read forever, so the request is answered `file_timeout` and the read,
 * if it ever finishes, is dropped.
 *
 * A `delete` or a `copy` has no limit in all, since a large tree takes minutes. Each of its filesystem calls
 * gets {@link DEFAULT_DELETE_CALL_TIMEOUT_MILLIS} or {@link DEFAULT_COPY_CALL_TIMEOUT_MILLIS} instead: for a
 * copy, a read or a write of 1 piece is 1 call. Copies and deletes share `file_max_concurrent_operations`
 * slots from the last `welcome`, and 1 more answers `file_busy`. While 1 runs, `progress` goes out on its id:
 * 1 once its checks pass, then on each tick when a count changed, and every {@link PROGRESS_KEEPALIVE_TICKS}
 * ticks regardless, so the browser's 30 s timer never runs out on a slow call. No `progress` follows the
 * answer. Either outlives the socket it came on: it lives for the whole agent run.
 *
 * A `mkdir` is 1 call with {@link DEFAULT_MKDIR_TIMEOUT_MILLIS}, and takes no slot: 3 running deletes do not
 * block it.
 *
 * Every filesystem call of every op goes through 1 {@link FileCallGate} of {@link DEFAULT_FILE_CALL_PLACES}
 * places, so the file manager holds at most 2 of Node's 4 worker threads however many drives hang.
 *
 * Log lines carry the op, the id and the outcome, never a path: paths are the user's data.
 */

const DEFAULT_READ_TIMEOUT_MILLIS = 20_000;
const DEFAULT_DELETE_CALL_TIMEOUT_MILLIS = 20_000;
const DEFAULT_MKDIR_TIMEOUT_MILLIS = 20_000;
const DEFAULT_COPY_CALL_TIMEOUT_MILLIS = 20_000;
/** 2 of Node's 4 worker threads, so DNS lookups, config and log writes keep the other 2. */
const DEFAULT_FILE_CALL_PLACES = 2;
const MILLIS_PER_SECOND = 1000;

const PROGRESS_TICK_MILLIS = 1000;
const PROGRESS_KEEPALIVE_TICKS = 5;

/** The payload's own bytes inside a frame measured with `null` as its payload. */
const NULL_PAYLOAD_BYTES = Buffer.byteLength("null", "utf8");

const OUTCOME_ANSWERED = "answered";

type FileResult = FileListResult | FileStatResult | FileDeleteResult | FileMkdirResult | FileCopyResult;

const HANDLED_OPS: ReadonlySet<string> = new Set([OP_LIST, OP_STAT, OP_DELETE, OP_MKDIR, OP_COPY]);

export interface FileHandlerDependencies {
    send(frame: Envelope): void;
    fileSystem?: FileSystemDependencies;
    readTimeoutMillis?: number;
    remover?: FileSystemRemover;
    protectedSources?: ProtectedSources;
    deleteCallTimeoutMillis?: number;
    maker?: FileSystemMaker;
    mkdirTimeoutMillis?: number;
    copier?: FileSystemCopier;
    copyCallTimeoutMillis?: number;
    /** 8 hex digits for `replace`'s hidden names. */
    hiddenNameSuffix?: () => string;
    fileCallPlaces?: number;
}

export class FileHandler {
    private enabled = false;
    private maxFrameBytes = 0;
    private maxConcurrentOperations = 0;
    private runningOperations = 0;
    private readonly gatedFileSystem: FileSystemDependencies;
    private readonly gatedRemover: FileSystemRemover;
    private readonly gatedMaker: FileSystemMaker;
    private readonly gatedCopier: FileSystemCopier;

    constructor(private readonly dependencies: FileHandlerDependencies) {
        const gate = new FileCallGate(dependencies.fileCallPlaces ?? DEFAULT_FILE_CALL_PLACES);
        const fileSystem = dependencies.fileSystem ?? machineFileSystemDependencies;
        this.gatedFileSystem = {
            platform: fileSystem.platform,
            fs: gatedReader(fileSystem.fs, gate, this.readTimeoutMillis()),
        };
        this.gatedRemover = gatedRemover(dependencies.remover ?? machineFileSystemRemover, gate,
            this.deleteCallTimeoutMillis());
        this.gatedMaker = gatedMaker(dependencies.maker ?? machineFileSystemMaker, gate, this.mkdirTimeoutMillis());
        this.gatedCopier = gatedCopier(dependencies.copier ?? machineFileSystemCopier, gate,
            this.copyCallTimeoutMillis());
    }

    /**
     * From each `welcome`. `max_frame_bytes` is the dashboard's cap on 1 frame from this agent. Without
     * `file_max_concurrent_operations`, no delete or copy runs.
     */
    configure(fileManagerEnabled: boolean | undefined, maxFrameBytes: number,
              maxConcurrentOperations?: number): void {
        this.enabled = fileManagerEnabled === true;
        this.maxFrameBytes = maxFrameBytes;
        this.maxConcurrentOperations = maxConcurrentOperations ?? 0;
    }

    async handle(envelope: Envelope): Promise<void> {
        if (envelope.kind !== "req") {
            return;
        }
        if (!HANDLED_OPS.has(envelope.op)) {
            this.answer(envelope, fileError(ERROR_UNSUPPORTED_OP, `Unsupported operation: file/${envelope.op}`));
            return;
        }
        if (!this.enabled) {
            this.answer(envelope, fileError(ERROR_FILE_MANAGER_DISABLED, "The file manager is disabled."));
            return;
        }
        this.answer(envelope, await this.run(envelope));
    }

    private run(envelope: Envelope): Promise<FileResult> {
        switch (envelope.op) {
            case OP_LIST:
                return this.list(envelope);
            case OP_STAT:
                return this.stat(envelope);
            case OP_MKDIR:
                return this.mkdir(envelope);
            case OP_COPY:
                return this.copy(envelope);
            default:
                return this.delete(envelope);
        }
    }

    private list(envelope: Envelope): Promise<FileResult> {
        const parsed = FileListRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        const listing = afterThisTurn(() => listFolder(parsed.data, this.payloadBudget(envelope), this.fileSystem()));
        return withTimeout<FileResult>(listing, this.readTimeoutMillis(), this.timedOut("The folder"));
    }

    private stat(envelope: Envelope): Promise<FileResult> {
        const parsed = FileStatRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        const details = afterThisTurn(() => statPath(parsed.data, this.payloadBudget(envelope), this.fileSystem()));
        return withTimeout<FileResult>(details, this.readTimeoutMillis(), this.timedOut("The path"));
    }

    private mkdir(envelope: Envelope): Promise<FileResult> {
        const parsed = FileMkdirRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        return makeFolder(parsed.data, {
            maker: this.gatedMaker,
            platform: this.fileSystem().platform,
            callTimeoutMillis: this.mkdirTimeoutMillis(),
        });
    }

    private delete(envelope: Envelope): Promise<FileResult> {
        const parsed = FileDeleteRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        return this.inSlot(envelope, "delete", () => this.deleteInSlot(envelope, parsed.data));
    }

    private copy(envelope: Envelope): Promise<FileResult> {
        const parsed = FileCopyRequestSchema.safeParse(envelope.payload);
        if (!parsed.success) {
            return Promise.resolve(invalidPayload());
        }
        return this.inSlot(envelope, "copy", () => this.copyInSlot(envelope, parsed.data));
    }

    /** Holds 1 slot from here to the answer. */
    private async inSlot(envelope: Envelope, operation: string, work: () => Promise<FileResult>): Promise<FileResult> {
        if (this.runningOperations >= this.maxConcurrentOperations) {
            return busy(this.maxConcurrentOperations);
        }
        this.runningOperations += 1;
        try {
            return await work();
        } catch (err) {
            // The op answers every failure itself. This keeps a bug from becoming an unhandled rejection.
            logger.warn(`Device agent file ${operation} stopped`, { id: envelope.id, code: errorCodeOf(err) });
            return fileError(ERROR_FILE_OPERATION_FAILED, `The ${operation} stopped unexpectedly.`);
        } finally {
            this.runningOperations -= 1;
        }
    }

    /** A refusal from the checks sends no `progress`: nothing was deleted, and the answer comes at once. */
    private async deleteInSlot(envelope: Envelope, request: FileDeleteRequest): Promise<FileResult> {
        const dependencies = this.deleteDependencies();
        const prepared = await prepareDelete(request, dependencies);
        if ("error" in prepared) {
            return prepared;
        }
        const progress: FileProgress = {
            items_done: 0, items_total: prepared.names.length, files_done: 0, current_name: prepared.names[0],
        };
        const stopProgress = this.startProgress(envelope, progress);
        try {
            return await runDelete(prepared, progress, dependencies, this.payloadBudget(envelope));
        } finally {
            stopProgress();
        }
    }

    /**
     * A refusal from the checks sends no `progress`: nothing was copied, and the answer comes at once. `progress`
     * starts before the count, so a large tree keeps the browser's timer alive while it is counted, and a
     * `no_space` answer follows it.
     */
    private async copyInSlot(envelope: Envelope, request: FileCopyRequest): Promise<FileResult> {
        const dependencies = this.copyDependencies();
        const payloadBudget = this.payloadBudget(envelope);
        const prepared = await prepareCopy(request, dependencies, payloadBudget);
        if ("error" in prepared) {
            return prepared;
        }
        const progress: FileProgress = {
            items_done: 0, items_total: prepared.names.length, files_done: 0, bytes_done: 0,
            current_name: prepared.names[0],
        };
        const stopProgress = this.startProgress(envelope, progress);
        try {
            return await runCopy(prepared, progress, dependencies, payloadBudget);
        } finally {
            stopProgress();
        }
    }

    /** Sends 1 `progress` now, then from a timer. Returns the stop, which the answer waits for. */
    private startProgress(envelope: Envelope, progress: FileProgress): () => void {
        let lastSent = this.sendProgress(envelope, progress);
        let ticksSinceSent = 0;
        const timer = setInterval(() => {
            ticksSinceSent += 1;
            if (sameProgress(progress, lastSent) && ticksSinceSent < PROGRESS_KEEPALIVE_TICKS) {
                return;
            }
            lastSent = this.sendProgress(envelope, progress);
            ticksSinceSent = 0;
        }, PROGRESS_TICK_MILLIS);
        return () => clearInterval(timer);
    }

    /** Sends a snapshot, since the op keeps counting into `progress`. Returns the snapshot sent. */
    private sendProgress(envelope: Envelope, progress: FileProgress): FileProgress {
        const snapshot = { ...progress };
        this.dependencies.send(event(CHANNEL_FILE, OP_PROGRESS, snapshot, envelope.id));
        return snapshot;
    }

    private deleteDependencies(): DeleteDependencies {
        return {
            remover: this.gatedRemover,
            platform: this.fileSystem().platform,
            protectedSources: this.dependencies.protectedSources ?? machineProtectedSources(),
            callTimeoutMillis: this.deleteCallTimeoutMillis(),
        };
    }

    private copyDependencies(): CopyDependencies {
        return {
            ...this.deleteDependencies(),
            copier: this.gatedCopier,
            hiddenNameSuffix: this.dependencies.hiddenNameSuffix ?? randomHiddenNameSuffix,
        };
    }

    private fileSystem(): FileSystemDependencies {
        return this.gatedFileSystem;
    }

    private deleteCallTimeoutMillis(): number {
        return this.dependencies.deleteCallTimeoutMillis ?? DEFAULT_DELETE_CALL_TIMEOUT_MILLIS;
    }

    private copyCallTimeoutMillis(): number {
        return this.dependencies.copyCallTimeoutMillis ?? DEFAULT_COPY_CALL_TIMEOUT_MILLIS;
    }

    private mkdirTimeoutMillis(): number {
        return this.dependencies.mkdirTimeoutMillis ?? DEFAULT_MKDIR_TIMEOUT_MILLIS;
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

/**
 * Starts `work` once the caller's code has run, so a timer the caller sets now starts before the gate's timers for
 * the calls inside. Both have the same limit, so on a hang the request's own "took longer" answer is the one sent.
 */
function afterThisTurn<T>(work: () => Promise<T>): Promise<T> {
    return Promise.resolve().then(work);
}

function sameProgress(left: FileProgress, right: FileProgress): boolean {
    return left.items_done === right.items_done && left.files_done === right.files_done
        && left.bytes_done === right.bytes_done && left.files_total === right.files_total
        && left.bytes_total === right.bytes_total && left.current_name === right.current_name;
}

function invalidPayload(): FileError {
    return fileError(ERROR_INVALID_PAYLOAD, "The file request could not be read.");
}

/** "The device is already running 3 file operations." Without a limit from `welcome`, none runs. */
function busy(limit: number): FileError {
    if (limit <= 0) {
        return fileError(ERROR_FILE_BUSY, "The dashboard allows no file operations on this device.");
    }
    const noun = limit === 1 ? "file operation" : "file operations";
    return fileError(ERROR_FILE_BUSY, `The device is already running ${limit} ${noun}.`);
}
