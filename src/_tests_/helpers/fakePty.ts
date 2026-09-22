import { jest } from '@jest/globals';
import { PtySession } from '../../devices/terminal/ptySession.js';

/** A pty with no process behind it. Every call it can receive is a mock, and `exit` fires its listener. */
export interface FakeSession extends PtySession {
    kill: jest.Mock;
    pause: jest.Mock;
    resume: jest.Mock;
    resize: jest.Mock;
    exit: (exitCode: number) => void;
}

export function fakeSession(pid: number, shell: string, cols = 80, rows = 24): FakeSession {
    let exitListener: ((exitCode: number, signal: number | undefined) => void) | null = null;
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
        exit: (exitCode) => exitListener?.(exitCode, undefined),
    };
}
