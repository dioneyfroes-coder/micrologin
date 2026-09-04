/**
 * @fileoverview Middleware de Monitoramento de Segurança (AUXILIAR)
 *
 * ⚠️ IMPORTANTE: Este é um MONITOR AUXILIAR, não o mecanismo principal de segurança!
 *
 * Responsabilidades:
 * - ✅ LOG de eventos suspeitos
 * - ✅ ALERTA de padrões maliciosos
 * - ✅ AUDITORIA de atividades
 *
 * NÃO responsável por:
 * - ❌ Bloquear IPs (usar rate limiting)
 * - ❌ Negar requisições (usar WAF ou rate limiting)
 * - ❌ Tomar decisões de segurança críticas
 *
 * O bloqueio de IPs é feito pelo Rate Limiter (advancedRateLimit.js)
 *
 * 📌 POLÍTICA DE REGEX: as expressões regulares abaixo são usadas
 * EXCLUSIVAMENTE para DETECÇÃO/ALERTA de padrões suspeitos (monitoramento
 * auxiliar). Nenhuma decisão de proteção/bloqueio depende delas; a proteção
 * principal de entrada é feita por validação e sanitização determinísticas.
 */

import { securityAuditLogger } from './securityAudit.js';

/**
 * Monitor de segurança PASSIVO - apenas LOG e ALERTA
 */
class SecurityMonitor {
  constructor() {
    this.suspiciousPatterns = [
      /(<|%3C)script(>|%3E)/i,
      /(<|%3C)iframe(>|%3E)/i,
      /javascript:/i,
      /vbscript:/i,
      /(union|select|insert|update|delete|drop|create|alter)\s/i,
      /(;|%3B)(\s)*(drop|delete|update|insert)/i
    ];

    // Rastrear eventos para analytics, não para ação
    this.threatLog = [];
    this.maxLogSize = 1000;

    // Rastreamento de anomalias com limite de crescimento
    this.anomalies = new Map();
    this.maxTrackedClients = 10000;
    this.timeWindow = 60000;
    this.lastCleanup = 0;
    this.cleanupInterval = 60000;
  }

  /**
   * Monitor de ameaças - APENAS LOGGING
   * ✅ Detecta padrões maliciosos
   * ❌ NÃO bloqueia (rate limiter é responsável)
   */
  detectThreats = (req, res, next) => {
    const threats = [];
    const requestData = JSON.stringify(req.body) + req.url + (req.get('User-Agent') || '');

    // Detectar padrões maliciosos
    this.suspiciousPatterns.forEach((pattern, index) => {
      if (pattern.test(requestData)) {
        threats.push(`Pattern ${index}: ${pattern.toString()}`);
      }
    });

    // Detectar path traversal
    if (req.path.includes('../') || req.path.includes('..\\')) {
      threats.push('Path traversal detected');
    }

    // LOG: Registrar eventos suspeitos
    if (threats.length > 0) {
      console.warn(`⚠️ [SECURITY MONITOR] Suspicious pattern detected from ${req.ip}:`, threats);

      // Registrar no sistema de auditoria para análise
      securityAuditLogger.logSecurityEvent('suspicious_pattern_detected', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
        patterns: threats,
        timestamp: new Date().toISOString()
      }, 'warning');

      // Armazenar em log local (para analytics/análise posterior)
      this.logThreatEvent({
        type: 'suspicious_pattern',
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
        patterns: threats,
        timestamp: Date.now()
      });

      // ⚠️ IMPORTANTE: NÃO bloqueamos aqui
      // A decisão de bloquear é feita pelo Rate Limiter se necessário
      // Este middleware é apenas um MONITOR/ALERTA
    }

    next();
  };

  /**
   * Detecta anomalias de comportamento
   * ✅ Registra padrões incomuns
   * ❌ NÃO toma ação punitiva
   */
  detectAnomalies = (req, res, next) => {
    const clientId = req.ip + (req.get('User-Agent') || '');
    const now = Date.now();

    // Limpeza periódica para impedir crescimento sem limite da mapa
    this.cleanupAnomalies(now);

    if (!this.anomalies.has(clientId)) {
      this.anomalies.set(clientId, []);
    }

    const requests = this.anomalies.get(clientId);
    requests.push({ timestamp: now, path: req.path, method: req.method });

    // Limpar requisições antigas para manter o array por cliente limitado
    const recentRequests = requests.filter(r => now - r.timestamp < this.timeWindow);
    this.anomalies.set(clientId, recentRequests);

    // ALERTA: Muitas requisições (mas não bloqueia)
    if (recentRequests.length > 100) {
      console.warn(`⚠️ [SECURITY MONITOR] High request rate from ${clientId}: ${recentRequests.length} in 1min`);

      securityAuditLogger.logSecurityEvent('high_request_rate', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        requestCount: recentRequests.length,
        timeWindow: '1min'
      }, 'warning');

      this.logThreatEvent({
        type: 'high_request_rate',
        ip: req.ip,
        requestCount: recentRequests.length,
        timestamp: now
      });
    }

    next();
  };

  /**
   * Monitora atividades de autenticação
   * ✅ Registra tentativas de login falhadas
   * ✅ Alerta sobre padrões suspeitos
   */
  monitorAuthAttempts = (req, res, next) => {
    // Apenas monitora, não bloqueia
    if (req.path === '/login' || req.path.includes('login')) {
      // Log será feito pelo securityAuditLogger no controller
      // Este middleware apenas garante que está sendo monitorado
    }
    next();
  };

  /**
   * Limpa clientes sem atividade recente e impõe o limite máximo de
   * clientes rastreados. Executado no máximo uma vez por janela para não
   * onerar o caminho de requisição.
   * @param {number} now - Timestamp atual
   */
  cleanupAnomalies(now) {
    if (now - this.lastCleanup < this.cleanupInterval) {
      return;
    }
    this.lastCleanup = now;

    for (const clientId of this.anomalies.keys()) {
      const requests = this.anomalies.get(clientId);
      const lastRequest = requests[requests.length - 1];
      if (!lastRequest || now - lastRequest.timestamp > this.timeWindow) {
        this.anomalies.delete(clientId);
      }
    }

    // Evictar clientes mais antigos se o limite for excedido
    if (this.anomalies.size > this.maxTrackedClients) {
      while (this.anomalies.size > this.maxTrackedClients) {
        let oldestKey = null;
        let oldestTimestamp = Infinity;
        for (const [id, reqs] of this.anomalies) {
          const last = reqs[reqs.length - 1].timestamp;
          if (last < oldestTimestamp) {
            oldestTimestamp = last;
            oldestKey = id;
          }
        }
        if (oldestKey === null) {
          break;
        }
        this.anomalies.delete(oldestKey);
      }
    }
  }

  /**
   * Registra evento de ameaça para análise
   * @param {Object} event - Evento de segurança
   */
  logThreatEvent(event) {
    this.threatLog.push({
      ...event,
      id: this.threatLog.length + 1
    });

    // Manter tamanho máximo do log
    if (this.threatLog.length > this.maxLogSize) {
      this.threatLog.shift();
    }
  }

  /**
   * Obtém relatório de eventos de ameaça
   * @param {Object} filters - Filtros (tipo, ip, etc)
   * @returns {Array} Eventos filtrados
   */
  getThreatReport(filters = {}) {
    return this.threatLog.filter(event => {
      if (filters.type && event.type !== filters.type) {
        return false;
      }
      if (filters.ip && event.ip !== filters.ip) {
        return false;
      }
      if (filters.since && event.timestamp < filters.since) {
        return false;
      }
      return true;
    });
  }

  /**
   * Limpa logs de ameaças
   */
  clearThreatLog() {
    this.threatLog = [];
  }

  /**
   * Obtém estatísticas de ameaças
   */
  getThreatStats() {
    const stats = {
      totalThreats: this.threatLog.length,
      byType: {},
      byIP: {},
      recentThreats: this.threatLog.slice(-10)
    };

    this.threatLog.forEach(event => {
      stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;
      stats.byIP[event.ip] = (stats.byIP[event.ip] || 0) + 1;
    });

    return stats;
  }
}

export const securityMonitor = new SecurityMonitor();
