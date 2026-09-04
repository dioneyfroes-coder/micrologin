/**
 * @fileoverview Sistema de auditoria de segurança
 * Registra todos os eventos de segurança para análise e alertas
 */

class SecurityAuditLogger {
  constructor() {
    this.events = [];
    this.alertThresholds = {
      failedLogins: 5,
      blockedIPs: 3,
      suspiciousActivity: 10
    };
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      failedLogins: 0,
      suspiciousActivities: 0
    };
  }

  /**
   * Registra evento de segurança
   */
  logSecurityEvent(type, details, severity = 'info') {
    const event = {
      timestamp: new Date().toISOString(),
      type,
      details,
      severity,
      ip: details.ip || 'unknown',
      userAgent: details.userAgent || 'unknown',
      id: this.generateEventId()
    };

    this.events.push(event);
    this.updateStats(type);
    this.logToConsole(event);
    this.checkAlerts(type);

    // Manter apenas os últimos 1000 eventos
    if (this.events.length > 1000) {
      this.events.shift();
    }
  }

  /**
   * Registra tentativa de login
   */
  logLoginAttempt(username, ip, userAgent, success = true) {
    this.logSecurityEvent('login_attempt', {
      username,
      ip,
      userAgent,
      success,
      timestamp: Date.now()
    }, success ? 'info' : 'warning');
  }

  /**
   * Registra bloqueio de IP
   */
  logIPBlock(ip, reason, duration) {
    this.logSecurityEvent('ip_blocked', {
      ip,
      reason,
      duration,
      timestamp: Date.now()
    }, 'warning');
  }

  /**
   * Registra atividade suspeita
   */
  logSuspiciousActivity(ip, userAgent, activity, details) {
    this.logSecurityEvent('suspicious_activity', {
      ip,
      userAgent,
      activity,
      details,
      timestamp: Date.now()
    }, 'warning');
  }

  /**
   * Registra violação de rate limit
   */
  logRateLimitViolation(ip, path, userAgent, limit) {
    this.logSecurityEvent('rate_limit_violation', {
      ip,
      path,
      userAgent,
      limit,
      timestamp: Date.now()
    }, 'warning');
  }

  /**
   * Registra tentativa de ataque
   */
  logSecurityAttack(type, ip, userAgent, payload, blocked = true) {
    this.logSecurityEvent('security_attack', {
      type,
      ip,
      userAgent,
      payload: payload.substring(0, 200), // Limitar tamanho
      blocked,
      timestamp: Date.now()
    }, 'error');
  }

  /**
   * Gera ID único para evento
   */
  generateEventId() {
    return `sec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Atualiza estatísticas
   */
  updateStats(type) {
    this.stats.totalRequests++;

    switch (type) {
    case 'login_attempt':
      this.stats.failedLogins++;
      break;
    case 'ip_blocked':
    case 'rate_limit_violation':
    case 'security_attack':
      this.stats.blockedRequests++;
      break;
    case 'suspicious_activity':
      this.stats.suspiciousActivities++;
      break;
    }
  }

  /**
   * Log formatado no console
   */
  logToConsole(event) {
    const emoji = this.getEmojiForSeverity(event.severity);
    const timestamp = event.timestamp;

    console.log(`${emoji} [SECURITY] ${timestamp} - ${event.type.toUpperCase()}`);
    console.log(`   IP: ${event.ip} | UserAgent: ${event.userAgent}`);
    console.log('   Details:', event.details);
  }

  /**
   * Verifica se deve disparar alertas
   */
  checkAlerts(type) {
    const recentEvents = this.getRecentEvents(300000); // 5 minutos
    const typeEvents = recentEvents.filter(e => e.type === type);

    if (type === 'login_attempt' && typeEvents.length >= this.alertThresholds.failedLogins) {
      this.triggerAlert('MULTIPLE_FAILED_LOGINS', typeEvents);
    }

    if (type === 'ip_blocked' && typeEvents.length >= this.alertThresholds.blockedIPs) {
      this.triggerAlert('MULTIPLE_IP_BLOCKS', typeEvents);
    }

    if (type === 'suspicious_activity' && typeEvents.length >= this.alertThresholds.suspiciousActivity) {
      this.triggerAlert('HIGH_SUSPICIOUS_ACTIVITY', typeEvents);
    }
  }

  /**
   * Dispara alerta de segurança
   */
  triggerAlert(alertType, events) {
    console.warn(`🚨 ALERTA DE SEGURANÇA: ${alertType}`);
    console.warn(`   Eventos detectados: ${events.length}`);
    console.warn('   Último evento:', events[events.length - 1]);

    // Aqui poderia integrar com sistemas de notificação
    // (email, Slack, SMS, etc.)
  }

  /**
   * Retorna eventos recentes
   */
  getRecentEvents(timeWindow = 300000) {
    const now = Date.now();
    return this.events.filter(event => {
      const eventTime = new Date(event.timestamp).getTime();
      return now - eventTime < timeWindow;
    });
  }

  /**
   * Retorna estatísticas de segurança
   */
  getSecurityStats() {
    const recentEvents = this.getRecentEvents();

    return {
      ...this.stats,
      recentEvents: recentEvents.length,
      activeThreats: recentEvents.filter(e => e.severity === 'error').length,
      riskLevel: this.calculateRiskLevel(recentEvents)
    };
  }

  /**
   * Calcula nível de risco
   */
  calculateRiskLevel(recentEvents) {
    const errors = recentEvents.filter(e => e.severity === 'error').length;
    const warnings = recentEvents.filter(e => e.severity === 'warning').length;

    const score = (errors * 3) + (warnings * 1);

    if (score >= 20) {
      return 'HIGH';
    }
    if (score >= 10) {
      return 'MEDIUM';
    }
    if (score >= 5) {
      return 'LOW';
    }
    return 'MINIMAL';
  }

  /**
   * Retorna emoji para severidade
   */
  getEmojiForSeverity(severity) {
    switch (severity) {
    case 'error': return '🚨';
    case 'warning': return '⚠️';
    case 'info': return 'ℹ️';
    default: return '📝';
    }
  }

  /**
   * Gera relatório de segurança
   */
  generateSecurityReport() {
    const stats = this.getSecurityStats();
    const recentEvents = this.getRecentEvents();

    return {
      timestamp: new Date().toISOString(),
      stats,
      recentEvents,
      topAttackTypes: this.getTopAttackTypes(),
      topAttackIPs: this.getTopAttackIPs(),
      recommendations: this.getSecurityRecommendations()
    };
  }

  /**
   * Retorna tipos de ataque mais comuns
   */
  getTopAttackTypes() {
    const attacks = this.events.filter(e => e.type === 'security_attack');
    const types = {};

    attacks.forEach(attack => {
      const type = attack.details.type;
      types[type] = (types[type] || 0) + 1;
    });

    return Object.entries(types)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));
  }

  /**
   * Retorna IPs mais maliciosos
   */
  getTopAttackIPs() {
    const attacks = this.events.filter(e => e.severity === 'warning' || e.severity === 'error');
    const ips = {};

    attacks.forEach(attack => {
      const ip = attack.ip;
      ips[ip] = (ips[ip] || 0) + 1;
    });

    return Object.entries(ips)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([ip, count]) => ({ ip, count }));
  }

  /**
   * Gera recomendações de segurança
   */
  getSecurityRecommendations() {
    const stats = this.getSecurityStats();
    const recommendations = [];

    if (stats.riskLevel === 'HIGH') {
      recommendations.push('Considere implementar CAPTCHA temporário');
      recommendations.push('Revise logs de segurança manualmente');
    }

    if (stats.blockedRequests > 100) {
      recommendations.push('Analise padrões de ataque para melhorar filtros');
    }

    if (stats.failedLogins > 50) {
      recommendations.push('Considere implementar autenticação de dois fatores');
    }

    return recommendations;
  }
}

// Instância global do logger de auditoria
export const securityAuditLogger = new SecurityAuditLogger();
