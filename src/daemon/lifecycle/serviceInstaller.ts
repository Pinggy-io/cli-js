/**
 * Platform-specific system service installer for the Pinggy daemon.
 * Supports: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync, StdioOptions } from "node:child_process";
import { logger } from "../../logger.js";
import CLIPrinter from "../../utils/printer.js";
import { errorMessage } from "../../utils/util.js";
import { isDaemonRunning, stopDaemon } from "./daemonManager.js";

const SERVICE_LABEL = "io.pinggy.agent";
const SYSTEMD_SERVICE_NAME = "pinggy";

// Install location check.
// The service stores the full path of the binary. A binary the user later moves or
// deletes leaves a service that fails at login with no message. The install scripts
// put the binary in 1 fixed place and update it there, so only that binary may
// install the service.

/** Set to 1 to install the service from any location, for development and CI. */
const SERVICE_ANY_LOCATION_ENV = "PINGGY_SERVICE_ANY_LOCATION";

export interface ServiceInstallContext {
    platform: NodeJS.Platform;
    isPkg: boolean;
    execPath: string;
    home: string;
    env: NodeJS.ProcessEnv;
}

/** The binary path that scripts/install/install.sh and install.ps1 write. */
export function installerBinaryPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
        return path.win32.join(localAppData, "Pinggy", "bin", "pinggy.exe");
    }
    return path.posix.join(home, ".pinggy", "bin", "pinggy");
}

function realPath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

function isInstallerBinary(ctx: ServiceInstallContext): boolean {
    const actual = realPath(ctx.execPath);
    const expected = realPath(installerBinaryPath(ctx.platform, ctx.home, ctx.env));
    if (ctx.platform === "win32") return actual.toLowerCase() === expected.toLowerCase();
    return actual === expected;
}

function installerFix(platform: NodeJS.Platform): string {
    const installCommand = platform === "win32"
        ? "irm https://pinggy.io/install.ps1 | iex"
        : "curl -fsSL https://pinggy.io/install.sh | sh";
    return [
        "pinggy can only run as a service when it is installed with the Pinggy installer.",
        "Install it, then run this command again:",
        `  ${installCommand}`,
        "  pinggy daemon service-install",
    ].join("\n");
}

/** The message that refuses service-install, or null when the install may go ahead. */
export function serviceInstallRefusal(ctx: ServiceInstallContext): string | null {
    if (!ctx.isPkg) return `The npm version of pinggy cannot run as a service.\n${installerFix(ctx.platform)}`;
    if (ctx.env[SERVICE_ANY_LOCATION_ENV] === "1" || isInstallerBinary(ctx)) return null;
    return installerFix(ctx.platform);
}

// Messages. The service tools print their own lines, so their output stays hidden and
// pinggy prints 1 line.

function printInstalled(): void {
    CLIPrinter.success("pinggy now starts automatically when this computer starts.");
}

function printUninstalled(): void {
    CLIPrinter.success("pinggy no longer starts automatically when this computer starts.");
}

function printNotInstalled(): void {
    CLIPrinter.print("pinggy is not set to start automatically.");
}

/** Hides the command's output. On failure, the thrown error carries its stderr. */
const QUIET: { stdio: StdioOptions } = { stdio: ["ignore", "ignore", "pipe"] };

/** The error text a service tool wrote, without its own "ERROR:" prefix. */
function toolError(err: unknown): string {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    return stderr ? stderr.replace(/^ERROR:\s*/i, "") : errorMessage(err);
}

// Linux: systemd user service

function getSystemdServicePath(): string {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    return path.join(dir, `${SYSTEMD_SERVICE_NAME}.service`);
}

function generateSystemdUnit(program: string): string {
    // Use --_daemon-child directly so systemd manages the long-running process.
    // Type=simple: systemd tracks the ExecStart process itself (no forking).
    const execStart = `${program} --_daemon-child`;
    return `[Unit]
Description=Pinggy Tunnel Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function installSystemd(program: string): void {
    const servicePath = getSystemdServicePath();
    const dir = path.dirname(servicePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(servicePath, generateSystemdUnit(program), "utf-8");

    execSync("systemctl --user daemon-reload", QUIET);
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`, QUIET);
    // A daemon that already runs keeps daemon.lock, so the service's daemon exits 0.
    execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`, QUIET);
    logger.info("systemd user service installed", { servicePath });
    printInstalled();
    // A systemd user service starts at sign-in. Lingering starts it at boot.
    CLIPrinter.print(`To start it before anyone signs in, run: loginctl enable-linger ${os.userInfo().username}`);
}

function uninstallSystemd(): void {
    const servicePath = getSystemdServicePath();
    try {
        execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME} 2>/dev/null || true`);
        execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME} 2>/dev/null || true`);
    } catch { /* ignore */ }

    if (fs.existsSync(servicePath)) {
        fs.unlinkSync(servicePath);
        execSync("systemctl --user daemon-reload", QUIET);
        logger.info("systemd user service removed", { servicePath });
        printUninstalled();
    } else {
        printNotInstalled();
    }
}

// macOS: launchd LaunchAgent

function getLaunchdPlistPath(): string {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function generateLaunchdPlist(program: string): string {
    // Use --_daemon-child directly so launchd manages the long-running process
    const allArgs = [program, "--_daemon-child"];
    const programArgs = allArgs.map((p) => `      <string>${p}</string>`).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
`;
}

function installLaunchd(program: string): void {
    const plistPath = getLaunchdPlistPath();
    const dir = path.dirname(plistPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plistPath, generateLaunchdPlist(program), "utf-8");

    const uid = process.getuid?.() ?? 501;

    // Remove any existing registration first (re-install case)
    try {
        execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null || true`);
    } catch { /* not registered yet — fine */ }

    // A daemon that already runs keeps daemon.lock, so the service's daemon exits 0.
    loadLaunchdPlist(uid, plistPath);

    logger.info("launchd agent installed", { plistPath });
    printInstalled();
}

function loadLaunchdPlist(uid: number, plistPath: string): void {
    try {
        // Modern macOS: bootstrap into the user domain
        execSync(`launchctl bootstrap gui/${uid} ${plistPath}`);
    } catch {
        try {
            // Fallback for older macOS
            execSync(`launchctl load -w ${plistPath}`);
        } catch { /* may already be loaded */ }
    }
}

function uninstallLaunchd(): void {
    const plistPath = getLaunchdPlistPath();
    const uid = process.getuid?.() ?? 501;

    try {
        execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null || true`);
    } catch {
        try {
            execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
        } catch { /* ignore */ }
    }

    if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
        logger.info("launchd agent removed", { plistPath });
        printUninstalled();
    } else {
        printNotInstalled();
    }
}

// Windows: Task Scheduler runs `pinggy daemon start` at login (no admin required).
// pinggy.exe is a console program, so Task Scheduler opens a console window for it.
// The task must not run --_daemon-child directly: closing that window kills the daemon.
// `daemon start` spawns the daemon detached with no console and exits, so its window
// shows for about 1s and closing it does not affect the daemon.

const WINDOWS_TASK_NAME = "PinggyDaemon";

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * DOMAIN\user of the current user. A logon trigger without a UserId fires for any
 * user, and only an administrator can create that task.
 */
function getWindowsUserId(): string {
    const user = process.env.USERNAME || os.userInfo().username;
    const domain = process.env.USERDOMAIN;
    return domain ? `${domain}\\${user}` : user;
}

export function generateTaskXml(program: string, userId: string): string {
    const user = escapeXml(userId);
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Hidden>true</Hidden>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(program)}</Command>
      <Arguments>daemon start</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

function createWindowsTask(program: string): void {
    const xml = generateTaskXml(program, getWindowsUserId());

    // Task Scheduler XML must be UTF-16 LE with BOM
    const tmpPath = path.join(os.tmpdir(), `${WINDOWS_TASK_NAME}.xml`);
    fs.writeFileSync(tmpPath, "\ufeff" + xml, "utf16le");

    try {
        execFileSync("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", tmpPath, "/F"], QUIET);
    } finally {
        // Clean up temp file regardless of success/failure
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
}

function installWindows(program: string): void {
    try {
        createWindowsTask(program);
        // Start the task now, not only at the next login
        execFileSync("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], QUIET);
    } catch (err) {
        CLIPrinter.error(`Could not set pinggy to start automatically: ${toolError(err)}`);
        process.exit(1);
    }
    logger.info("Scheduled task installed", { task: WINDOWS_TASK_NAME });
    printInstalled();
}

function windowsTaskExists(): boolean {
    try {
        execFileSync("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], QUIET);
        return true;
    } catch {
        return false;
    }
}

async function uninstallWindows(): Promise<void> {
    // The task exits once the daemon is up, so stop the daemon over IPC.
    if (isDaemonRunning()) {
        const result = await stopDaemon();
        if (!result.ok) console.log(`Could not stop the daemon: ${result.error}`);
    }

    if (!windowsTaskExists()) {
        printNotInstalled();
        return;
    }
    try {
        execFileSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], QUIET);
    } catch (err) {
        CLIPrinter.error(`Could not stop pinggy from starting automatically: ${toolError(err)}`);
        process.exit(1);
    }
    logger.info("Scheduled task removed", { task: WINDOWS_TASK_NAME });
    printUninstalled();
}

// Public API

export function installService(): void {
    const platform = os.platform();
    const program = process.execPath;

    const refusal = serviceInstallRefusal({
        platform, isPkg: "pkg" in process, execPath: program, home: os.homedir(), env: process.env,
    });
    if (refusal) {
        console.error(refusal);
        process.exit(1);
    }

    switch (platform) {
        case "linux":
            installSystemd(program);
            break;
        case "darwin":
            installLaunchd(program);
            break;
        case "win32":
            installWindows(program);
            break;
        default:
            console.error(`Unsupported platform: ${platform}`);
            process.exit(1);
    }
}

export async function uninstallService(): Promise<void> {
    const platform = os.platform();
    switch (platform) {
        case "linux":
            uninstallSystemd();
            break;
        case "darwin":
            uninstallLaunchd();
            break;
        case "win32":
            await uninstallWindows();
            break;
        default:
            console.error(`Unsupported platform: ${platform}`);
            process.exit(1);
    }
}
