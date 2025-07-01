import mongoose from 'mongoose';
import { getCachedJWT } from '../config/cache.js';

/**
 * Verifica saúde do MongoDB
 */
const checkMongoDB = async() => {
  try {
    const state = mongoose.connection.readyState;
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    if (state === 1) {
      // Teste simples de conectividade
      await mongoose.connection.db.admin().ping();
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
      error: error.message
    };
  }
};

/**
 * Verifica saúde do Redis
 */
const checkRedis = async() => {
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
      error: error.message,
      message: 'Cache indisponível - funcionalidade reduzida'
    };
  }
};

/**
 * Verifica uso de memória
 */
const checkMemory = () => {
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
const checkUptime = () => {
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  return {
    status: 'healthy',
    uptime: `${hours}h ${minutes}m`,
    pid: process.pid
  };
};

/**
 * Health check completo
 */
export const performHealthCheck = async() => {
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
      error: error.message
    };
  }
};
