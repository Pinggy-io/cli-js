import fs from 'fs';
import path from 'path';

export type LogLevel = 'ERROR' | 'INFO' | 'DEBUG' | 'TRACE';

const levelOrder: Record<LogLevel, number> = {
  ERROR: 0,
  INFO: 1,
  DEBUG: 2,
  TRACE: 3,
};

interface LoggerConfig {
  level: LogLevel;
  toStdout: boolean;
  filePath?: string;
}

class Logger {
  private config: LoggerConfig;
  private stream: fs.WriteStream | null = null;

  constructor() {
    const envLevel = (process.env.PINGGY_LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
    const envFile = process.env.PINGGY_LOG_FILE;
    const envStdout = (process.env.PINGGY_LOG_STDOUT || '').toLowerCase();

    this.config = {
      level: ['ERROR', 'INFO', 'DEBUG', 'TRACE'].includes(envLevel) ? envLevel : 'INFO',
      toStdout: envStdout === '1' || envStdout === 'true',
      filePath: envFile,
    };

    if (this.config.filePath) this.prepareStream(this.config.filePath);
  }

  configure(partial: Partial<LoggerConfig>) {
    const prev = this.config;
    this.config = { ...prev, ...partial } as LoggerConfig;
    if (partial.filePath !== undefined) {
      if (this.stream) {
        this.stream.end();
        this.stream = null;
      }
      if (partial.filePath) this.prepareStream(partial.filePath);
    }
  }

  private prepareStream(filePath: string) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (e) {
      // fallback: disable file logging if cannot open
      this.stream = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return levelOrder[level] <= levelOrder[this.config.level];
  }

  private format(level: LogLevel, msg: any, params: any[]): string {
    const ts = new Date().toLocaleString();
    const text = [msg, ...params]
      .map((v) => (typeof v === 'string' ? v : safeStringify(v)))
      .join(' ');
    return `${ts} [${level}] ${text}`;
  }

  private write(line: string) {
    if (this.config.toStdout) {
      process.stdout.write(line + '\n');
    }
    if (this.stream) {
      this.stream.write(line + '\n');
    }
  }

  setLevel(level: LogLevel) {
    if (level in levelOrder) this.config.level = level;
  }

  setStdout(enabled: boolean) {
    this.config.toStdout = enabled;
  }

  setFile(filePath?: string) {
    this.configure({ filePath });
  }

  error(msg: any, ...params: any[]) {
    if (!this.shouldLog('ERROR')) return;
    this.write(this.format('ERROR', msg, params));
  }

  info(msg: any, ...params: any[]) {
    if (!this.shouldLog('INFO')) return;
    this.write(this.format('INFO', msg, params));
  }

  debug(msg: any, ...params: any[]) {
    if (!this.shouldLog('DEBUG')) return;
    this.write(this.format('DEBUG', msg, params));
  }

  trace(msg: any, ...params: any[]) {
    if (!this.shouldLog('TRACE')) return;
    this.write(this.format('TRACE', msg, params));
  }

  warn(msg: any, ...params: any[]) {
    // alias to INFO for visibility
    this.info(msg, ...params);
  }
}

function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const logger = new Logger();
