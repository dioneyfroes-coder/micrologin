import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/utils/logger.js';

export { logger };

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  logger.info(`Worker ${process.pid} processou: ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  next();
};
