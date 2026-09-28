import { describe, it, expect, jest } from '@jest/globals';
import { SecurityAuditLogger } from '../../src/application/middleware/securityAudit.js';

describe('SecurityAuditLogger - auditoria de segurança', () => {
  const makeLogger = () => new SecurityAuditLogger();

  it('registra tentativa de login (sucesso como info, falha como warning)', () => {
    const successSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'success');
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'failure', 'Senha incorreta');

    const stats = audit.getSecurityStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.loginAttempts).toBe(2);
    expect(stats.failedLogins).toBe(1);
    expect(stats.successfulLogins).toBe(1);
    expect(stats.recentEvents).toBe(2);
    expect(audit.getRecentEvents()[1].details.reason).toBe('Senha incorreta');
    // O rótulo viaja no evento, para nenhum consumidor reinterpretar o
    // resultado a partir de um booleano paralelo.
    expect(audit.getRecentEvents()[0].details.outcome).toBe('success');
    expect(audit.getRecentEvents()[1].details.outcome).toBe('failure');
    // A auditoria alerta só a falha. O evento em si é publicado no log
    // estruturado (é o que sustenta a retrospectiva), mas um login correto não
    // pode virar alerta.
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(successSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[SECURITY]'),
      expect.anything()
    );

    successSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('mantém `atMs` e `timestamp` no mesmo instante', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logIPBlock('1.2.3.4', 'muitas tentativas', 60000);

    const event = audit.getRecentEvents()[0];
    // Se os dois divergirem, `getRecentEvents` filtra por um instante e a API
    // mostra outro: o relatório contaria como recente um evento velho.
    expect(event.atMs).toBe(new Date(event.timestamp).getTime());

    warnSpy.mockRestore();
  });

  it('`getRecentEvents` usa a janela, não a ordem de inserção', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logIPBlock('1.2.3.4', 'antigo', 60000);
    // Envelhece o primeiro evento além da janela padrão de 5 minutos.
    audit.getRecentEvents()[0].atMs -= 600000;
    audit.logIPBlock('5.6.7.8', 'recente', 60000);

    const ids = audit.getRecentEvents().map(e => e.ip);
    expect(ids).toEqual(['5.6.7.8']);

    warnSpy.mockRestore();
  });

  it('contabiliza sucesso e falha em contadores separados, nunca somados', () => {
    const successSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    for (let i = 0; i < 3; i++) {
      audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'success');
    }
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'failure', 'Senha incorreta');

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

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'success');

    expect(audit.getSecurityStats().failedLogins).toBe(0);
    expect(audit.getSecurityStats().successfulLogins).toBe(1);

    successSpy.mockRestore();
  });

  it('revogação indisponível é bucket próprio, não falha de credencial', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'REVOCATION_UNAVAILABLE', 'Revogação indisponível');

    const stats = audit.getSecurityStats();
    // A recusa aconteceu, e o total a vê...
    expect(stats.loginAttempts).toBe(1);
    // ...mas o bucket de ataque fica limpo: `failedLogins` é o que o alerta de
    // força bruta lê, e uma queda do Redis não é evidência de ataque.
    expect(stats.failedLogins).toBe(0);
    expect(stats.unavailableLogins).toBe(1);
    expect(audit.getRecentEvents()[0].details.outcome).toBe('unavailable');

    warnSpy.mockRestore();
  });

  it('queda do Redis não dispara o alerta de múltiplos logins falhos', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    // Cinco recusas de infraestrutura: acima do limiar de falha de credencial.
    for (let i = 0; i < 5; i += 1) {
      audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'REVOCATION_UNAVAILABLE', 'Revogação indisponível');
    }

    const alertCalls = warnSpy.mock.calls.filter(([message]) =>
      String(message).includes('MULTIPLE_FAILED_LOGINS')
    );
    expect(alertCalls).toHaveLength(0);
    expect(audit.getSecurityStats().unavailableLogins).toBe(5);

    warnSpy.mockRestore();
  });

  it('cinco senhas erradas continuam disparando o alerta', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    for (let i = 0; i < 5; i += 1) {
      audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'failure', 'Senha incorreta');
    }

    const alertCalls = warnSpy.mock.calls.filter(([message]) =>
      String(message).includes('MULTIPLE_FAILED_LOGINS')
    );
    expect(alertCalls.length).toBeGreaterThan(0);
    expect(audit.getSecurityStats().failedLogins).toBe(5);

    warnSpy.mockRestore();
  });

  it('os três desfechos de login somam o total de tentativas', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'success');
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'failure', 'Senha incorreta');
    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'REVOCATION_UNAVAILABLE', 'Revogação indisponível');

    const stats = audit.getSecurityStats();
    // A identidade é o que impede um desfecho de ser contado em dois lugares
    // (ou de nenhum) quando um novo rótulo entra no vocabulário.
    expect(stats.loginAttempts).toBe(
      stats.successfulLogins + stats.failedLogins + stats.unavailableLogins
    );

    warnSpy.mockRestore();
  });

  it('recomenda verificar o armazenamento quando houve login indisponível', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeLogger();

    audit.logLoginAttempt('alice', '1.2.3.4', 'agent', 'REVOCATION_UNAVAILABLE', 'Revogação indisponível');

    const recommendations = audit.getSecurityRecommendations();
    expect(recommendations.some((r) => r.includes('armazenamento de revogação'))).toBe(true);

    warnSpy.mockRestore();
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
});
