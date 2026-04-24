import fs from "fs";
import path from "path";
import { TunnelConfigurationV1 } from "@pinggy/pinggy";
import { ensureTunnelConfigDir, getTunnelConfigDir } from "../utils/configDir.js";
import { logger } from "../logger.js";
import pico from "picocolors";

export interface SavedTunnelConfig {
    name: string;
    configId: string;
    autoStart: boolean;
    createdAt: string;
    updatedAt: string;
    tunnelConfig: TunnelConfigurationV1;
}

/**
 * Builds the filename for a saved config: {name}_{configId}.json
 */
function buildFilename(name: string, configId: string): string {
    return `${name}_${configId}.json`;
}

/**
 * Sanitizes a tunnel name to be filesystem-safe.
 * Allows alphanumeric, hyphens, underscores only.
 */
export function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Validates that a tunnel name is acceptable.
 */
export function validateName(name: string): Error | null {
    if (!name || name.trim().length === 0) {
        return new Error("Tunnel name cannot be empty.");
    }
    if (name.length > 128) {
        return new Error("Tunnel name cannot exceed 128 characters.");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return new Error("Tunnel name can only contain alphanumeric characters, hyphens, and underscores.");
    }
    return null;
}

/**
 * Reads and parses a saved config JSON file.
 */
function readConfigFile(filePath: string): SavedTunnelConfig | null {
    try {
        const data = fs.readFileSync(filePath, { encoding: "utf-8" });
        return JSON.parse(data) as SavedTunnelConfig;
    } catch (err) {
        logger.warn(`Failed to read config file ${filePath}:`, err);
        return null;
    }
}

/**
 * List all saved tunnel configs from the config directory.
 */
export function listSavedConfigs(): SavedTunnelConfig[] {
    const dir = getTunnelConfigDir();
    if (!fs.existsSync(dir)) {
        return [];
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const configs: SavedTunnelConfig[] = [];

    for (const file of files) {
        const config = readConfigFile(path.join(dir, file));
        if (config && config.name && config.configId) {
            configs.push(config);
        }
    }

    return configs;
}

/**
 * Check if a config with the given name already exists.
 * Returns the existing config if found, null otherwise.
 */
export function findConfigByName(name: string): SavedTunnelConfig | null {
    const configs = listSavedConfigs();
    return configs.find((c) => c.name === name) || null;
}

/**
 * Find a config by name or configId (supports partial configId match).
 * Tries exact name match first, then configId prefix match.
 */
export function findConfig(nameOrId: string): SavedTunnelConfig | null {
    const configs = listSavedConfigs();
    // Exact name match
    const byName = configs.find((c) => c.name === nameOrId);
    if (byName) return byName;
    // ConfigId prefix match
    const byId = configs.filter((c) => c.configId.startsWith(nameOrId));
    if (byId.length === 1) return byId[0];
    return null;
}

/**
 * Save a tunnel config to the config store.
 * Rejects duplicate names.
 */
export function saveConfig(
    name: string,
    configId: string,
    tunnelConfig: TunnelConfigurationV1,
    autoStart: boolean = false
): SavedTunnelConfig {
    const nameErr = validateName(name);
    if (nameErr) {
        throw nameErr;
    }

    const existing = findConfigByName(name);
    if (existing) {
        throw new Error(
            `A tunnel config with the name "${name}" already exists (configId: ${existing.configId}). Please use a different name.`
        );
    }

    const dir = ensureTunnelConfigDir();
    const now = new Date().toISOString();

    const saved: SavedTunnelConfig = {
        name,
        configId,
        autoStart,
        createdAt: now,
        updatedAt: now,
        tunnelConfig,
    };

    const filename = buildFilename(sanitizeName(name), configId);
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), { encoding: "utf-8" });
    logger.info(`Config "${name}" saved to ${filePath}`);

    return saved;
}

/**
 * Load a saved tunnel config by name.
 */
export function loadConfigByName(name: string): SavedTunnelConfig | null {
    return findConfigByName(name);
}

/**
 * Delete a saved tunnel config by name or configId.
 * Returns the deleted config's name if found, null otherwise.
 */
export function deleteConfig(nameOrId: string): string | null {
    const dir = getTunnelConfigDir();
    if (!fs.existsSync(dir)) {
        return null;
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
        const config = readConfigFile(path.join(dir, file));
        if (config && (config.name === nameOrId || config.configId.startsWith(nameOrId))) {
            fs.unlinkSync(path.join(dir, file));
            logger.info(`Config "${config.name}" deleted.`);
            return config.name;
        }
    }

    return null;
}

/**
 * Print saved configs as a formatted table.
 */
export function printConfigList(): void {
    const configs = listSavedConfigs();

    if (configs.length === 0) {
        console.log(pico.yellow("No saved tunnel configs found."));
        console.log(pico.gray(`Config directory: ${getTunnelConfigDir()}`));
        return;
    }

    // Header
    const nameW = 20;
    const idW = 12;
    const typeW = 8;
    const fwdW = 25;
    const serverW = 22;
    const autoW = 10;

    const header =
        pico.bold("Name".padEnd(nameW)) +
        pico.bold("Config ID".padEnd(idW)) +
        pico.bold("Type".padEnd(typeW)) +
        pico.bold("Forwarding".padEnd(fwdW)) +
        pico.bold("Server".padEnd(serverW)) +
        pico.bold("Auto-start".padEnd(autoW));

    console.log("\n" + header);
    console.log(pico.gray("─".repeat(nameW + idW + typeW + fwdW + serverW + autoW)));

    for (const c of configs) {
        const tc = c.tunnelConfig;
        const forwarding = Array.isArray(tc.forwarding)
            ? tc.forwarding.map((f) => (typeof f === "string" ? f : f.address)).join(", ")
            : String(tc.forwarding || "");
        const type = (tc as any).type || "http";
        const server = tc.serverAddress || "a.pinggy.io";

        const line =
            pico.cyanBright(c.name.padEnd(nameW)) +
            pico.gray(c.configId.slice(0, 8).padEnd(idW)) +
            type.padEnd(typeW) +
            forwarding.slice(0, fwdW - 2).padEnd(fwdW) +
            server.slice(0, serverW - 2).padEnd(serverW) +
            (c.autoStart ? pico.green("yes") : pico.gray("no")).padEnd(autoW);

        console.log(line);
    }
    console.log();
}

/**
 * Print a single config's details.
 */
export function printConfigDetail(config: SavedTunnelConfig): void {
    console.log(pico.bold(`\nTunnel Config: ${pico.cyanBright(config.name)}`));
    console.log(pico.gray("─".repeat(40)));
    console.log(`  Config ID:   ${config.configId}`);
    console.log(`  Auto-start:  ${config.autoStart ? pico.green("yes") : pico.gray("no")}`);
    console.log(`  Created:     ${config.createdAt}`);
    console.log(`  Updated:     ${config.updatedAt}`);
    console.log(pico.gray("─".repeat(40)));
    console.log(`  Server:      ${config.tunnelConfig.serverAddress || "a.pinggy.io"}`);
    console.log(`  Token:       ${config.tunnelConfig.token ? "***" + config.tunnelConfig.token.slice(-4) : "(none)"}`);

    const fwd = config.tunnelConfig.forwarding;
    if (Array.isArray(fwd)) {
        for (const f of fwd) {
            const addr = typeof f === "string" ? f : `${f.address} (${f.type || "http"})`;
            console.log(`  Forwarding:  ${addr}`);
        }
    } else if (fwd) {
        console.log(`  Forwarding:  ${fwd}`);
    }

    if (config.tunnelConfig.webDebugger) {
        console.log(`  Debugger:    ${config.tunnelConfig.webDebugger}`);
    }
    console.log();
}
