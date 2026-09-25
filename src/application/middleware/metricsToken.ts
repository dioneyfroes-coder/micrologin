/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BTK
 *
 * Proteção compartilhada dos endpoints de observabilidade/métricas.
 * Se METRICS_TOKEN não for configurado, o acesso é liberado (mesmo
 * comportamento histórico do /metrics). Caso contrário exige o header
 * `x-metrics-token` com o valor exato.
 */
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../shared/utils/errorHandler.js';

const TOKEN_HEADER = 'x-metrics-token';

export const requireMetricsToken = (req: Request, res: Response, next: NextFunction): void => {
  const token = process.env.METRICS_TOKEN || '';
  if (!token) {
    return next();
  }
  if (req.get(TOKEN_HEADER) !== token) {
    return next(new HttpError(401, 'METRICS_FORBIDDEN', 'Acesso não autorizado a observabilidade'));
  }
  return next();
};

export const metricsTokenConfigured = (): boolean => Boolean(process.env.METRICS_TOKEN);
