/**
 * The shells this agent holds, by terminal id.
 *
 * The dashboard's gate enforces the per-device ceiling cluster-wide. This one is the agent's own
 * backstop, sized from `welcome`, so a dashboard bug cannot make 1 machine spawn without bound.
 */
export interface TerminalHandle {
    readonly pid: number;
    kill(): void;
}

/** Until welcome says otherwise. Matches the dashboard's default. */
export const DEFAULT_MAX_TERMINALS = 3;

export class TerminalRegistry<Handle extends TerminalHandle = TerminalHandle> {
    private readonly handlesById = new Map<string, Handle>();
    private maxTerminals = DEFAULT_MAX_TERMINALS;

    setMaxTerminals(maxTerminals: number): void {
        if (Number.isInteger(maxTerminals) && maxTerminals > 0) {
            this.maxTerminals = maxTerminals;
        }
    }

    has(terminalId: string): boolean {
        return this.handlesById.has(terminalId);
    }

    isFull(): boolean {
        return this.handlesById.size >= this.maxTerminals;
    }

    /** False when the id is already taken or the ceiling is reached. The caller then kills the handle. */
    add(terminalId: string, handle: Handle): boolean {
        if (this.handlesById.has(terminalId) || this.isFull()) return false;
        this.handlesById.set(terminalId, handle);
        return true;
    }

    get(terminalId: string): Handle | undefined {
        return this.handlesById.get(terminalId);
    }

    /** Removes and returns the handle. Undefined the second time, so a close runs at most once. */
    remove(terminalId: string): Handle | undefined {
        const handle = this.handlesById.get(terminalId);
        this.handlesById.delete(terminalId);
        return handle;
    }

    size(): number {
        return this.handlesById.size;
    }

    /** Removes every handle before killing any, so no exit callback finds itself still registered. */
    killAll(): void {
        const handles = [...this.handlesById.values()];
        this.handlesById.clear();
        for (const handle of handles) {
            try {
                handle.kill();
            } catch {
                // Already gone. The rest must still die.
            }
        }
    }
}