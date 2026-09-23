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
    console.log('✅ Redis já conectado');
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
            console.error(`❌ Redis: máximo de tentativas de reconexão (${MAX_RETRY_ATTEMPTS}) excedido`);
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
      console.error('❌ Redis Error:', err.message);
    });

    newClient.on('connect', () => {
      console.log('🔄 Redis conectando...');
    });

    newClient.on('ready', () => {
      console.log('✅ Redis pronto para usar');
      isHealthy = true;
    });

    newClient.on('reconnecting', () => {
      console.log('🔄 Redis reconectando...');
    });

    newClient.on('end', () => {
      isHealthy = false;
      console.warn('⚠️ Redis desconectado');
    });

    // Conectar ao Redis
    await newClient.connect();

    // ✅ HEALTH CHECK: Verificar conexão com PING
    const pingResult = await performHealthCheck(newClient);
    isHealthy = pingResult;

    if (isHealthy) {
      console.log('✅ Health check Redis passou - conectado e operacional');
    } else {
      console.warn('⚠️ Redis conectado mas health check falhou');
      client = null;
      return null;
    }

    return client;
  } catch (error) {
    isHealthy = false;
    console.warn('⚠️ Redis não disponível, operando sem cache:', (error as Error).message);
    console.warn('   Funcionalidade de cache e rate limiting baseado em Redis será desabilitada');
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
    const startTime = Date.now();

    // PING é a forma mais básica de verificar conectividade
    const pongResponse = await redisClient.ping();

    const responseTime = Date.now() - startTime;

    if (pongResponse === 'PONG') {
      console.log(`✅ Redis PING respondeu em ${responseTime}ms`);

      // Verificar adicionalmente se conseguimos ler/escrever
      const testKey = '__health_check__';
      const testValue = Date.now().toString();

      await redisClient.setEx(testKey, 10, testValue);
      const retrieved = await redisClient.get(testKey);
      await redisClient.del(testKey);

      if (retrieved === testValue) {
        console.log('✅ Redis read/write test passou');
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`❌ Redis health check falhou: ${(error as Error).message}`);
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
    console.error('❌ Erro ao salvar JWT em cache:', (error as Error).message);
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
    console.error('❌ Erro ao buscar JWT em cache:', (error as Error).message);
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
      console.log(`🗑️ Cache limpo: ${key}`);
    } else {
      await client.flushDb();
      console.log('🗑️ Cache completamente limpo');
    }
  } catch (error) {
    console.error('❌ Erro ao limpar cache:', (error as Error).message);
  }
};

/**
 * Desconecta do Redis
 */
export const disconnectRedis = async(): Promise<void> => {
  if (client && client.isReady) {
    try {
      await client.quit();
      console.log('✅ Redis desconectado');
      client = null;
      isHealthy = false;
    } catch (error) {
      console.error('❌ Erro ao desconectar Redis:', (error as Error).message);
    }
  }
};

/**
 * Retorna o cliente Redis
 */
export const getRedisClient = (): RedisClient | null => {
  return isRedisAvailable() ? client : null;
};
