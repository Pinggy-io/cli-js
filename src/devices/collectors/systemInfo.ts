import os from "os";
import { DeviceInfo } from "../device_schema.js";

const UNKNOWN_CPU_MODEL = "unknown";

/**
 * Static facts about this machine, from Node's built-in `os` module only.
 *
 * No `systeminformation` or `node-os-utils`: a native addon will not load in the `node20` pkg binary.
 */
export function collectSystemInfo(): DeviceInfo {
    const cpus = os.cpus();
    return {
        hostname: os.hostname(),
        os: os.platform(),
        os_version: os.release(),
        // os.machine() reports what uname does (x86_64, arm64, aarch64). os.arch() reports the Node
        // build target (x64), which is not what an operator reads on the machine itself.
        arch: os.machine(),
        kernel: os.type(),
        // os.cpus() is empty on some Android and container builds.
        cpu_model: cpus[0]?.model?.trim() || UNKNOWN_CPU_MODEL,
        cpu_cores: cpus.length,
        total_memory_bytes: os.totalmem(),
    };
}