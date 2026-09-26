/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F2A
 */
import mongoose from 'mongoose';
import { getCachedJWT } from '../../infrastructure/cache/connection.js';

interface CheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded' | 'warning';
  state?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Verifica saúde do MongoDB
 */
const checkMongoDB = async(): Promise<CheckResult> => {
  try {
    const state = mongoose.connection.readyState;
    const states: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    if (state === 1) {
      // Teste simples de conectividade
      await mongoose.connection.db?.admin().ping();
      return { status: 'healthy', state: states[state] };
    }

    return {
      status: 'unhealthy',
      state: states[state],
      error: 'MongoDB não conectado'
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: (error as Error).message
    };
  }
};

/**
 * Verifica saúde do Redis
 */
const checkRedis = async(): Promise<CheckResult> => {
  try {
    // Tenta fazer uma operação simples
    await getCachedJWT('health-check-test');
    return {
      status: 'healthy',
      message: 'Redis disponível'
    };
  } catch (error) {
    return {
      status: 'degraded', // Redis não é crítico
      error: (error as Error).message,
      message: 'Cache indisponível - funcionalidade reduzida'
    };
  }
};

/**
 * Verifica uso de memória
 */
const checkMemory = (): CheckResult => {
  const usage = process.memoryUsage();
  const totalMB = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);

  // Alerta se passar de 200MB
  const status = totalMB > 200 ? 'warning' : 'healthy';

  return {
    status,
    memory: {
      total: `${totalMB}MB`,
      heap: `${heapMB}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`
    }
  };
};

/**
 * Verifica uptime
 */
const checkUptime = (): CheckResult => {
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  return {
    status: 'healthy',
    uptime: `${hours}h ${minutes}m`,
    pid: process.pid
  };
};

interface HealthCheckReport {
  status: string;
  timestamp: string;
  responseTime: string;
  version?: string;
  environment?: string;
  services?: Record<string, CheckResult>;
  error?: string;
}

interface LivenessReport {
  status: 'alive';
  timestamp: string;
  uptime: number;
  pid: number;
}

interface ReadinessReport {
  status: 'ready' | 'not_ready';
  ready: boolean;
  degraded: boolean;
  timestamp: string;
  responseTime: string;
  checks: Record<string, CheckResult>;
}

/**
 * Liveness: o processo responde?
 *
 * Não toca em dependência externa de propósito. Se o liveness dependesse do
 * Mongo, uma indisponibilidade do banco derrubaria processos perfeitamente
 * capazes de reconectar, e o orquestrador reiniciaria todo mundo sem necessidade.
 */
export const performLivenessCheck = (): LivenessReport => ({
  status: 'alive',
  timestamp: new Date().toISOString(),
  uptime: Math.round(process.uptime()),
  pid: process.pid
});

/**
 * Readiness: as dependências necessárias para atender tráfego estão de pé?
 *
 * Aqui o Mongo decide: sem banco o serviço não cumpre o contrato de nenhum
 * endpoint de negócio. O Redis, por outro lado, é fail-open por padrão em
 * dev/test, então cache indisponível é estado degradado, não "não pronto".
 */
export const performReadinessCheck = async(): Promise<ReadinessReport> => {
  const startTime = Date.now();
  const [mongodb, redis] = await Promise.all([checkMongoDB(), checkRedis()]);

  const ready = mongodb.status === 'healthy';
  const degraded = !ready || redis.status !== 'healthy';

  return {
    status: ready ? 'ready' : 'not_ready',
    ready,
    degraded,
    timestamp: new Date().toISOString(),
    responseTime: `${Date.now() - startTime}ms`,
    checks: { mongodb, redis }
  };
};

/**
 * Health check completo
 */
export const performHealthCheck = async(): Promise<HealthCheckReport> => {
  const startTime = Date.now();

  try {
    const [mongodb, redis, memory, uptime] = await Promise.all([
      checkMongoDB(),
      checkRedis(),
      Promise.resolve(checkMemory()),
      Promise.resolve(checkUptime())
    ]);

    // Determinar status geral
    const hasUnhealthy = [mongodb, redis].some(check => check.status === 'unhealthy');
    const hasWarning = [mongodb, redis, memory].some(check =>
      check.status === 'warning' || check.status === 'degraded'
    );

    let overallStatus = 'healthy';
    if (hasUnhealthy) {
      overallStatus = 'unhealthy';
    } else if (hasWarning) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTime: `${Date.now() - startTime}ms`,
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      services: {
        mongodb,
        redis,
        memory,
        uptime
      }
    };

  } catch (error) {
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: `${Date.now() - startTime}ms`,
      error: (error as Error).message
    };
  }
};
