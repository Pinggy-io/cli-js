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
    /**
     * App-owned UI state (e.g. `regioncode`, `isServerAddress`). The CLI
     * and daemon never read this;
     */
    uiMetadata?: Record<string, unknown>;
}

/**
 * Minimal logger interface for the storage module. Defaults to the cli-js
 * winston logger (silent unless the CLI configures it). Non-CLI consumers
 * (e.g. the Electron app) override it via {@link configureStorageLogger} to
 * route storage logs into their own logging pipeline
 */
export interface StorageLogger {
    info: (message: string, ...meta: unknown[]) => void;
    warn: (message: string, ...meta: unknown[]) => void;
    error: (message: string, ...meta: unknown[]) => void;
}

let storageLogger: StorageLogger = {
    info: (message, ...meta) => logger.info(message, ...meta),
    warn: (message, ...meta) => logger.warn(message, ...meta),
    error: (message, ...meta) => logger.error(message, ...meta),
};


export function configureStorageLogger(l: StorageLogger): void {
    storageLogger = l;
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

export const Subcommand = {
    Config:      "config",
    Start:       "start",
    Stop:        "stop",
    Ps:          "ps",
    Attach:      "attach",
    Daemon:      "daemon",
    DaemonAlias: "d",
    Logs:        "logs",
    Log:         "log",
    Restart:     "restart",
    Devices:     "devices",
} as const;
export type Subcommand = typeof Subcommand[keyof typeof Subcommand];

export const ConfigVerb = {
    List:   "list",
    Ls:     "ls",
    Show:   "show",
    Save:   "save",
    Update: "update",
    Delete: "delete",
    Auto:   "auto",
    Noauto: "noauto",
} as const;
export type ConfigVerb = typeof ConfigVerb[keyof typeof ConfigVerb];

export const SUBCOMMANDS = Object.values(Subcommand);
export const CONFIG_VERBS = Object.values(ConfigVerb);
export const RESERVED_NAMES = new Set<string>([...SUBCOMMANDS, ...CONFIG_VERBS]);

/**
 * Strict name validation used by the CLI's own save path: alphanumeric +
 * `_`/`-`, ≤128 chars, no reserved subcommand names.
 */
export function validateNameStrict(name: string): Error | null {
    if (!name || name.trim().length === 0) {
        return new Error("Tunnel name cannot be empty.");
    }
    if (name.length > 128) {
        return new Error("Tunnel name cannot exceed 128 characters.");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return new Error("Tunnel name can only contain alphanumeric characters, hyphens, and underscores.");
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
        return new Error(`"${name}" is a reserved subcommand name. Use a different name.`);
    }
    return null;
}

/**
 * Relaxed name validation used by app-driven writes (`{ strict: false }`). The
 * app allows spaces/unicode in display names, so this only rejects what would
 * break the filesystem layout or collide with a CLI subcommand: path
 * separators, NUL/control characters, empty/whitespace-only names, and reserved
 * subcommand names. The JSON `name` keeps the original; the filename is always
 * sanitized via {@link sanitizeName}.
 */
export function validateNameForStorage(name: string): Error | null {
    if (!name || name.trim().length === 0) {
        return new Error("Tunnel name cannot be empty.");
    }
    if (/[\u0000-\u001F\/\\]/.test(name)) {
        return new Error("Tunnel name cannot contain path separators or control characters.");
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
        return new Error(`"${name}" is a reserved subcommand name. Use a different name.`);
    }
    return null;
}

/**
 * Backwards-compatible alias for {@link validateNameStrict}. Existing CLI
 * callers (`subcommands.ts`, `buildAndStartTunnel.ts`) import `validateName`.
 */
export const validateName = validateNameStrict;

/**
 * Reads and parses a saved config JSON file.
 */
function readConfigFile(filePath: string): SavedTunnelConfig | null {
    try {
        const data = fs.readFileSync(filePath, { encoding: "utf-8" });
        return JSON.parse(data) as SavedTunnelConfig;
    } catch (err) {
        storageLogger.warn(`Failed to read config file ${filePath}: ${String(err)}`);
        return null;
    }
}

/**
 * Write a config object to its JSON file atomically (tmp + rename) so a
 * concurrent reader (the app or another CLI process) never observes a
 * half-written file. Last-rename-wins on a true race; neither file is corrupt.
 */
function writeConfigFile(filePath: string, config: SavedTunnelConfig): void {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf-8" });
    fs.renameSync(tmp, filePath);
}


function nextTimestamp(prev?: string): string {
    const ts = new Date().toISOString();
    if (prev && ts <= prev) {
        return new Date(new Date(prev).getTime() + 1).toISOString();
    }
    return ts;
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

    // 1. Exact name match. 
    const nameCandidates = files.filter((f) => f.startsWith(sanitized + "_"));
    for (const f of nameCandidates) {
        const filePath = path.join(dir, f);
        const config = readConfigFile(filePath);
        if (config && config.name === nameOrId) return { filePath, config };
    }

    const idCandidates = files.filter((f) => {
        const withoutExt = f.replace(/\.json$/, "");
        const lastUnderscore = withoutExt.lastIndexOf("_");
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
 * Resolve a config file by exact `configId` (not a prefix). Reads each file in
 * the dir; used by upsert/bulkReplace where the name (and thus filename) may
 * have changed but the configId is the stable identity.
 */
function findConfigFileByConfigId(configId: string): ResolvedConfig | null {
    const dir = getTunnelConfigDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
        const filePath = path.join(dir, file);
        const config = readConfigFile(filePath);
        if (config && config.configId === configId) {
            return { filePath, config };
        }
    }
    return null;
}

/**
 * Find a config by its exact display name (the JSON `name`). Exact on purpose:
 * `sanitizeName` is many-to-one (`"My Tunnel"`/`"My_Tunnel"` → `My_Tunnel`), so
 * it builds filenames, never decides identity. Narrows by sanitized prefix then
 * confirms the exact `name`; on a same-name/different-`configId` tie, newest wins.
 */
export function findConfigByName(name: string): SavedTunnelConfig | null {
    const dir = getTunnelConfigDir();
    if (!fs.existsSync(dir)) return null;

    const prefix = `${sanitizeName(name)}_`;
    const matches = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
        .map((f) => readConfigFile(path.join(dir, f)))
        .filter((c): c is SavedTunnelConfig => c !== null && c.name === name);

    if (matches.length === 0) return null;
    return matches.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
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
 *
 * @param options.strict When `true` (default) names are validated with
 *   {@link validateNameStrict}; when `false` (app-driven writes) with the
 *   relaxed {@link validateNameForStorage}.
 */
export function saveConfig(
    name: string,
    configId: string,
    tunnelConfig: TunnelConfigurationV1,
    autoStart: boolean = false,
    options: { strict?: boolean } = {}
): SavedTunnelConfig {
    const { strict = true } = options;
    const nameErr = strict ? validateNameStrict(name) : validateNameForStorage(name);
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

    const filePath = path.join(dir, buildFilename(sanitizeName(name), configId));
    writeConfigFile(filePath, saved);
    storageLogger.info(`Config "${name}" saved to ${filePath}`);

    return saved;
}

/**
 * Insert or update a full saved record, keyed by `configId` (the stable
 * identity). If a record with the same `configId` exists under a different
 * filename — because its `name` changed — the old file is deleted before the
 * new one is written, so there is never a stale duplicate on disk. Only
 * validates the name when creating a brand-new record;
 */
export function upsertConfig(
    saved: SavedTunnelConfig,
    options: { strict?: boolean } = {}
): SavedTunnelConfig {
    const { strict = true } = options;
    const dir = ensureTunnelConfigDir();
    const targetPath = path.join(dir, buildFilename(sanitizeName(saved.name), saved.configId));

    const existing = findConfigFileByConfigId(saved.configId);
    if (existing) {
        if (path.resolve(existing.filePath) !== path.resolve(targetPath)) {
            try {
                fs.unlinkSync(existing.filePath);
            } catch (err) {
                storageLogger.warn(`upsertConfig: failed to remove old file ${existing.filePath}: ${String(err)}`);
            }
        }
        writeConfigFile(targetPath, saved);
        storageLogger.info(`Config "${saved.name}" (${saved.configId}) updated at ${targetPath}`);
        return saved;
    }

    const nameErr = strict ? validateNameStrict(saved.name) : validateNameForStorage(saved.name);
    if (nameErr) {
        throw nameErr;
    }
    writeConfigFile(targetPath, saved);
    storageLogger.info(`Config "${saved.name}" (${saved.configId}) saved to ${targetPath}`);
    return saved;
}

/**
 * Replace a *bounded* set of configs in one pass. Every config in `configs` is
 * upserted;
 */
export function bulkReplace(
    configs: SavedTunnelConfig[],
    knownConfigIds: Set<string>,
    options: { strict?: boolean } = {}
): { written: string[]; deleted: string[] } {
    const written: string[] = [];
    const deleted: string[] = [];
    const incomingIds = new Set<string>();

    for (const cfg of configs) {
        upsertConfig(cfg, options);
        written.push(cfg.configId);
        incomingIds.add(cfg.configId);
    }

    for (const id of knownConfigIds) {
        if (incomingIds.has(id)) continue;
        const existing = findConfigFileByConfigId(id);
        if (!existing) continue;
        try {
            fs.unlinkSync(existing.filePath);
            deleted.push(id);
        } catch (err) {
            storageLogger.warn(`bulkReplace: failed to delete ${existing.filePath}: ${String(err)}`);
        }
    }

    return { written, deleted };
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
    storageLogger.info(`Config "${resolved.config.name}" deleted.`);
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
    resolved.config.updatedAt = nextTimestamp(resolved.config.updatedAt);
    writeConfigFile(resolved.filePath, resolved.config);
    storageLogger.info(`Config "${resolved.config.name}" auto-start set to ${autoStart}`);
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
    resolved.config.updatedAt = nextTimestamp(resolved.config.updatedAt);
    writeConfigFile(resolved.filePath, resolved.config);
    storageLogger.info(`Config "${resolved.config.name}" tunnel configuration updated`);
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
