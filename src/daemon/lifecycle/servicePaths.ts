import path from "node:path";

/**
 * Where the installer puts `pinggy` and where the service entry that starts it at sign-in lives. Kept apart from
 * `serviceInstaller.ts`, which pulls in the daemon, so the file manager can protect these paths without it.
 */

export const SERVICE_LABEL = "io.pinggy.agent";
export const SYSTEMD_SERVICE_NAME = "pinggy";

/** The binary path that scripts/install/install.sh and install.ps1 write. */
export function installerBinaryPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
        return path.win32.join(localAppData, "Pinggy", "bin", "pinggy.exe");
    }
    return path.posix.join(home, ".pinggy", "bin", "pinggy");
}

export function systemdServicePath(home: string): string {
    return path.posix.join(home, ".config", "systemd", "user", `${SYSTEMD_SERVICE_NAME}.service`);
}

export function launchdPlistPath(home: string): string {
    return path.posix.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/** The file that starts `pinggy` at sign-in. Null on Windows: Task Scheduler keeps the task under `C:\Windows`. */
export function autostartFilePath(platform: NodeJS.Platform, home: string): string | null {
    if (platform === "linux") return systemdServicePath(home);
    if (platform === "darwin") return launchdPlistPath(home);
    return null;
}
