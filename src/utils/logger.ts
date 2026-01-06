import { config } from '../config/index.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m',
};

class Logger {
  private minLevel: number;

  constructor(level: LogLevel = 'info') {
    this.minLevel = LOG_LEVELS[level];
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.minLevel;
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const color = COLORS[level];
    const reset = COLORS.reset;
    const levelStr = level.toUpperCase().padEnd(5);
    
    let formattedMessage = `${color}[${timestamp}] ${levelStr}${reset} ${message}`;
    
    if (data !== undefined) {
      // Special handling for Error objects
      if (data instanceof Error) {
        formattedMessage += '\n' + data.message;
        if (data.stack) {
          formattedMessage += '\n' + data.stack;
        }
      } else if (typeof data === 'object' && data !== null) {
        try {
          formattedMessage += '\n' + JSON.stringify(data, null, 2);
        } catch (e) {
          formattedMessage += '\n' + String(data);
        }
      } else {
        formattedMessage += ' ' + String(data);
      }
    }
    
    return formattedMessage;
  }

  debug(message: string, data?: any): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: any): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: any): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: any): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, error));
    }
  }
}

export const logger = new Logger(config.logLevel);

