import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import os from "os";
import CLIPrinter from "./printer.js";
import { promisify } from "util";

const execAsync = promisify(exec);

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


/**
 * Main detection function - returns status and message for VC++ Redistributable
 */
export function checkVCRedist() {
  if (os.platform() !== "win32") {
    return {
      required: false,
      installed: true,
      message: null,
    };
  }

  const registryInstalled = checkRegistry();
  const dllsPresent = checkDLLs();
  const installed = registryInstalled || dllsPresent;

  return {
    required: true,
    installed,
    message: installed
      ? null
      :   "Missing Microsoft Visual C++ Runtime. This application requires the Microsoft Visual C++ Runtime to run on Windows.\n" +
      "Please download and install it using the link below, then restart this application.\n",
  };
}

/**
 * Open download page in browser
 */
export async function openDownloadPage() {
  if (process.platform !== "win32") {
    return;
  }
  const url =
    "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170";

  // Use cmd.exe explicitly for better compatibility
  const command = `cmd.exe /c start "" "${url}"`;

  try {
    await execAsync(command);
    CLIPrinter.info("\nOpening Microsoft download page in your browser...");
    CLIPrinter.info(
      "Please install the Visual C++ Runtime and restart this application.\n",
    );
  } catch (err) {
    CLIPrinter.info("\nUnable to open your browser automatically.");
    CLIPrinter.info(
      "Please visit the following page to download the runtime:\n",
    );
    CLIPrinter.info(url + "\n");
  }
}
