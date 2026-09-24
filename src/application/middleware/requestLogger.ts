import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/utils/logger.js';

export { logger };

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = typeof req.get === 'function' ? req.get('X-Request-Id') : undefined;
  const requestId = incoming || crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  logger.info(`Worker ${process.pid} processou: ${req.method} ${req.path}`, {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    worker: process.pid
  });
  next();
};
