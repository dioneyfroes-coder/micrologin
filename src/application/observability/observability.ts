/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-0BSW
 *
 * SNAPSHOT DE OBSERVABILIDADE (path próprio, baseado em logs)
 *
 * Constrói um manifesto JSON único e autossuficiente para GET /observability:
 * informações do serviço, agregados dos logs de requisição (janela rolante),
 * health das dependências, estatísticas de segurança e configuração de logs.
 * Nenhuma ferramenta/coletor externo é necessário.
 */
import { performHealthCheck } from '../../shared/utils/healthCheck.js';
import { securityAuditLogger } from '../middleware/securityAudit.js';
import { requestLogAggregator } from './requestLogAggregator.js';

interface HealthReportLike {
  status: string;
  timestamp?: string;
  responseTime?: string;
  version?: string;
  environment?: string;
  services?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

interface ObservabilityDeps {
  healthCheck?: () => Promise<HealthReportLike>;
  securityStats?: () => Record<string, unknown>;
  now?: () => number;
}

export interface ObservabilitySnapshot {
  timestamp: string;
  service: {
    name: string;
    version: string;
    environment: string;
    pid: number;
    uptime_s: number;
    started_at: string;
    node: string;
    platform: string;
    arch: string;
    memory: {
      rss_mb: number;
      heap_used_mb: number;
      heap_total_mb: number;
      external_mb: number;
    };
  };
  requests: ReturnType<typeof requestLogAggregator.getSnapshot>;
  health: HealthReportLike;
  security: Record<string, unknown>;
  logging: {
    format: 'structured' | 'console';
    level: string;
    request_id_header: string;
    payload: string;
  };
}

export const buildObservabilitySnapshot = async(deps: ObservabilityDeps = {}): Promise<ObservabilitySnapshot> => {
  const now = deps.now ?? (() => Date.now());

  const [health] = await Promise.all([(deps.healthCheck ?? performHealthCheck)()]);
  const security = deps.securityStats ? deps.securityStats() : securityAuditLogger.getSecurityStats();
  const requests = requestLogAggregator.getSnapshot();

  const memory = process.memoryUsage();
  const uptimeSec = Math.round(process.uptime());

  const snapshot: ObservabilitySnapshot = {
    timestamp: new Date(now()).toISOString(),
    service: {
      name: process.env.APP_NAME || 'auth-service',
      version: process.env.VERSION || process.env.npm_package_version || 'dev',
      environment: process.env.NODE_ENV || 'development',
      pid: process.pid,
      uptime_s: uptimeSec,
      started_at: new Date(now() - uptimeSec * 1000).toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rss_mb: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
        heap_used_mb: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
        heap_total_mb: Math.round((memory.heapTotal / 1024 / 1024) * 100) / 100,
        external_mb: Math.round((memory.external / 1024 / 1024) * 100) / 100
      }
    },
    requests,
    health: health as HealthReportLike,
    security: security as Record<string, unknown>,
    logging: {
      format: (process.env.LOG_FORMAT || 'console') === 'structured' ? 'structured' : 'console',
      level: process.env.LOG_LEVEL || 'info',
      request_id_header: 'X-Request-Id',
      payload: 'json'
    }
  };
  return snapshot;
};
