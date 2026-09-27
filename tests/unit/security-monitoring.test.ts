import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { securityMonitor } from '../../src/application/middleware/securityMonitoring.js';
import { securityAuditLogger } from '../../src/application/middleware/securityAudit.js';

type Monitor = typeof securityMonitor & Record<string, any>;

const requestLike = (over: { ip?: string; path?: string; body?: unknown; userAgent?: string }) => ({
  ip: over.ip ?? '1.2.3.4',
  path: over.path ?? '/login',
  method: 'POST',
  body: over.body ?? {},
  get: (header: string) => (header === 'User-Agent' ? (over.userAgent ?? 'agent') : null)
});

/**
 * Os eventos do monitor vivem no `securityAuditLogger`, que é o buffer único do
 * processo. Estes testes leem de lá, e não de um segundo histórico — que foi
 * removido por duplicar esse sem ter consumidor.
 */
const securityEventsOf = (type: string) =>
  securityAuditLogger.getRecentEvents(300000).filter(event => event.type === type);

describe('securityMonitor - detecção de padrões suspeitos', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('não toma ações punitivas no detectThreats (apenas log)', () => {
    const monitor = securityMonitor as Monitor;
    const next = jest.fn();

    monitor.detectThreats(requestLike({ body: { user: '<script>alert(1)</script>' } }), {}, next);

    expect(warnSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    // `next` sem argumento: o monitor não encerra a requisição.
    expect(next).toHaveBeenCalledWith();
  });

  it('detecta script inline e registra no buffer de auditoria', () => {
    const monitor = securityMonitor as Monitor;
    const next = jest.fn();

    monitor.detectThreats(
      requestLike({ body: { user: '<script>alert(1)</script>' }, path: '/login' }),
      {},
      next
    );

    const events = securityEventsOf('suspicious_pattern_detected');
    expect(events.length).toBeGreaterThan(0);

    const event = events[events.length - 1];
    expect(event.severity).toBe('warning');
    expect(event.ip).toBe('1.2.3.4');
    expect((event.details.patterns as string[]).join(' ')).toContain('script');
    expect(event.details.path).toBe('/login');
  });

  it('detecta path traversal', () => {
    const monitor = securityMonitor as Monitor;

    monitor.detectThreats(requestLike({ path: '/../../etc/passwd', body: {} }), {}, () => {});

    const events = securityEventsOf('suspicious_pattern_detected');
    expect(events[events.length - 1].details.path).toBe('/../../etc/passwd');
  });

  it('detecta padrão de SQL no corpo', () => {
    const monitor = securityMonitor as Monitor;

    monitor.detectThreats(requestLike({ body: { user: 'SELECT * FROM users' } }), {}, () => {});

    const events = securityEventsOf('suspicious_pattern_detected');
    expect((events[events.length - 1].details.patterns as string[]).join(' ')).toContain('select');
  });

  it('registra uma entrada só por requisição suspeita, mesmo com vários padrões', () => {
    const monitor = securityMonitor as Monitor;
    const before = securityEventsOf('suspicious_pattern_detected').length;

    // Três padrões distintos no mesmo payload.
    monitor.detectThreats(
      requestLike({ body: { a: '<script>x</script>', b: 'javascript:alert(1)', c: 'vbscript:x' } }),
      {},
      () => {}
    );

    const after = securityEventsOf('suspicious_pattern_detected');
    expect(after.length - before).toBe(1);
    expect((after[after.length - 1].details.patterns as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it('requisição limpa não registra evento de segurança', () => {
    const monitor = securityMonitor as Monitor;
    const next = jest.fn();
    const before = securityEventsOf('suspicious_pattern_detected').length;

    monitor.detectThreats(requestLike({ body: { user: 'ana', password: 'x' } }), {}, next);

    expect(securityEventsOf('suspicious_pattern_detected').length).toBe(before);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('mantém sincronia com o securityAuditLogger', () => {
    const monitor = securityMonitor as Monitor;
    const before = securityAuditLogger.getSecurityStats().totalRequests;

    monitor.detectThreats(requestLike({ body: { user: '<iframe>' } }), {}, () => {});

    expect(securityAuditLogger.getSecurityStats().totalRequests).toBeGreaterThan(before);
  });
});
