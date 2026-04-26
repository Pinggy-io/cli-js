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
 * Write a config object back to its JSON file.
 */
function writeConfigFile(filePath: string, config: SavedTunnelConfig): void {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: "utf-8" });
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
 * Resolved config with its file path on disk.
 */
interface ResolvedConfig {
    filePath: string;
    config: SavedTunnelConfig;
}

/**
 * Find a config file by name or configId prefix.
 *
 * Uses the filename pattern `{name}_{configId}.json` to narrow down
 * candidates before reading JSON, so we don't parse every file.
 *
 * Match priority:
 *   1. Exact name match (filename starts with `{nameOrId}_`)
 *   2. ConfigId prefix match (filename contains `_{nameOrId}`)
 */
function findConfigFile(nameOrId: string): ResolvedConfig | null {
    const dir = getTunnelConfigDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const sanitized = sanitizeName(nameOrId);

    // 1. Try exact name match via filename prefix
    const nameMatch = files.find((f) => f.startsWith(sanitized + "_"));
    if (nameMatch) {
        const filePath = path.join(dir, nameMatch);
        const config = readConfigFile(filePath);
        if (config && config.name === nameOrId) return { filePath, config };
    }

    // 2. Try configId prefix match via filename
    const idCandidates = files.filter((f) => {
        // Filename: {name}_{configId}.json — extract the configId part
        const withoutExt = f.replace(/\.json$/, "");
        const lastUnderscore = withoutExt.indexOf("_");
        if (lastUnderscore === -1) return false;
        const idPart = withoutExt.slice(lastUnderscore + 1);
        return idPart.startsWith(nameOrId);
    });

    if (idCandidates.length === 1) {
        const filePath = path.join(dir, idCandidates[0]);
        const config = readConfigFile(filePath);
        if (config) return { filePath, config };
    }

    return null;
}

/**
 * Check if a config with the given name already exists.
 */
export function findConfigByName(name: string): SavedTunnelConfig | null {
    const resolved = findConfigFile(name);
    return resolved?.config.name === name ? resolved.config : null;
}

/**
 * Find a config by name or configId (supports partial configId match).
 */
export function findConfig(nameOrId: string): SavedTunnelConfig | null {
    return findConfigFile(nameOrId)?.config ?? null;
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
    const resolved = findConfigFile(nameOrId);
    if (!resolved) return null;

    fs.unlinkSync(resolved.filePath);
    logger.info(`Config "${resolved.config.name}" deleted.`);
    return resolved.config.name;
}

/**
 * Update the autoStart flag on a saved config.
 * Returns the updated config, or null if not found.
 */
export function updateConfigAutoStart(nameOrId: string, autoStart: boolean): SavedTunnelConfig | null {
    const resolved = findConfigFile(nameOrId);
    if (!resolved) return null;

    resolved.config.autoStart = autoStart;
    resolved.config.updatedAt = new Date().toISOString();
    writeConfigFile(resolved.filePath, resolved.config);
    logger.info(`Config "${resolved.config.name}" auto-start set to ${autoStart}`);
    return resolved.config;
}

/**
 * Update the tunnel configuration of a saved config.
 * Returns the updated config, or null if not found.
 */
export function updateTunnelConfig(nameOrId: string, tunnelConfig: TunnelConfigurationV1): SavedTunnelConfig | null {
    const resolved = findConfigFile(nameOrId);
    if (!resolved) return null;

    resolved.config.tunnelConfig = tunnelConfig;
    resolved.config.updatedAt = new Date().toISOString();
    writeConfigFile(resolved.filePath, resolved.config);
    logger.info(`Config "${resolved.config.name}" tunnel configuration updated`);
    return resolved.config;
}

/**
 * Get all configs marked for auto-start.
 */
export function getAutoStartConfigs(): SavedTunnelConfig[] {
    return listSavedConfigs().filter((c) => c.autoStart);
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
            ? tc.forwarding[0]?.address
            : String(tc.forwarding || "");
        const type = (Array.isArray(tc.forwarding) ? tc.forwarding[0]?.type : undefined) || "http";
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
        const defaultFwds: typeof fwd = [];
        const customFwds: typeof fwd = [];
        for (const f of fwd) {
            if (typeof f === "string") {
                defaultFwds.push(f);
            } else if (f.listenAddress) {
                customFwds.push(f);
            } else {
                defaultFwds.push(f);
            }
        }
        for (const f of defaultFwds) {
            const addr = typeof f === "string" ? f : `${f.address} (${f.type || "http"})`;
            console.log(`  Forwarding:  ${addr}`);
            if (config.tunnelConfig.webDebugger) {
              console.log(`  Debugger:    ${config.tunnelConfig.webDebugger}`);
            }
        }
        if (customFwds.length > 0) {
            console.log(pico.gray("─".repeat(40)));
            console.log(pico.bold("  Domain Mappings:"));
            for (const f of customFwds) {
                if (typeof f === "string") continue;
                const domain = f.listenAddress!;
                const target = f.address;
                const type = f.type || "http";
                console.log(`    ${pico.cyanBright(domain)} → ${target} (${type})`);
            }
        }
    } else if (fwd) {
        console.log(`  Forwarding:  ${fwd}`);
    }

    
    console.log();
}
