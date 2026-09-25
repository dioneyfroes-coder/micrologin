/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BSV
 *
 * AGREGADOR DOS LOGS DE REQUISIÇÃO (observabilidade "por logs", path próprio)
 *
 * Mantém em memória uma janela rolante de requisições observadas a partir do
 * requestLogger. Sem coleta externa: é a mesma fonte dos logs estruturados,
 * agregada para consulta imediata via GET /observability.
 */

export interface RequestLogObservation {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  timestamp: number;
}

export interface RouteAggregate {
  method: string;
  route: string;
  count: number;
}

export interface RequestLogSnapshot {
  window: {
    max: number;
    current: number;
  };
  total: number;
  by_status: Record<string, number>;
  latency_ms: {
    count: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  errors: {
    '4xx': number;
    '5xx': number;
    rate_pct: number;
  };
  by_route: RouteAggregate[];
  last_request_at: string | null;
}

const DEFAULT_WINDOW = 500;

/**
 * Percentil p (0-100) a partir de amostras ordenadas de forma crescente.
 */
const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

class RequestLogAggregator {
  private samples: RequestLogObservation[] = [];
  private readonly max: number;

  constructor(max: number = DEFAULT_WINDOW) {
    this.max = max;
  }

  record(observation: RequestLogObservation): void {
    this.samples.push(observation);
    if (this.samples.length > this.max) {
      this.samples = this.samples.slice(-this.max);
    }
  }

  reset(): void {
    this.samples = [];
  }

  getSnapshot(limits: { topRoutes?: number } = {}): RequestLogSnapshot {
    const topRoutes = limits.topRoutes ?? 10;
    const total = this.samples.length;

    if (total === 0) {
      return {
        window: { max: this.max, current: 0 },
        total: 0,
        by_status: {},
        latency_ms: {
          count: 0,
          mean: 0,
          p50: 0,
          p90: 0,
          p95: 0,
          p99: 0,
          max: 0
        },
        errors: { '4xx': 0, '5xx': 0, rate_pct: 0 },
        by_route: [],
        last_request_at: null
      };
    }

    const byStatus: Record<string, number> = {};
    const byRoute = new Map<string, RouteAggregate>();
    const durations: number[] = [];

    let sumDuration = 0;
    let count4xx = 0;
    let count5xx = 0;

    for (const sample of this.samples) {
      byStatus[sample.status] = (byStatus[sample.status] ?? 0) + 1;

      const routeKey = `${sample.method} ${sample.route}`;
      const existing = byRoute.get(routeKey);
      if (existing) {
        existing.count += 1;
      } else {
        byRoute.set(routeKey, { method: sample.method, route: sample.route, count: 1 });
      }

      durations.push(sample.durationMs);
      sumDuration += sample.durationMs;

      if (sample.status >= 400 && sample.status < 500) {
        count4xx += 1;
      } else if (sample.status >= 500) {
        count5xx += 1;
      }
    }

    durations.sort((a, b) => a - b);

    const sortedRoutes = [...byRoute.values()].sort((a, b) => b.count - a.count).slice(0, topRoutes);

    return {
      window: { max: this.max, current: total },
      total,
      by_status: byStatus,
      latency_ms: {
        count: total,
        mean: Math.round((sumDuration / total) * 100) / 100,
        p50: Math.round(percentile(durations, 50) * 100) / 100,
        p90: Math.round(percentile(durations, 90) * 100) / 100,
        p95: Math.round(percentile(durations, 95) * 100) / 100,
        p99: Math.round(percentile(durations, 99) * 100) / 100,
        max: durations[durations.length - 1]
      },
      errors: {
        '4xx': count4xx,
        '5xx': count5xx,
        rate_pct: Math.round(((count4xx + count5xx) / total) * 10000) / 100
      },
      by_route: sortedRoutes,
      last_request_at: new Date(this.samples[this.samples.length - 1].timestamp).toISOString()
    };
  }
}

export const requestLogAggregator = new RequestLogAggregator();

export { DEFAULT_WINDOW, percentile };
