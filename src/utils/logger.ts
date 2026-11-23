/**
 * Simple structured logger for Dee IdleClans Helper.
 * Outputs to stdout with level, timestamp, and tag — suitable for Docker logging driver.
 */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CURRENT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function formatLog(level: LogLevel, tag: string, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const metaStr = meta != null ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}${metaStr}`;
}

export class Logger {
  constructor(private readonly tag: string) {}

  debug(message: string, meta?: unknown): void {
    if (LEVEL_ORDER[CURRENT_LEVEL] <= LEVEL_ORDER.debug) {
      console.log(formatLog('debug', this.tag, message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (LEVEL_ORDER[CURRENT_LEVEL] <= LEVEL_ORDER.info) {
      console.log(formatLog('info', this.tag, message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (LEVEL_ORDER[CURRENT_LEVEL] <= LEVEL_ORDER.warn) {
      console.warn(formatLog('warn', this.tag, message, meta));
    }
  }

  error(message: string, meta?: unknown): void {
    if (LEVEL_ORDER[CURRENT_LEVEL] <= LEVEL_ORDER.error) {
      console.error(formatLog('error', this.tag, message, meta));
    }
  }
}

export function createLogger(tag: string): Logger {
  return new Logger(tag);
}
