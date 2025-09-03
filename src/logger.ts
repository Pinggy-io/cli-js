import winston from "winston";
import fs from "fs";
import path from "path";

export type LogLevel = "ERROR" | "INFO" | "DEBUG";

export function createLogger(values: Record<string, unknown> = {}) {

    // Parse values from CLI args
    const levelStr = values.loglevel as string || undefined;
    const filePath = values.logfile as string || process.env.PINGGY_LOG_FILE || undefined;
    const printlog = values.printlog as boolean | undefined;

    // Ensure log directory exists if file logging is enabled
    if (filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const transports: winston.transport[] = [];

    // Console transport (enabled via env or default)
    const stdoutEnabled = printlog === true ||
        (process.env.PINGGY_LOG_STDOUT || "").toLowerCase() === "true";

    if (stdoutEnabled) {
        transports.push(
            new winston.transports.Console({
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

    return winston.createLogger({
        level,
        transports,
    });
}

export const logger = createLogger();
