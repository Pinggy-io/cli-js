/**
 * Platform-specific system service installer for the Pinggy daemon.
 * Supports: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { logger } from "../../logger.js";

const SERVICE_LABEL = "io.pinggy.agent";
const SYSTEMD_SERVICE_NAME = "pinggy";

interface ResolvedBinary {
    /** The executable (node or the pinggy binary itself) */
    program: string;
    /** Additional args before the daemon flag (e.g. the script path for node) */
    args: string[];
}

/**
 * Resolve the absolute path to the pinggy binary.
 * Returns structured data so each installer can quote/escape correctly.
 * - pkg binary: program is the binary itself, no extra args
 * - npm install: find via `which pinggy`
 * - fallback: node + script path as separate tokens
 */
function resolveBinary(): ResolvedBinary {
    const isPkg = !!(process as any).pkg;
    if (isPkg) return { program: process.execPath, args: [] };

    try {
        const bin = execSync(os.platform() === "win32" ? "where pinggy" : "which pinggy", {
            encoding: "utf-8",
        }).trim().split(/\r?\n/)[0];
        return { program: bin, args: [] };
    } catch {
        // Fallback to node + script as separate tokens
        return { program: process.execPath, args: [process.argv[1]] };
    }
}

// Linux: systemd user service

function getSystemdServicePath(): string {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    return path.join(dir, `${SYSTEMD_SERVICE_NAME}.service`);
}

function generateSystemdUnit(bin: ResolvedBinary): string {
    // Use --_daemon-child directly so systemd manages the long-running process.
    // Type=simple: systemd tracks the ExecStart process itself (no forking).
    const execStart = [bin.program, ...bin.args, "--_daemon-child"].join(" ");
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

function installSystemd(): void {
    const bin = resolveBinary();
    const servicePath = getSystemdServicePath();
    const dir = path.dirname(servicePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(servicePath, generateSystemdUnit(bin), "utf-8");

    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`);
    execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`);
    logger.info("systemd user service installed and started", { servicePath });
    console.log(`Service installed: ${servicePath}`);
    console.log(`Enable at boot: loginctl enable-linger ${os.userInfo().username}`);
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

// macOS: launchd LaunchAgent

function getLaunchdPlistPath(): string {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function generateLaunchdPlist(bin: ResolvedBinary): string {
    // Use --_daemon-child directly so launchd manages the long-running process
    const allArgs = [bin.program, ...bin.args, "--_daemon-child"];
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

function installLaunchd(): void {
    const bin = resolveBinary();
    const plistPath = getLaunchdPlistPath();
    const dir = path.dirname(plistPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plistPath, generateLaunchdPlist(bin), "utf-8");

    const uid = process.getuid?.() ?? 501;

    // Remove any existing registration first (re-install case)
    try {
        execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL} 2>/dev/null || true`);
    } catch { /* not registered yet — fine */ }

    try {
        // Modern macOS: bootstrap into the user domain
        execSync(`launchctl bootstrap gui/${uid} ${plistPath}`);
    } catch {
        try {
            // Fallback for older macOS
            execSync(`launchctl load -w ${plistPath}`);
        } catch { /* may already be loaded */ }
    }

    logger.info("launchd agent installed and started", { plistPath });
    console.log(`Service installed and started: ${plistPath}`);
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
        console.log(`Service removed: ${plistPath}`);
    } else {
        console.log("No launchd agent found to remove.");
    }
}

// Windows: Task Scheduler XML (no admin required, hidden)

const WINDOWS_TASK_NAME = "PinggyDaemon";

function generateTaskXml(bin: ResolvedBinary): string {
    const command = bin.program;
    const args = [...bin.args, "--_daemon-child"].join(" ");

    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
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
      <Command>${command}</Command>${args ? `\n      <Arguments>${args}</Arguments>` : ""}
    </Exec>
  </Actions>
</Task>`;
}

function installWindows(): void {
    const bin = resolveBinary();
    const xml = generateTaskXml(bin);

    // Task Scheduler XML must be UTF-16 LE with BOM
    const tmpPath = path.join(os.tmpdir(), `${WINDOWS_TASK_NAME}.xml`);
    fs.writeFileSync(tmpPath, "\ufeff" + xml, "utf16le");

    try {
        execFileSync("schtasks", [
            "/Create", "/TN", WINDOWS_TASK_NAME, "/XML", tmpPath, "/F",
        ], { stdio: "inherit" });
    } finally {
        // Clean up temp file regardless of success/failure
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }

    // Start the task immediately
    execFileSync("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], { stdio: "inherit" });
    console.log(`Scheduled task "${WINDOWS_TASK_NAME}" created and started (runs at login, hidden).`);
}

function uninstallWindows(): void {
    try {
        // Stop the running task first
        execFileSync("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], { stdio: "ignore" });
    } catch { /* may not be running */ }

    try {
        execFileSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], { stdio: "inherit" });
        console.log(`Scheduled task "${WINDOWS_TASK_NAME}" removed.`);
    } catch {
        console.log("No scheduled task found to remove.");
    }
}

// Public API

export function installService(): void {
    const platform = os.platform();
    const bin = resolveBinary();

    // Warn if using npm-installed binary (path may change on Node updates)
    if (!(process as any).pkg && bin.program !== process.execPath) {
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



