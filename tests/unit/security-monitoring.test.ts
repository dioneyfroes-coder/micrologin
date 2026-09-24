import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { securityMonitor } from '../../src/application/middleware/securityMonitoring.js';
import { securityAuditLogger } from '../../src/application/middleware/securityAudit.js';

type Monitor = typeof securityMonitor & Record<string, any>;

const requestLike = (ip: string, userAgent: string) => ({
  ip,
  path: '/login',
  method: 'POST',
  get: (header: string) => (header === 'User-Agent' ? userAgent : null)
});

describe('securityMonitor - limites da mapa de anomalias', () => {
  beforeEach(() => {
    (securityMonitor as Monitor).anomalies = new Map();
    (securityMonitor as Monitor).lastCleanup = 0;
    (securityMonitor as Monitor).clearThreatLog();
  });

  it('remove clientes sem atividade dentro da janela na limpeza periódica', () => {
    const monitor = securityMonitor as Monitor;
    const now = Date.now();
    monitor.anomalies.set('old-client', [
      { timestamp: now - 120000, path: '/login', method: 'POST' }
    ]);
    monitor.anomalies.set('active-client', [
      { timestamp: now - 5000, path: '/login', method: 'POST' }
    ]);

    monitor.cleanupAnomalies(now);

    expect(monitor.anomalies.has('old-client')).toBe(false);
    expect(monitor.anomalies.has('active-client')).toBe(true);
  });

  it('mantém apenas as requisições dentro da janela por cliente', () => {
    const monitor = securityMonitor as Monitor;
    const req = requestLike('1.2.3.4', 'agent-a');
    const now = Date.now();
    monitor.detectAnomalies(req, {}, () => {});

    const entry = monitor.anomalies.get('1.2.3.4agent-a');
    entry.push({ timestamp: now - 120000, path: '/old', method: 'GET' });

    monitor.detectAnomalies(req, {}, () => {});

    const stored = monitor.anomalies.get('1.2.3.4agent-a');
    expect(stored.every((r: { timestamp: number }) => now - r.timestamp < 60000)).toBe(true);
  });

  it('impõe o limite máximo de clientes rastreados', () => {
    const monitor = securityMonitor as Monitor;
    monitor.maxTrackedClients = 3;
    monitor.lastCleanup = 0;
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) {
      monitor.anomalies.set(`client-${i}`, [{ timestamp: now - (5 - i), path: '/', method: 'GET' }]);
    }

    monitor.cleanupAnomalies(now);

    expect(monitor.anomalies.size).toBe(3);
    expect(monitor.anomalies.has('client-4')).toBe(true);
  });

  it('não toma ações punitivas no detectThreats (apenas log)', () => {
    const monitor = securityMonitor as Monitor;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      ip: '1.2.3.4',
      path: '/login',
      body: { user: '<script>alert(1)</script>' },
      get: () => 'agent'
    };
    const next = jest.fn();

    monitor.detectThreats(req, {}, next);

    expect(warnSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(monitor.getThreatStats().totalThreats).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it('detecta path traversal', () => {
    const monitor = securityMonitor as Monitor;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      ip: '9.9.9.9',
      path: '/../../etc/passwd',
      body: {},
      get: () => 'agent'
    };
    const next = jest.fn();

    monitor.detectThreats(req, {}, next);

    expect(monitor.getThreatReport({ type: 'suspicious_pattern' }).length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('gera relatório de ameaças com filtros', () => {
    const monitor = securityMonitor as Monitor;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      ip: '1.2.3.4',
      path: '/login',
      body: { user: 'SELECT * FROM users' },
      get: () => 'agent'
    };

    monitor.detectThreats(req, {}, () => {});
    monitor.detectThreats(req, {}, () => {});

    const byType = monitor.getThreatStats().byType;
    expect(byType.suspicious_pattern).toBeGreaterThanOrEqual(2);

    const filtered = monitor.getThreatReport({ ip: '1.2.3.4' });
    expect(filtered.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('mantém sincronia com o securityAuditLogger', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const before = securityAuditLogger.getSecurityStats().totalRequests;

    (securityMonitor as Monitor).detectThreats({
      ip: '1.2.3.4',
      path: '/login',
      body: { user: '<iframe>' },
      get: () => 'agent'
    }, {}, () => {});

    expect(securityAuditLogger.getSecurityStats().totalRequests).toBeGreaterThan(before);
    warnSpy.mockRestore();
  });
});
