import {
    FileCallTimeoutError, FileSystemCopier, FileSystemMaker, FileSystemReader, FileSystemRemover, callTimeoutError,
} from "./fileSystem.js";

/**
 * Every filesystem call the file manager makes goes through 1 gate, so it never holds more than `places` of
 * Node's 4 worker threads. A call blocks its thread until the disk answers, and a dead network drive can answer
 * never. The threads left over keep DNS lookups, config and log writes working, so the agent can still reconnect.
 *
 * A call waits in this queue, not in Node's, until a place frees. Its time limit starts when it joins the queue:
 * a call still waiting at its limit is dropped and never runs. A call running at its limit is abandoned, not
 * killed, since Node cannot stop it, and it keeps its place until the disk answers.
 *
 * While every place is held by an abandoned call, every call fails at once with {@link FileCallsStuckError},
 * without touching a disk, those waiting included. A delete then fails its remaining names in moments, not
 * 20 s each.
 */

export const MESSAGE_DRIVE_STOPPED = "A drive on the device stopped answering. Try again once it is back.";

/** Every place is held by an abandoned call. A timeout, so each op answers it as `file_timeout`. */
export class FileCallsStuckError extends FileCallTimeoutError {
    constructor() {
        super(MESSAGE_DRIVE_STOPPED);
    }
}

interface WaitingCall {
    begin(): void;
    refuse(err: Error): void;
}

export class FileCallGate {
    private running = 0;
    private abandoned = 0;
    /** In arrival order: a Set iterates as it was filled. */
    private readonly waiting = new Set<WaitingCall>();

    constructor(private readonly places: number) {
        if (!Number.isInteger(places) || places < 1) {
            throw new Error(`The file call gate needs at least 1 place, not ${places}.`);
        }
    }

    /** `work`'s outcome, or a {@link FileCallTimeoutError} once `timeoutMillis` pass from now. */
    run<T>(work: () => Promise<T>, timeoutMillis: number): Promise<T> {
        if (this.isStuck()) {
            return Promise.reject(new FileCallsStuckError());
        }
        return new Promise<T>((resolve, reject) => {
            let answered = false;
            let holdsPlace = false;
            let isAbandoned = false;
            const answer = (outcome: () => void) => {
                if (!answered) {
                    answered = true;
                    clearTimeout(timer);
                    outcome();
                }
            };
            const call: WaitingCall = {
                begin: () => {
                    holdsPlace = true;
                    this.running += 1;
                    let pending: Promise<T>;
                    try {
                        pending = work();
                    } catch (err) {
                        pending = Promise.reject(err);
                    }
                    pending.then((value) => answer(() => resolve(value)), (err: unknown) => answer(() => reject(err)))
                        .finally(() => this.release(isAbandoned));
                },
                refuse: (err) => answer(() => reject(err)),
            };
            const timer = setTimeout(() => {
                if (holdsPlace) {
                    isAbandoned = true;
                    this.abandoned += 1;
                } else {
                    this.waiting.delete(call);
                }
                answer(() => reject(callTimeoutError(timeoutMillis)));
                if (this.isStuck()) {
                    this.refuseWaiting();
                }
            }, timeoutMillis);

            if (this.running < this.places) {
                call.begin();
            } else {
                this.waiting.add(call);
            }
        });
    }

    private release(wasAbandoned: boolean): void {
        this.running -= 1;
        if (wasAbandoned) {
            this.abandoned -= 1;
        }
        for (const call of this.waiting) {
            if (this.running >= this.places) {
                return;
            }
            this.waiting.delete(call);
            call.begin();
        }
    }

    private isStuck(): boolean {
        return this.abandoned >= this.places;
    }

    private refuseWaiting(): void {
        const refused = [...this.waiting];
        this.waiting.clear();
        refused.forEach((call) => call.refuse(new FileCallsStuckError()));
    }
}

/** `reader` with each call through `gate`. `homedir` touches no disk. */
export function gatedReader(reader: FileSystemReader, gate: FileCallGate, timeoutMillis: number): FileSystemReader {
    return {
        readdir: (folder) => gate.run(() => reader.readdir(folder), timeoutMillis),
        lstat: (target) => gate.run(() => reader.lstat(target), timeoutMillis),
        stat: (target) => gate.run(() => reader.stat(target), timeoutMillis),
        readlink: (target) => gate.run(() => reader.readlink(target), timeoutMillis),
        access: (target, mode) => gate.run(() => reader.access(target, mode), timeoutMillis),
        homedir: () => reader.homedir(),
    };
}

/** `remover` with each call through `gate`. */
export function gatedRemover(remover: FileSystemRemover, gate: FileCallGate, timeoutMillis: number):
    FileSystemRemover {
    return {
        lstat: (target) => gate.run(() => remover.lstat(target), timeoutMillis),
        stat: (target) => gate.run(() => remover.stat(target), timeoutMillis),
        readdir: (folder) => gate.run(() => remover.readdir(folder), timeoutMillis),
        unlink: (target) => gate.run(() => remover.unlink(target), timeoutMillis),
        rmdir: (target) => gate.run(() => remover.rmdir(target), timeoutMillis),
        chmod: (target, mode) => gate.run(() => remover.chmod(target, mode), timeoutMillis),
        realpath: (target) => gate.run(() => remover.realpath(target), timeoutMillis),
    };
}

/** `maker` with its call through `gate`. */
export function gatedMaker(maker: FileSystemMaker, gate: FileCallGate, timeoutMillis: number): FileSystemMaker {
    return {
        mkdir: (target) => gate.run(() => maker.mkdir(target), timeoutMillis),
    };
}

/** `copier` with each call through `gate`. A read or a write of 1 piece is 1 call. */
export function gatedCopier(copier: FileSystemCopier, gate: FileCallGate, timeoutMillis: number): FileSystemCopier {
    return {
        lstat: (target) => gate.run(() => copier.lstat(target), timeoutMillis),
        stat: (target) => gate.run(() => copier.stat(target), timeoutMillis),
        realpath: (target) => gate.run(() => copier.realpath(target), timeoutMillis),
        readdir: (folder) => gate.run(() => copier.readdir(folder), timeoutMillis),
        mkdir: (target) => gate.run(() => copier.mkdir(target), timeoutMillis),
        openToRead: (target) => gate.run(() => copier.openToRead(target), timeoutMillis),
        createFile: (target) => gate.run(() => copier.createFile(target), timeoutMillis),
        read: (handle, buffer) => gate.run(() => copier.read(handle, buffer), timeoutMillis),
        write: (handle, buffer, length) => gate.run(() => copier.write(handle, buffer, length), timeoutMillis),
        close: (handle) => gate.run(() => copier.close(handle), timeoutMillis),
        readlink: (target) => gate.run(() => copier.readlink(target), timeoutMillis),
        symlink: (linkText, target, type) => gate.run(() => copier.symlink(linkText, target, type), timeoutMillis),
        chmod: (target, mode) => gate.run(() => copier.chmod(target, mode), timeoutMillis),
        utimes: (target, accessed, modified) => gate.run(() => copier.utimes(target, accessed, modified),
            timeoutMillis),
        rename: (from, to) => gate.run(() => copier.rename(from, to), timeoutMillis),
        unlink: (target) => gate.run(() => copier.unlink(target), timeoutMillis),
        freeBytes: (folder) => gate.run(() => copier.freeBytes(folder), timeoutMillis),
    };
}
