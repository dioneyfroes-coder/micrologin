/**
 * @fileoverview Rotas para dashboard de segurança
 * Fornece endpoints para monitoramento e métricas de segurança
 *
 * Todas exigem `x-security-token` quando `SECURITY_TOKEN` está configurado
 * (`requireSecurityToken`), e são montadas sob `/security`.
 */

// ML-A31C
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { securityAuditLogger } from '../middleware/securityAudit.js';
import { advancedRateLimit } from '../middleware/advancedRateLimit.js';
import { requireSecurityToken } from '../middleware/securityToken.js';
import { HttpError } from '../../shared/utils/errorHandler.js';

const router = Router();

router.use(requireSecurityToken);

/**
 * @swagger
 * /security/stats:
 *   get:
 *     summary: Estatísticas de segurança e estado do rate limit
 *     tags: [Sistema]
 *     security:
 *       - securityToken: []
 *     responses:
 *       200:
 *         description: Estatísticas do serviço de auditoria e do rate limiter
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 status:
 *                   type: string
 *                   example: operational
 *                 security:
 *                   type: object
 *                 rateLimit:
 *                   type: object
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * GET /security/stats
 * Retorna estatísticas de segurança
 */
router.get('/stats', (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = securityAuditLogger.getSecurityStats();
    const rateLimitStatus = advancedRateLimit.getStatus();

    res.json({
      timestamp: new Date().toISOString(),
      security: stats,
      rateLimit: rateLimitStatus,
      status: 'operational'
    });
  } catch {
    next(new HttpError(500, 'SECURITY_STATS_FAILED', 'Erro ao obter estatísticas de segurança'));
  }
});

/**
 * @swagger
 * /security/report:
 *   get:
 *     summary: Relatório completo de segurança
 *     tags: [Sistema]
 *     security:
 *       - securityToken: []
 *     responses:
 *       200:
 *         description: Relatório gerado pelo auditor de segurança
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                 topAttackTypes:
 *                   type: array
 *                   items:
 *                     type: object
 *                 topAttackIPs:
 *                   type: array
 *                   items:
 *                     type: object
 *                 recommendations:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * GET /security/report
 * Gera relatório completo de segurança
 */
router.get('/report', (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = securityAuditLogger.generateSecurityReport();

    res.json({
      ...report,
      generated: new Date().toISOString()
    });
  } catch {
    next(new HttpError(500, 'SECURITY_REPORT_FAILED', 'Erro ao gerar relatório de segurança'));
  }
});

/**
 * @swagger
 * /security/events:
 *   get:
 *     summary: Eventos de segurança recentes
 *     tags: [Sistema]
 *     security:
 *       - securityToken: []
 *     parameters:
 *       - in: query
 *         name: timeWindow
 *         required: false
 *         schema:
 *           type: integer
 *           default: 300000
 *         description: Janela em milissegundos (padrão 5 minutos)
 *       - in: query
 *         name: severity
 *         required: false
 *         schema:
 *           type: string
 *         description: Filtra os eventos por severidade
 *     responses:
 *       200:
 *         description: Eventos no período
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timeWindow:
 *                   type: integer
 *                 severity:
 *                   type: string
 *                 count:
 *                   type: integer
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * GET /security/events
 * Retorna eventos de segurança recentes
 */
router.get('/events', (req: Request, res: Response, next: NextFunction) => {
  try {
    const timeWindowParam = req.query.timeWindow;
    const timeWindow = timeWindowParam ? parseInt(String(timeWindowParam), 10) || 300000 : 300000; // 5 minutos padrão
    const severity = req.query.severity; // filtro opcional

    let events = securityAuditLogger.getRecentEvents(timeWindow);

    if (severity) {
      events = events.filter(event => event.severity === String(severity));
    }

    res.json({
      timeWindow,
      severity: severity || 'all',
      count: events.length,
      events
    });
  } catch {
    next(new HttpError(500, 'SECURITY_EVENTS_FAILED', 'Erro ao obter eventos de segurança'));
  }
});

/**
 * @swagger
 * /security/threats:
 *   get:
 *     summary: Análise de ameaças
 *     tags: [Sistema]
 *     security:
 *       - securityToken: []
 *     responses:
 *       200:
 *         description: Nível de risco, ameaças ativas e recomendações
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 riskLevel:
 *                   type: string
 *                 activeThreats:
 *                   type: integer
 *                 topAttackTypes:
 *                   type: array
 *                   items:
 *                     type: object
 *                 topAttackIPs:
 *                   type: array
 *                   items:
 *                     type: object
 *                 recommendations:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * GET /security/threats
 * Retorna análise de ameaças
 */
router.get('/threats', (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = securityAuditLogger.generateSecurityReport();

    res.json({
      timestamp: new Date().toISOString(),
      riskLevel: report.stats.riskLevel,
      activeThreats: report.stats.activeThreats,
      topAttackTypes: report.topAttackTypes,
      topAttackIPs: report.topAttackIPs,
      recommendations: report.recommendations
    });
  } catch {
    next(new HttpError(500, 'SECURITY_THREATS_FAILED', 'Erro ao analisar ameaças'));
  }
});

/**
 * @swagger
 * /security/test:
 *   post:
 *     summary: Simula detecção de ameaças
 *     description: >
 *       Executa um cenário de teste do auditor de segurança. Responde 403 em
 *       produção: o endpoint existe em todas asenvironments e se recusa lá.
 *     tags: [Debug]
 *     security:
 *       - securityToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - testType
 *             properties:
 *               testType:
 *                 type: string
 *                 enum: [rate_limit, suspicious_activity, security_attack]
 *     responses:
 *       200:
 *         description: Cenário executado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Tipo de teste inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Endpoint indisponível em produção
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * POST /security/test
 * Endpoint para testar detecção de ameaças (apenas desenvolvimento)
 */
router.post('/test', (req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Endpoint de teste não disponível em produção'
    });
  }

  try {
    const { testType } = req.body as { testType?: string };

    switch (testType) {
    case 'rate_limit':
      // Simular múltiplas requisições para testar rate limit
      securityAuditLogger.logRateLimitViolation(
        req.ip || 'unknown',
        '/security/test',
        req.get('User-Agent') || undefined,
        100
      );
      break;

    case 'suspicious_activity':
      // Simular atividade suspeita
      securityAuditLogger.logSuspiciousActivity(
        req.ip || 'unknown',
        req.get('User-Agent') || 'unknown',
        'test_activity',
        { test: true }
      );
      break;

    case 'security_attack':
      // Simular ataque de segurança
      securityAuditLogger.logSecurityAttack(
        'test_attack',
        req.ip || 'unknown',
        req.get('User-Agent') || 'unknown',
        '<script>alert("test")</script>',
        true
      );
      break;

    default:
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Tipo de teste inválido',
        validTypes: ['rate_limit', 'suspicious_activity', 'security_attack']
      });
    }

    res.json({
      message: `Teste de segurança '${testType}' executado com sucesso`,
      timestamp: new Date().toISOString()
    });
  } catch {
    next(new HttpError(500, 'SECURITY_TEST_FAILED', 'Erro no teste de segurança'));
  }
});

/**
 * @swagger
 * /security/health:
 *   get:
 *     summary: Health check do subsistema de segurança
 *     tags: [Sistema]
 *     security:
 *       - securityToken: []
 *     responses:
 *       200:
 *         description: Nível de risco diferente de HIGH
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, unhealthy]
 *                 riskLevel:
 *                   type: string
 *                 activeThreats:
 *                   type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       503:
 *         description: Nível de risco HIGH
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 riskLevel:
 *                   type: string
 *       401:
 *         description: Token de segurança ausente ou inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * GET /security/health
 * Health check específico para sistema de segurança
 */
router.get('/health', (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = securityAuditLogger.getSecurityStats();
    const isHealthy = stats.riskLevel !== 'HIGH';

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      riskLevel: stats.riskLevel,
      activeThreats: stats.activeThreats,
      timestamp: new Date().toISOString()
    });
  } catch {
    next(new HttpError(500, 'SECURITY_HEALTH_FAILED', 'Erro no health check de segurança'));
  }
});

export default router;
