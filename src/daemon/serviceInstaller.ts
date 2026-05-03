/**
 * Platform-specific system service installer for the Pinggy daemon.
 * Supports: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const SERVICE_LABEL = "io.pinggy.agent";
const SYSTEMD_SERVICE_NAME = "pinggy";

/**
 * Resolve the absolute path to the pinggy binary.
 * - pkg binary: process.execPath is the binary itself
 * - npm install: find via `which pinggy`
 */
function resolveBinaryPath(): string {
    const isPkg = !!(process as any).pkg;
    if (isPkg) return process.execPath;

    try {
        return execSync("which pinggy", { encoding: "utf-8" }).trim();
    } catch {
        // Fallback to node + script
        return `${process.execPath} ${process.argv[1]}`;
    }
}

// ─── Linux: systemd user service ────────────────────────────────────────

function getSystemdServicePath(): string {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    return path.join(dir, `${SYSTEMD_SERVICE_NAME}.service`);
}

function generateSystemdUnit(binaryPath: string): string {
    return `[Unit]
Description=Pinggy Tunnel Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=${binaryPath} -D
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function installSystemd(): void {
    const binaryPath = resolveBinaryPath();
    const servicePath = getSystemdServicePath();
    const dir = path.dirname(servicePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(servicePath, generateSystemdUnit(binaryPath), "utf-8");

    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`);
    logger.info("systemd user service installed", { servicePath });
    console.log(`Service installed: ${servicePath}`);
    console.log(`Enable at boot: loginctl enable-linger ${os.userInfo().username}`);
    console.log(`Start now:      systemctl --user start ${SYSTEMD_SERVICE_NAME}`);
}

function uninstallSystemd(): void {
    const servicePath = getSystemdServicePath();
    try {
        execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME} 2>/dev/null || true`);
        execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME} 2>/dev/null || true`);
    } catch { /* ignore */ }

    if (fs.existsSync(servicePath)) {
        fs.unlinkSync(servicePath);
        execSync("systemctl --user daemon-reload");
        console.log(`Service removed: ${servicePath}`);
    } else {
        console.log("No systemd service found to remove.");
    }
}

// ─── macOS: launchd LaunchAgent ─────────────────────────────────────────

function getLaunchdPlistPath(): string {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function generateLaunchdPlist(binaryPath: string): string {
    // Split binary path for cases like "node /path/to/script"
    const parts = binaryPath.split(" ");
    const programArgs = parts.map((p) => `      <string>${p}</string>`).join("\n");

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
      <string>-D</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
`;
}

function installLaunchd(): void {
    const binaryPath = resolveBinaryPath();
    const plistPath = getLaunchdPlistPath();
    const dir = path.dirname(plistPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plistPath, generateLaunchdPlist(binaryPath), "utf-8");

    try {
        execSync(`launchctl load ${plistPath}`);
    } catch { /* may already be loaded */ }

    logger.info("launchd agent installed", { plistPath });
    console.log(`Service installed: ${plistPath}`);
    console.log("It will start automatically on login.");
}

function uninstallLaunchd(): void {
    const plistPath = getLaunchdPlistPath();

    try {
        execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
    } catch { /* ignore */ }

    if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
        console.log(`Service removed: ${plistPath}`);
    } else {
        console.log("No launchd agent found to remove.");
    }
}

// ─── Windows: Task Scheduler ────────────────────────────────────────────

const WINDOWS_TASK_NAME = "PinggyDaemon";

function installWindows(): void {
    const binaryPath = resolveBinaryPath();
    const cmd = `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR "${binaryPath} -D" /SC ONLOGON /RL LIMITED /F`;
    execSync(cmd, { stdio: "inherit" });
    console.log(`Scheduled task "${WINDOWS_TASK_NAME}" created (runs at login).`);
}

function uninstallWindows(): void {
    try {
        execSync(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`, { stdio: "inherit" });
        console.log(`Scheduled task "${WINDOWS_TASK_NAME}" removed.`);
    } catch {
        console.log("No scheduled task found to remove.");
    }
}

// ─── Public API ─────────────────────────────────────────────────────────

export function installService(): void {
    const platform = os.platform();
    const binaryPath = resolveBinaryPath();

    // Warn if using npm-installed binary (path may change on Node updates)
    if (!(process as any).pkg && !binaryPath.startsWith(process.execPath)) {
        console.warn(
            "Warning: Using npm-installed binary. The path may change if Node.js is updated.\n" +
            "Consider using a standalone binary (pkg) for system services."
        );
    }

    switch (platform) {
        case "linux":
            installSystemd();
            break;
        case "darwin":
            installLaunchd();
            break;
        case "win32":
            installWindows();
            break;
        default:
            console.error(`Unsupported platform: ${platform}`);
            process.exit(1);
    }
}

export function uninstallService(): void {
    const platform = os.platform();
    switch (platform) {
        case "linux":
            uninstallSystemd();
            break;
        case "darwin":
            uninstallLaunchd();
            break;
        case "win32":
            uninstallWindows();
            break;
        default:
            console.error(`Unsupported platform: ${platform}`);
            process.exit(1);
    }
}
