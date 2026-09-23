import type { NextFunction, Request, Response } from 'express';
import { monitoringConfig } from '../../interfaces/config/appConfig.js';

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof LOG_LEVELS;

const { level: configuredLevel = 'info', format: configuredFormat = 'console' } = monitoringConfig.logging;
const minLevel = LOG_LEVELS[configuredLevel as LogLevel] ?? LOG_LEVELS.info;
const isStructured = configuredFormat === 'structured';

const shouldLog = (level: LogLevel): boolean => {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= minLevel;
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  pid: number;
  message: string;
  [key: string]: unknown;
}

const write = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  if (!shouldLog(level)) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(meta || {})
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
  error: (message: string, meta?: unknown): void => write('error', message, meta as Record<string, unknown> | undefined)
};

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  logger.info(`Worker ${process.pid} processou: ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  next();
};
