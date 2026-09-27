/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BTK
 *
 * Proteção do manifesto de observabilidade (`GET /observability`).
 *
 * Se METRICS_TOKEN não for configurado, o acesso é liberado - o manifesto traz
 * volumes, latência e estatísticas de segurança, então em produção o token deve
 * existir. Caso contrário, exige o header `x-metrics-token` com o valor exato.
 *
 * O nome do token e do middleware preserva `METRICS_TOKEN` por compatibilidade
 * de configuração já implantada. Renomear para `OBSERVABILITY_TOKEN` mudaria a
 * variável de ambiente de quem já tem o serviço no ar, o que é troca de
 * contrato, não refatoração interna.
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
