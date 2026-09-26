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

/**
 * Aceita apenas UUID (v1-v8) com tamanho e charset verificáveis.
 *
 * O `X-Request-Id` de entrada é controlada por quem fez a requisição. Aceitar
 * qualquer string faria o id vazar direto para os logs - e um id de log é
 * filtro de alerta: um atacante pode forjar ids gigantes, com quebras de linha
 * ou bytes de controle, para poluir o log store ou forjar correlação. Por isso,
 * o valor externo só passa se for UUID; caso contrário, o serviço gera o seu.
 */
const EXTERNAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EXTERNAL_REQUEST_ID_LENGTH = 36;

const isTrustedRequestId = (value: string): boolean =>
  value.length <= MAX_EXTERNAL_REQUEST_ID_LENGTH && EXTERNAL_REQUEST_ID.test(value);

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = typeof req.get === 'function' ? req.get('X-Request-Id') : undefined;
  const candidate = incoming?.trim();
  const requestId = candidate && isTrustedRequestId(candidate) ? candidate : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  if (incoming && !isTrustedRequestId(candidate ?? '')) {
    logger.warn('X-Request-Id externo inválido ignorado; id gerado no serviço', {
      reason: candidate ? 'formato_nao_confiavel' : 'vazio'
    });
  }

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
