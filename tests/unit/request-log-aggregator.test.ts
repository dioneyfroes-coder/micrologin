import { describe, it, expect, beforeEach } from '@jest/globals';
import { requestLogAggregator, percentile } from '../../src/application/observability/requestLogAggregator.js';

const now = Date.now();

describe('requestLogAggregator', () => {
  beforeEach(() => {
    requestLogAggregator.reset();
  });

  it('percentile calcula p50/p90/p95/p99 de amostras ordenadas', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 90)).toBeCloseTo(4.6);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });

  it('retorna snapshot zerado sem observações', () => {
    const snapshot = requestLogAggregator.getSnapshot();
    expect(snapshot.total).toBe(0);
    expect(snapshot.by_status).toEqual({});
    expect(snapshot.errors.rate_pct).toBe(0);
    expect(snapshot.by_route).toEqual([]);
    expect(snapshot.last_request_at).toBeNull();
  });

  it('agrega por status e rota, calcula latências e taxa de erro', () => {
    requestLogAggregator.record({ method: 'POST', route: '/login', status: 200, durationMs: 100, timestamp: now });
    requestLogAggregator.record({ method: 'POST', route: '/login', status: 200, durationMs: 200, timestamp: now });
    requestLogAggregator.record({ method: 'GET', route: '/profile', status: 401, durationMs: 300, timestamp: now });
    requestLogAggregator.record({ method: 'GET', route: '/profile', status: 500, durationMs: 500, timestamp: now });

    const snapshot = requestLogAggregator.getSnapshot();

    expect(snapshot.total).toBe(4);
    expect(snapshot.window.current).toBe(4);
    expect(snapshot.by_status).toEqual({ 200: 2, 401: 1, 500: 1 });
    expect(snapshot.latency_ms.mean).toBeCloseTo(275);
    expect(snapshot.latency_ms.p50).toBeCloseTo(250);
    expect(snapshot.errors['4xx']).toBe(1);
    expect(snapshot.errors['5xx']).toBe(1);
    expect(snapshot.errors.rate_pct).toBe(50);
    expect(snapshot.by_route).toHaveLength(2);
    expect(snapshot.by_route[0]).toEqual({ method: 'POST', route: '/login', count: 2 });
    expect(snapshot.last_request_at).toBe(new Date(now).toISOString());
  });

  it('respeita a janela (descarta as observações mais antigas) e o corte de rotas', () => {
    for (let i = 0; i < 505; i += 1) {
      requestLogAggregator.record({ method: 'GET', route: '/a', status: 200, durationMs: 1, timestamp: now + i });
    }
    requestLogAggregator.record({ method: 'GET', route: '/b', status: 200, durationMs: 1, timestamp: now + 600 });
    requestLogAggregator.record({ method: 'GET', route: '/a', status: 200, durationMs: 1, timestamp: now + 700 });

    const snapshot = requestLogAggregator.getSnapshot({ topRoutes: 1 });
    expect(snapshot.window.current).toBe(500);
    expect(snapshot.total).toBe(500);
    expect(snapshot.by_route).toHaveLength(1);
    expect(snapshot.by_route[0].route).toBe('/a');
    expect(snapshot.by_route[0].count).toBe(499);
    expect(snapshot.by_status['200']).toBe(500);
  });
});
