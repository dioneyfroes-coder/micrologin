/**
 * @fileoverview Configuração de Cache com Redis
 *
 * Implementa conexão segura ao Redis com:
 * - Health check automático
 * - Fallback para memória se Redis não estiver disponível
 * - Reconexão automática
 * - Proteção de erros
 */

import redis, { RedisClientType, RedisDefaultModules, RedisClientOptions } from 'redis';
import { getRedisClientOptions, RedisConnectionOptions } from '../../interfaces/config/redisConfig.js';
import { logger } from '../../shared/utils/logger.js';

export type RedisClient = RedisClientType<RedisDefaultModules>;

let client: RedisClient | null = null;
let isHealthy = false;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Inicializa conexão com Redis
 * @returns Cliente Redis ou null se falhar
 */
export const initRedis = async(): Promise<RedisClient | null> => {
  if (client && client.isReady) {
    return client;
  }

  try {
    const baseOptions: RedisConnectionOptions = getRedisClientOptions();

    const redisConfig: RedisClientOptions = {
      ...baseOptions,
      socket: {
        ...(baseOptions.socket || {}),
        reconnectStrategy: (retries: number) => {
          if (retries > MAX_RETRY_ATTEMPTS) {
            logger.error(`❌ Redis: máximo de tentativas de reconexão (${MAX_RETRY_ATTEMPTS}) excedido`);
            return new Error('Redis reconnection failed');
          }
          const delay = Math.min(retries * 50, 500);
          return delay;
        },
        connectTimeout: 10000
      }
    };

    const newClient: RedisClient = redis.createClient(redisConfig) as RedisClient;
    client = newClient;

    // Event handlers
    newClient.on('error', (err: Error) => {
      isHealthy = false;
      logger.error('❌ Redis Error', err);
    });

    newClient.on('end', () => {
      isHealthy = false;
      logger.warn('⚠️ Redis desconectado');
    });

    // Conectar ao Redis
    await newClient.connect();

    // ✅ HEALTH CHECK: Verificar conexão com PING
    const pingResult = await performHealthCheck(newClient);
    isHealthy = pingResult;

    if (!isHealthy) {
      logger.warn('⚠️ Redis conectado mas health check falhou');
      client = null;
      return null;
    }

    return client;
  } catch (error) {
    isHealthy = false;
    logger.warn('⚠️ Redis não disponível, operando sem cache', error);
    logger.warn('   Funcionalidade de cache e rate limiting baseado em Redis será desabilitada');
    client = null;
    return null;
  }
};

/**
 * Realiza health check no Redis
 * @param redisClient - Cliente Redis
 * @returns True se healthy
 */
export const performHealthCheck = async(redisClient: RedisClient): Promise<boolean> => {
  try {
    // PING é a forma mais básica de verificar conectividade
    const pongResponse = await redisClient.ping();

    if (pongResponse === 'PONG') {
      // Verificar adicionalmente se conseguimos ler/escrever
      const testKey = '__health_check__';
      const testValue = Date.now().toString();

      await redisClient.setEx(testKey, 10, testValue);
      const retrieved = await redisClient.get(testKey);
      await redisClient.del(testKey);

      if (retrieved === testValue) {
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('❌ Redis health check falhou', error);
    return false;
  }
};

interface RedisStatus {
  isConnected: boolean;
  isHealthy: boolean;
  status: string;
  message: string;
}

/**
 * Obtém status do Redis
 */
export const getRedisStatus = (): RedisStatus => {
  return {
    isConnected: !!(client && client.isReady),
    isHealthy: isHealthy,
    status: client
      ? (client.isReady ? 'connected' : 'disconnecting')
      : 'disconnected',
    message: isHealthy ? '✅ Redis operacional' : '⚠️ Redis indisponível - usando fallback'
  };
};

/**
 * Valida se Redis está disponível e saudável
 */
export const isRedisAvailable = (): boolean => {
  return isHealthy && !!(client && client.isReady);
};

/**
 * Cache JWT Token com TTL automático
 * @param token - Token JWT
 * @param userData - Dados do usuário
 * @param ttl - Time to live em segundos (padrão: 3600)
 */
export const cacheJWT = async(token: string, userData: unknown, ttl = 3600): Promise<void> => {
  if (!isRedisAvailable() || !client) {
    return; // Fallback silencioso se Redis não estiver disponível
  }

  try {
    await client.setEx(
      `jwt:${token}`,
      ttl,
      JSON.stringify(userData)
    );
  } catch (error) {
    logger.error('❌ Erro ao salvar JWT em cache', error);
    // Continuar mesmo se falhar
  }
};

/**
 * Recupera JWT cacheado
 * @param token - Token JWT
 */
export const getCachedJWT = async(token: string): Promise<unknown | null> => {
  if (!isRedisAvailable() || !client) {
    return null;
  }

  try {
    const cached = await client.get(`jwt:${token}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.error('❌ Erro ao buscar JWT em cache', error);
    return null;
  }
};

/**
 * Limpa cache (chave específica ou tudo)
 * @param key - Chave a remover (null = limpar tudo)
 */
export const clearCache = async(key: string | null = null): Promise<void> => {
  if (!isRedisAvailable() || !client) {
    return;
  }

  try {
    if (key) {
      await client.del(key);
    } else {
      await client.flushDb();
    }
  } catch (error) {
    logger.error('❌ Erro ao limpar cache', error);
  }
};

/**
 * Desconecta do Redis
 */
export const disconnectRedis = async(): Promise<void> => {
  if (client && client.isReady) {
    try {
      await client.quit();
      client = null;
      isHealthy = false;
    } catch (error) {
      logger.error('❌ Erro ao desconectar Redis', error);
    }
  }
};

/**
 * Retorna o cliente Redis
 */
export const getRedisClient = (): RedisClient | null => {
  return isRedisAvailable() ? client : null;
};
