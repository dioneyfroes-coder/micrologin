import { describe, it, expect, beforeEach } from '@jest/globals';
import { securityMonitor } from '../../src/application/middleware/securityMonitoring.js';

const requestLike = (ip, userAgent) => ({
  ip,
  path: '/login',
  method: 'POST',
  get: (header) => (header === 'User-Agent' ? userAgent : null)
});

describe('securityMonitor - limites da mapa de anomalias', () => {
  beforeEach(() => {
    securityMonitor.anomalies = new Map();
    securityMonitor.lastCleanup = 0;
  });

  it('remove clientes sem atividade dentro da janela na limpeza periódica', () => {
    const now = Date.now();
    securityMonitor.anomalies.set('old-client', [
      { timestamp: now - 120000, path: '/login', method: 'POST' }
    ]);
    securityMonitor.anomalies.set('active-client', [
      { timestamp: now - 5000, path: '/login', method: 'POST' }
    ]);

    securityMonitor.cleanupAnomalies(now);

    expect(securityMonitor.anomalies.has('old-client')).toBe(false);
    expect(securityMonitor.anomalies.has('active-client')).toBe(true);
  });

  it('mantém apenas as requisições dentro da janela por cliente', () => {
    const monitor = securityMonitor;
    const req = requestLike('1.2.3.4', 'agent-a');
    const now = Date.now();
    monitor.detectAnomalies(req, {}, () => {});

    const entry = monitor.anomalies.get('1.2.3.4agent-a');
    entry.push({ timestamp: now - 120000, path: '/old', method: 'GET' });

    monitor.detectAnomalies(req, {}, () => {});

    const stored = monitor.anomalies.get('1.2.3.4agent-a');
    expect(stored.every((r) => now - r.timestamp < 60000)).toBe(true);
  });

  it('impõe o limite máximo de clientes rastreados', () => {
    const monitor = securityMonitor;
    monitor.maxTrackedClients = 3;
    monitor.lastCleanup = 0;
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) {
      monitor.anomalies.set(`client-${i}`, [{ timestamp: now - (5 - i), path: '/', method: 'GET' }]);
    }

    monitor.cleanupAnomalies(now);

    expect(monitor.anomalies.size).toBe(3);
    expect(monitor.anomalies.has('client-0')).toBe(false);
    expect(monitor.anomalies.has('client-1')).toBe(false);
    expect(monitor.anomalies.has('client-4')).toBe(true);
  });
});
