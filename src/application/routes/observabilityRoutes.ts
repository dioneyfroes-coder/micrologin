/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BSX
 *
 * GET /observability — endpoint próprio de observabilidade (baseado em logs).
 * Mesma proteção do /metrics (x-metrics-token quando METRICS_TOKEN configurado).
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../shared/utils/errorHandler.js';
import { requireMetricsToken } from '../middleware/metricsToken.js';
import { buildObservabilitySnapshot } from '../observability/observability.js';

const router = Router();

/**
 * @swagger
 * /observability:
 *   get:
 *     summary: Snapshot de observabilidade (próprio, por logs)
 *     description: Manifesto JSON consolidado do serviço: agregados da janela de logs de requisição (volumes, P50/P95/P99, taxas de erro), health das dependências, estatísticas de segurança e configuração de logging. Protegido por x-metrics-token quando METRICS_TOKEN está configurado.
 *     tags: [Sistema]
 *     security:
 *       - metricToken: []
 *     responses:
 *       200:
 *         description: Snapshot de observabilidade
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                 service:
 *                   type: object
 *                 requests:
 *                   type: object
 *                 health:
 *                   type: object
 *                 security:
 *                   type: object
 *                 logging:
 *                   type: object
 *       401:
 *         description: Token de observabilidade ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Falha ao gerar snapshot
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/observability', requireMetricsToken, async(req: Request, res: Response, next: NextFunction) => {
  try {
    const snapshot = await buildObservabilitySnapshot();
    res.json(snapshot);
  } catch {
    next(new HttpError(500, 'OBSERVABILITY_FAILED', 'Falha ao gerar snapshot de observabilidade'));
  }
});

export default router;
