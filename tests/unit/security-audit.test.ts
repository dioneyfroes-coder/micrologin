import { describe, it, expect, jest } from '@jest/globals';
import { SecurityAuditLogger } from '../../src/application/middleware/securityAudit.js';

describe('SecurityAuditLogger - auditoria de segurança', () => {
  const makeLogger = () => new SecurityAuditLogger();

  it('registra tentativa de login (sucesso como info, falha como warning)', () => {
    const successSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', true);
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', false, 'Senha incorreta');

    const stats = audit.getSecurityStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.loginAttempts).toBe(2);
    expect(stats.failedLogins).toBe(1);
    expect(stats.successfulLogins).toBe(1);
    expect(stats.recentEvents).toBe(2);
    expect(audit.getRecentEvents()[1].details.reason).toBe('Senha incorreta');
    expect(warnSpy).toHaveBeenCalled();
    expect(successSpy).not.toHaveBeenCalled();

    successSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('contabiliza sucesso e falha em contadores separados, nunca somados', () => {
    const successSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    for (let i = 0; i < 3; i++) {
      audit.logLoginAttempt('alice', '1.2.3.4', 'agent', true);
    }
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', false, 'Senha incorreta');

    const stats = audit.getSecurityStats();
    expect(stats.loginAttempts).toBe(4);
    expect(stats.successfulLogins).toBe(3);
    expect(stats.failedLogins).toBe(1);
    expect(stats.loginAttempts).toBe(stats.successfulLogins + stats.failedLogins);

    successSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('login bem-sucedido nunca alimenta o contador de falhas', () => {
    const successSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', true);

    expect(audit.getSecurityStats().failedLogins).toBe(0);
    expect(audit.getSecurityStats().successfulLogins).toBe(1);

    successSpy.mockRestore();
  });

  it('registra bloqueio de IP como warning e atualiza blockedRequests', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logIPBlock('1.2.3.4', 'força bruta', 3600);

    expect(audit.getSecurityStats().blockedRequests).toBe(1);
    warnSpy.mockRestore();
  });

  it('registra violação de rate limit', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logRateLimitViolation('1.2.3.4', '/login', 'agent', 5);

    expect(audit.getSecurityStats().blockedRequests).toBe(1);
    warnSpy.mockRestore();
  });

  it('registra atividade suspeita e ataque de segurança', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logSuspiciousActivity('1.2.3.4', 'agent', 'muitas requisições', {});
    audit.logSecurityAttack('SQL_INJECTION', '1.2.3.4', 'agent', 'SELECT * FROM users; --');

    const stats = audit.getSecurityStats();
    expect(stats.suspiciousActivities).toBe(1);
    expect(stats.blockedRequests).toBe(1);
    warnSpy.mockRestore();
  });

  it('mantém o log limitado aos últimos 1000 eventos', () => {
    const audit = makeLogger();

    for (let i = 0; i < 1010; i += 1) {
      audit.logSecurityEvent(`event_${i}`, { ip: '1.2.3.4' }, 'info');
    }

    const report = audit.generateSecurityReport();
    expect(report.recentEvents.length).toBeLessThanOrEqual(1000);
  });

  it('calcula o nível de risco a partir da severidade', () => {
    const audit = makeLogger();
    expect(audit.calculateRiskLevel([])).toBe('MINIMAL');

    const mixed = [
      { severity: 'error' },
      { severity: 'error' },
      { severity: 'error' },
      { severity: 'warning' }
    ] as never[];
    expect(audit.calculateRiskLevel(mixed)).toBe('MEDIUM');

    const high = Array.from({ length: 7 }, () => ({ severity: 'error' })) as never[];
    expect(audit.calculateRiskLevel(high)).toBe('HIGH');
  });

  it('gera recomendações conforme o risco', () => {
    const audit = makeLogger();
    audit.getSecurityStats();

    // Forçar nível HIGH simulando muitos eventos de erro
    for (let i = 0; i < 20; i += 1) {
      audit.logSecurityAttack('XSS', '1.2.3.4', 'agent', 'payload');
    }

    const recommendations = audit.getSecurityRecommendations();
    expect(recommendations).toContain('Considere implementar CAPTCHA temporário');
  });

  it('gera IDs exclusivos de evento', () => {
    const audit = makeLogger();
    const ids = new Set([audit.generateEventId(), audit.generateEventId(), audit.generateEventId()]);
    expect(ids.size).toBe(3);
  });

  it('mapeia severidade para emoji', () => {
    const audit = makeLogger();
    expect(audit.getEmojiForSeverity('error')).toBe('🚨');
    expect(audit.getEmojiForSeverity('warning')).toBe('⚠️');
    expect(audit.getEmojiForSeverity('info')).toBe('ℹ️');
  });
});
