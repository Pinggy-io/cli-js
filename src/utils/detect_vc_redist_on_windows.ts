import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import os from "os";
import CLIPrinter from "./printer.js";

const DLLS = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

const PATHS = ["C:\\Windows\\System32", "C:\\Windows\\SysWOW64"];

// Registry keys for different VC++ Redistributable versions
const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64",
  "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X86",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X86",
];

/**
 * Check if VC++ Redistributable DLLs exist
 */
function checkDLLs() {
  return DLLS.every((dll) =>
    PATHS.some((p) => {
      try {
        return fs.existsSync(path.join(p, dll));
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Check Windows Registry for VC++ Redistributable installation
 */
function checkRegistry() {
  if (os.platform() !== "win32") return false;

  try {
    for (const key of REGISTRY_KEYS) {
      const cmd = `reg query "${key}" /v Installed 2>nul`;
      const result = execSync(cmd, { encoding: "utf8" });

      if (result.includes("0x1")) {
        return true;
      }
    }
  } catch {
    // Registry check failed, fall back to DLL check
  }

  return false;
}

function getVCRedistVersion() {
  if (os.platform() !== "win32") return null;

  try {
    for (const key of REGISTRY_KEYS) {
      const cmd = `reg query "${key}" /v Version 2>nul`;
      const result = execSync(cmd, { encoding: "utf8" });

      const match = result.match(/Version\s+REG_SZ\s+(\S+)/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Main detection function
 */
export function hasVCRedist() {
  if (os.platform() !== "win32") {
    return true; // Not Windows, assume OK
  }

  if (checkRegistry()) {
    return true;
  }

  if (checkDLLs()) {
    return true;
  }

  return false;
}

export function getVCRedistStatus() {
  if (os.platform() !== "win32") {
    return {
      required: false,
      installed: true,
      version: null,
      method: "non-windows",
    };
  }

  const registryInstalled = checkRegistry();
  const dllsPresent = checkDLLs();
  const version = getVCRedistVersion();

  return {
    required: true,
    installed: registryInstalled || dllsPresent,
    version,
    registryCheck: registryInstalled,
    dllCheck: dllsPresent,
    method: registryInstalled ? "registry" : dllsPresent ? "dll" : "none",
  };
}

/**
 * Open download page in browser
 */
export function openDownloadPage() {
  if (process.platform !== "win32") {
    return;
  }
  const url =
    "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170";
  let command = `start ${url}`;
  exec(command, (err) => {
    if (err) {
      CLIPrinter.info("\nUnable to open your browser automatically.");
      CLIPrinter.info(
        "Please visit the following page to download the runtime:\n",
      );
      CLIPrinter.info(url + "\n");
      return;
    }

    CLIPrinter.info("\nOpening Microsoft download page in your browser...");
    CLIPrinter.info(
      "Please install the Visual C++ Runtime and restart this application.\n",
    );
  });
}

export function getVCRedistDownloadUrl(): string | null {
  if (process.platform !== "win32") return null;

  switch (process.arch) {
    case "ia32":
      return "https://aka.ms/vc14/vc_redist.x86.exe";

    case "x64":
      return "https://aka.ms/vc14/vc_redist.x64.exe";

    case "arm64":
      return "https://aka.ms/vc14/vc_redist.arm64.exe";

    default:
      return null;
  }
}

/**
 * Get error message
 */
export function getVCRedistMessage() {
  const status = getVCRedistStatus();
  const url = getVCRedistDownloadUrl();

  if (!status.required || status.installed) {
    return null;
  }

  return {
    error: true,
    message:
      "Missing Microsoft Visual C++ Runtime. This application requires the Microsoft Visual C++ Runtime to run on Windows.\n" +
      "Please download and install it using the link below, then restart this application.\n",
    downloadUrl: url,
  };
}
