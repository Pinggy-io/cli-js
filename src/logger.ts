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

export function configureLogger(values: ParsedValues<typeof cliOptions>, silent: boolean = false) {

    // Parse values from CLI args
    const levelStr = (values.loglevel as string) || undefined;
    const filePath = (values.logfile as string) || process.env.PINGGY_LOG_FILE || undefined;
    const printlog = values.v as boolean || values.vvv || undefined;
    const source = values.vvv ?? false;

    if ((values.vv || values.vvv) || levelStr) {
        enableLoggingByLogLevel(levelStr);
    }

    // Ensure log directory exists if file logging is enabled
    if (filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const transports: winston.transport[] = [];

    // Console transport: only if explicitly requested or env var is set
    const stdoutEnabled =
        printlog === true || (process.env.PINGGY_LOG_STDOUT || "").toLowerCase() === "true";

    if (stdoutEnabled) {
        transports.push(
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp(),
                    winston.format.printf(({ level, message, timestamp, ...meta }) => {
                        const srcLabel = source ? "[CLI] " : "";
                        return `${timestamp} ${srcLabel}[${level}]  ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""
                            }`;
                    })
                ),
            })
        );
    }

    // File transport
    if (filePath) {
        transports.push(
            new winston.transports.File({
                filename: filePath,
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp(),
                    winston.format.printf(({ level, message, timestamp, ...meta }) => {
                        return `${timestamp} [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""
                            }`;
                    })
                ),
            })
        );
    }

    const level = (levelStr || process.env.PINGGY_LOG_LEVEL || "info").toLowerCase();

    // Mutate the singleton logger instead of replacing it so all imports keep the same instance.
    const log: winston.Logger = getLogger();

    // Remove existing transports and add the new ones
    log.clear()

    for (const t of transports) {
        log.add(t);
    }

    log.level = level;
    log.silent = transports.length === 0 || silent === true;

    return log;
}

function enableLoggingByLogLevel(loglevel: string | undefined): void {
    
    if (loglevel === "DEBUG" || loglevel === "debug") {
        pinggy.setDebugLogging(true, LogLevel.DEBUG);
    } else if (loglevel === "ERROR" || loglevel === "error") {
        pinggy.setDebugLogging(true, LogLevel.ERROR);
    } else {
        pinggy.setDebugLogging(true, LogLevel.INFO);
    }
}

