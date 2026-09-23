/**
 * LOGGER UNIFICADO
 *
 * Único ponto de emissão de logs da aplicação.
 * Respeita LOG_LEVEL (debug|info|warn|error) e LOG_FORMAT (console|structured).
 */

import { monitoringConfig } from '../../interfaces/config/appConfig.js';

export const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const configuredLevel = monitoringConfig.logging.level || 'info';
const minLevel = LOG_LEVELS[configuredLevel as LogLevel] ?? LOG_LEVELS.info;
const isStructured = monitoringConfig.logging.format === 'structured';

export const shouldLog = (level: LogLevel): boolean => {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= minLevel;
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  pid: number;
  message: string;
  [key: string]: unknown;
}

const write = (level: LogLevel, message: string, meta?: unknown): void => {
  if (!shouldLog(level)) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(meta && typeof meta === 'object'
      ? meta as Record<string, unknown>
      : meta !== undefined ? { error: String(meta) } : {})
  };

  const output = isStructured
    ? JSON.stringify(entry)
    : `[${entry.timestamp}] ${level.toUpperCase()} ${entry.pid} ${message}`;

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
};

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>): void => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>): void => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => write('warn', message, meta),
  error: (message: string, error?: unknown): void => write('error', message, error)
};