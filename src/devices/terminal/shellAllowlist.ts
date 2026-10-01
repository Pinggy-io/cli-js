import fs from "fs";

/**
 * Which shells this machine will spawn for a browser.
 *
 * The dashboard deliberately validates neither `shell` nor `cwd`: only the machine knows which shells
 * exist on it. So this is the only check, and it runs before every spawn.
 *
 * A requested shell must match an allowlist entry exactly, as an absolute path, and exist. Nothing is
 * resolved against PATH and nothing is normalised, so `/bin/../bin/sh` and `sh` are both refused.
 */

/** Used only when `/etc/shells` is missing or unreadable. */
const FALLBACK_UNIX_SHELLS = ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"];

const WINDOWS_SHELLS = ["powershell.exe", "cmd.exe"];

const ETC_SHELLS_PATH = "/etc/shells";

export interface ShellEnvironment {
    platform: NodeJS.Platform;
    /** `$SHELL`, the user's login shell, preferred when nothing is requested. */
    loginShell: string | undefined;
    /** Contents of `/etc/shells`, or null when it cannot be read. */
    etcShells: string | null;
    exists: (path: string) => boolean;
}

export type ShellResolution = { shell: string } | { error: string };

export function readShellEnvironment(): ShellEnvironment {
    let etcShells: string | null = null;
    try {
        etcShells = fs.readFileSync(ETC_SHELLS_PATH, "utf8");
    } catch {
        etcShells = null;
    }
    return {
        platform: process.platform,
        loginShell: process.env.SHELL,
        etcShells,
        exists: (path) => {
            try {
                return fs.statSync(path).isFile();
            } catch {
                return false;
            }
        },
    };
}

/** `/etc/shells` lines that are absolute paths, comments and blanks dropped. */
export function parseEtcShells(contents: string): string[] {
    return contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/"));
}

export function allowedShells(environment: ShellEnvironment): string[] {
    if (environment.platform === "win32") return WINDOWS_SHELLS;
    const listed = environment.etcShells === null ? [] : parseEtcShells(environment.etcShells);
    return listed.length > 0 ? listed : FALLBACK_UNIX_SHELLS;
}

/**
 * The shell to spawn. `requested` null or absent means "you pick": the login shell when it is
 * allowed, otherwise the first allowed shell that exists.
 */
export function resolveShell(requested: string | null | undefined, environment: ShellEnvironment): ShellResolution {
    const allowed = allowedShells(environment);
    // Windows shells are names resolved by the OS, not paths, so existence is not checked there.
    const usable = (shell: string) => environment.platform === "win32" || environment.exists(shell);

    if (requested !== null && requested !== undefined) {
        if (allowed.includes(requested) && usable(requested)) {
            return { shell: requested };
        }
        return { error: "That shell is not allowed on this machine." };
    }

    const loginShell = environment.loginShell;
    if (loginShell && allowed.includes(loginShell) && usable(loginShell)) {
        return { shell: loginShell };
    }
    const firstUsable = allowed.find(usable);
    return firstUsable ? { shell: firstUsable } : { error: "No allowed shell exists on this machine." };
}