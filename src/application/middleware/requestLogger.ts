/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BRL
 *
 * Logger de requisições: define X-Request-Id no início e, no término da
 * resposta (finish), emite o log estruturado com status + duração e alimenta
 * o agregador de observabilidade (mesma fonte dos logs, sem coleta externa).
 */
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/utils/logger.js';
import { requestLogAggregator } from '../observability/requestLogAggregator.js';

export { logger };

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = typeof req.get === 'function' ? req.get('X-Request-Id') : undefined;
  const requestId = incoming || crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.statusCode ?? 0;
    const route = typeof req.route === 'object' && req.route && req.route.path ? req.route.path : req.path;

    logger.info(`Worker ${process.pid} processou: ${req.method} ${req.path} ${status} ${Math.round(durationMs)}ms`, {
      requestId,
      method: req.method,
      path: req.path,
      route,
      status,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      worker: process.pid
    });

    requestLogAggregator.record({
      method: req.method,
      route,
      status,
      durationMs,
      timestamp: Date.now()
    });
  });

  next();
};
