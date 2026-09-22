import { jest } from '@jest/globals';
import { PtySession } from '../../devices/terminal/ptySession.js';

/**
 * A pty with no process behind it. Every call it can receive is a mock, `exit` fires its exit listener,
 * and `print` feeds its data listener as if the shell wrote to the pty.
 */
export interface FakeSession extends PtySession {
    kill: jest.Mock;
    pause: jest.Mock;
    resume: jest.Mock;
    resize: jest.Mock<(cols: number, rows: number) => void>;
    exit: (exitCode: number, signal?: number) => void;
    print: (text: string) => void;
}

export function fakeSession(pid: number, shell: string, cols = 80, rows = 24): FakeSession {
    let exitListener: ((exitCode: number, signal: number | undefined) => void) | null = null;
    let dataListener: ((chunk: Buffer) => void) | null = null;
    const grid = { cols, rows };
    return {
        pid,
        shell,
        get cols() { return grid.cols; },
        get rows() { return grid.rows; },
        kill: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        resize: jest.fn((newCols: number, newRows: number) => { grid.cols = newCols; grid.rows = newRows; }),
        onExit: (listener) => { exitListener = listener; },
        onData: (listener) => { dataListener = listener; },
        exit: (exitCode, signal) => exitListener?.(exitCode, signal),
        print: (text) => dataListener?.(Buffer.from(text)),
    };
}
