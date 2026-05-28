import fs from "node:fs";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVES = 3;
const ROTATE_TRIGGER_RATIO = 0.8;

/**
 * Rotate a log file in place at the only safe moment: when no writer holds a
 * file descriptor on it (called from TunnelManager just before a tunnel starts).
 *
 * Trigger: file exists and `size >= ROTATE_TRIGGER_RATIO * maxBytes`. Rotating
 * at 80% (not 100%) 
 * Shift: drop the oldest archive past `maxArchives`, then move every other
 * archive one slot older, then rename the live file to `<file>.1`.
 *
 * Old files are not deleted, they are archived.
 */
export function maybeRotate(file: string, maxBytes: number = DEFAULT_MAX_BYTES, maxArchives: number = DEFAULT_MAX_ARCHIVES): void {
    let size: number;
    try {
        size = fs.statSync(file).size;
    } catch {
        // File missing or unreadable. Nothing to do.
        return;
    }
    if (size < maxBytes * ROTATE_TRIGGER_RATIO) return;

    const archive = (n: number) => `${file}.${n}`;

    try {
        if (fs.existsSync(archive(maxArchives))) {
            fs.unlinkSync(archive(maxArchives));
        }
        for (let n = maxArchives - 1; n >= 1; n--) {
            if (fs.existsSync(archive(n))) {
                fs.renameSync(archive(n), archive(n + 1));
            }
        }
        fs.renameSync(file, archive(1));
    } catch {
        // Best-effort. A race or permission failure should not block tunnel
        // start; writers will reopen the existing file in append mode.
    }
}
