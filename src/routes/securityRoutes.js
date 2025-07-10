/**
 * @fileoverview Rotas para dashboard de segurança
 * Fornece endpoints para monitoramento e métricas de segurança
 */

import { Router } from 'express';
import { securityAuditLogger } from '../middleware/securityAudit.js';
import { securityMonitor } from '../middleware/securityMonitoring.js';
import { advancedRateLimit } from '../middleware/advancetRateLimit.js';

const router = Router();

/**
 * GET /security/stats
 * Retorna estatísticas de segurança
 */
router.get('/stats', (req, res) => {
  try {
    const stats = securityAuditLogger.getSecurityStats();
    const rateLimitStatus = advancedRateLimit.getStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      security: stats,
      rateLimit: rateLimitStatus,
      status: 'operational'
    });
  } catch (error) {
    console.error('Erro ao obter estatísticas de segurança:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Erro ao obter estatísticas de segurança'
    });
  }
});

/**
 * GET /security/report
 * Gera relatório completo de segurança
 */
router.get('/report', (req, res) => {
  try {
    const report = securityAuditLogger.generateSecurityReport();
    
    res.json({
      ...report,
      generated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro ao gerar relatório de segurança:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Erro ao gerar relatório de segurança'
    });
  }
});

/**
 * GET /security/events
 * Retorna eventos de segurança recentes
 */
router.get('/events', (req, res) => {
  try {
    const timeWindow = parseInt(req.query.timeWindow) || 300000; // 5 minutos padrão
    const severity = req.query.severity; // filtro opcional
    
    let events = securityAuditLogger.getRecentEvents(timeWindow);
    
    if (severity) {
      events = events.filter(event => event.severity === severity);
    }
    
    res.json({
      timeWindow,
      severity: severity || 'all',
      count: events.length,
      events
    });
  } catch (error) {
    console.error('Erro ao obter eventos de segurança:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Erro ao obter eventos de segurança'
    });
  }
});

/**
 * GET /security/threats
 * Retorna análise de ameaças
 */
router.get('/threats', (req, res) => {
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
  } catch (error) {
    console.error('Erro ao analisar ameaças:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Erro ao analisar ameaças'
    });
  }
});

/**
 * POST /security/test
 * Endpoint para testar detecção de ameaças (apenas desenvolvimento)
 */
router.post('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Endpoint de teste não disponível em produção'
    });
  }

  try {
    const { testType } = req.body;
    
    switch (testType) {
      case 'rate_limit':
        // Simular múltiplas requisições para testar rate limit
        securityAuditLogger.logRateLimitViolation(
          req.ip,
          '/security/test',
          req.get('User-Agent'),
          100
        );
        break;
        
      case 'suspicious_activity':
        // Simular atividade suspeita
        securityAuditLogger.logSuspiciousActivity(
          req.ip,
          req.get('User-Agent'),
          'test_activity',
          { test: true }
        );
        break;
        
      case 'security_attack':
        // Simular ataque de segurança
        securityAuditLogger.logSecurityAttack(
          'test_attack',
          req.ip,
          req.get('User-Agent'),
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
  } catch (error) {
    console.error('Erro no teste de segurança:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Erro no teste de segurança'
    });
  }
});

/**
 * GET /security/health
 * Health check específico para sistema de segurança
 */
router.get('/health', (req, res) => {
  try {
    const stats = securityAuditLogger.getSecurityStats();
    const isHealthy = stats.riskLevel !== 'HIGH';
    
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      riskLevel: stats.riskLevel,
      activeThreats: stats.activeThreats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro no health check de segurança:', error);
    res.status(500).json({
      status: 'error',
      error: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
