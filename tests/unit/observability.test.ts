import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildObservabilitySnapshot } from '../../src/application/observability/observability.js';
import { requestLogAggregator } from '../../src/application/observability/requestLogAggregator.js';

describe('buildObservabilitySnapshot', () => {
  const original = {
    APP_NAME: process.env.APP_NAME,
    VERSION: process.env.VERSION,
    NODE_ENV: process.env.NODE_ENV,
    LOG_FORMAT: process.env.LOG_FORMAT
  };

  beforeEach(() => {
    requestLogAggregator.reset();
    process.env.LOG_FORMAT = 'structured';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.APP_NAME = original.APP_NAME;
    process.env.VERSION = original.VERSION;
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.LOG_FORMAT = original.LOG_FORMAT;
  });

  it('consolida service, requests, health, security e logging', async() => {
    process.env.APP_NAME = 'auth-service';
    process.env.VERSION = '1.2.3';

    requestLogAggregator.record({ method: 'POST', route: '/login', status: 200, durationMs: 100, timestamp: 1700000000000 });
    requestLogAggregator.record({ method: 'GET', route: '/profile', status: 500, durationMs: 300, timestamp: 1700000000001 });

    const snapshot = await buildObservabilitySnapshot({
      healthCheck: async() => ({ status: 'healthy', services: {} }),
      securityStats: () => ({ riskLevel: 'LOW' }),
      now: () => 1700000000050
    });

    expect(snapshot.timestamp).toBe(new Date(1700000000050).toISOString());
    expect(snapshot.service.name).toBe('auth-service');
    expect(snapshot.service.version).toBe('1.2.3');
    expect(snapshot.service.environment).toBe('test');
    expect(snapshot.service.uptime_s).toBeGreaterThanOrEqual(0);
    expect(snapshot.service.memory.heap_used_mb).toBeGreaterThan(0);

    expect(snapshot.requests.total).toBe(2);
    expect(snapshot.requests.by_status).toEqual({ 200: 1, 500: 1 });
    expect(snapshot.requests.errors['5xx']).toBe(1);
    expect(snapshot.requests.latency_ms.p50).toBe(200);
    expect(snapshot.requests.by_route).toHaveLength(2);

    expect(snapshot.health.status).toBe('healthy');
    expect(snapshot.security).toEqual({ riskLevel: 'LOW' });
    expect(snapshot.logging.format).toBe('structured');
    expect(snapshot.logging.request_id_header).toBe('X-Request-Id');
  });

  it('usa os defaults reais (healthCheck/security) quando nenhuma dependência é injetada', async() => {
    const snapshot = await buildObservabilitySnapshot({ now: () => 1700000000000 });
    expect(snapshot.health).toBeDefined();
    expect(snapshot.security).toBeDefined();
    expect(snapshot.requests.total).toBe(0);
  });
});
