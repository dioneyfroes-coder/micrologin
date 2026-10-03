/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F2A
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { getRedisClient, performHealthCheck as performRedisHealthCheck } from '../../infrastructure/cache/connection.js';
import { displayVersion } from './version.js';

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
 *
 * A pergunta é "o Redis está servindo?", então a resposta tem de vir de uma
 * operação real. Usar `getCachedJWT` para isso não servia: ele engole a falha e
 * devolve `null` quando não há Redis, então o relatório dizia "Redis
 * disponível" com o Redis no chão — o pior resultado para um health check, que
 * é mentir para quem decide se o serviço está no ar.
 */
const checkRedis = async(): Promise<CheckResult> => {
  const client = getRedisClient();

  if (!client) {
    return {
      status: 'degraded',
      message: 'Redis indisponível - revogação de token degradada'
    };
  }

  try {
    const healthy = await performRedisHealthCheck(client);
    return healthy
      ? { status: 'healthy', message: 'Redis disponível' }
      : {
        status: 'degraded',
        message: 'Redis conectado, mas não responde a leitura/escrita'
      };
  } catch (error) {
    return {
      status: 'degraded',
      error: (error as Error).message,
      message: 'Redis indisponível - revogação de token degradada'
    };
  }
};

/**
 * Fração do `mem_limit` do container acima da qual a memória vira `warning`.
 *
 * O alerta é proporção, não MB fixo: um número absoluto erra nas duas
 * direções. Com o container em 1 GiB (`docker-compose.prod.yml`), 65% dá
 * ~680 MB — bem acima do pico medido de 8 logins com argon2id m=19MiB
 * (~200 MB), então o alerta só aparece quando algo está realmente fora do
 * previsto. Num container menor o alerta baixa junto, o que é o que se quer.
 *
 * O limite do Docker continua sendo quem mata o processo; este é só o sinal
 * que chega antes, pelo /health.
 */
const MEMORY_WARNING_RATIO = 0.65;

/**
 * Limite de memória do container, em bytes, lido do cgroup.
 *
 * O Docker aplica `mem_limit` em cgroup v2 (`memory.max`) ou v1
 * (`memory.limit_in_bytes`). Lemos o cgroup porque é onde o valor que vale
 * está: o `mem_limit` do compose é uma intenção, e o que o processo precisa
 * saber é o teto que ele próprio tem. Fora de container (dev, PM2 direto) o
 * cgroup não existe e devolve 0, que o chamador trata como "sem limite".
 */
const cgroupMemoryLimit = (): number => {
  const readNumber = (path: string): number => {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      // cgroup v2 reporta "max" quando não há limite.
      if (raw === 'max' || raw === '') {
        return 0;
      }
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  return readNumber('/sys/fs/cgroup/memory.max') || readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
};

/**
 * Verifica uso de memória
 */
const checkMemory = (): CheckResult => {
  const usage = process.memoryUsage();
  const totalMB = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);

  const limitMB = Math.round(cgroupMemoryLimit() / 1024 / 1024);
  const warningMB = Math.round(limitMB * MEMORY_WARNING_RATIO);
  const status = limitMB > 0 && totalMB > warningMB ? 'warning' : 'healthy';

  return {
    status,
    memory: {
      total: `${totalMB}MB`,
      heap: `${heapMB}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`,
      limit: limitMB > 0 ? `${limitMB}MB` : 'sem limite',
      warningAbove: limitMB > 0 ? `${warningMB}MB` : null,
      ratio: limitMB > 0 ? Number((totalMB / limitMB).toFixed(2)) : null
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
 * endpoint de negócio.
 *
 * O Redis não tira o serviço de prontidão, e a justificativa é operacional: em
 * produção a política de revogação é fail-closed, então Redis fora significa
 * "não autentica" — mas o remédio é restaurar o Redis, não reiniciar o
 * processo. Um app reiniciado voltaria a cair no mesmo estado em segundos, e
 * tirar o container da roção só trocaria indisponibilidade por indisponibilidade,
 * gastando o orçamento de reinício do orquestrador.
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
      // Do `package.json`, e não de `npm_package_version`: essa variável só
      // existe dentro de scripts `npm run`, e o container executa
      // `node dist/app.js` direto — em produção o health respondia o fallback
      // hard-coded, que é justamente o número que ninguém atualiza.
      version: displayVersion(),
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
