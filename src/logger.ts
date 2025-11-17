import winston from "winston";
import fs from "fs";
import path from "path";
import { ParsedValues } from "./utils/parseArgs.js";
import { cliOptions } from "./cli/options.js";
import { pinggy, LogLevel } from "@pinggy/pinggy";



// Singleton logger instance
let _logger: winston.Logger | null = null;
function getLogger(): winston.Logger {
    if (!_logger) {
        _logger = winston.createLogger({ level: "info", silent: true });
    }
    return _logger;
}
export const logger: winston.Logger = getLogger();

interface BaseLogConfig {
    level?: string;
    filePath?: string;
    stdout?: boolean;
    source?: boolean;
    silent?: boolean;
    enableSdkLog?: boolean;
}

function applyLoggingConfig(cfg: BaseLogConfig): winston.Logger {
    const {
        level,
        filePath,
        stdout = false,
        source = false,
        silent = false,
        enableSdkLog = false,
    } = cfg;
    // Set SDK log level
    if (enableSdkLog) {
        enableLoggingByLogLevelInSdk(level ?? "info", filePath!);
    }


    // Ensure directory exists
    if (filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const transports: winston.transport[] = [];

    // Console logging
    if (stdout) {
        transports.push(
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp(),
                    winston.format.printf(({ level, message, timestamp, ...meta }) => {
                        const srcLabel = source ? "[CLI] " : "";
                        return `${timestamp} ${srcLabel}[${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""
                            }`;
                    })
                ),
            })
        );
    }

    // File logging
    if (filePath) {
        transports.push(
            new winston.transports.File({
                filename: filePath,
                format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.printf(({ level, message, timestamp, ...meta }) => {
                        return `${timestamp} [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""
                            }`;
                    })
                ),
            })
        );
    }

    // Mutate the singleton logger instead of replacing it so all imports keep the same instance.
    const log: winston.Logger = getLogger();

    // Remove existing transports and add the new ones
    log.clear();
    for (const t of transports) {
        log.add(t);
    }

    log.level = (level || process.env.PINGGY_LOG_LEVEL || "info").toLowerCase();
    log.silent = silent || transports.length === 0;

    return log;
}


export function configureLogger(values: ParsedValues<typeof cliOptions>, silent: boolean = false) {

    // Parse values from CLI args
    const level = (values.loglevel as string) || undefined;
    const filePath = (values.logfile as string) || process.env.PINGGY_LOG_FILE || undefined;
    const stdout = values.v as boolean || values.vvv || undefined;
    const source = values.vvv ?? false;
    const enableSdkLog = values.vv || values.vvv;
    return applyLoggingConfig({
        level,
        filePath,
        stdout,
        source,
        silent,
        enableSdkLog
    });

}

export type BaseLogConfigType = BaseLogConfig;

export function enablePackageLogging(opts?: BaseLogConfigType) {
    return applyLoggingConfig(opts ?? {});
}

function enableLoggingByLogLevelInSdk(loglevel: string | undefined, logFilePath: string | null): void {
    if (!loglevel) return;
    const l = loglevel.toUpperCase();

    if (loglevel === "DEBUG") {
        pinggy.setDebugLogging(true, LogLevel.DEBUG, logFilePath);
    } else if (loglevel === "ERROR") {
        pinggy.setDebugLogging(true, LogLevel.ERROR, logFilePath);
    } else {
        pinggy.setDebugLogging(true, LogLevel.INFO, logFilePath);
    }
}

