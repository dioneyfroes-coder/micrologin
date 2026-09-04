/**
 * @fileoverview Configuração de Cache com Redis
 *
 * Implementa conexão segura ao Redis com:
 * - Health check automático
 * - Fallback para memória se Redis não estiver disponível
 * - Reconexão automática
 * - Proteção de erros
 */

import redis from 'redis';

let client = null;
let isHealthy = false;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Inicializa conexão com Redis
 * @returns {Promise<Object|null>} Cliente Redis ou null se falhar
 */
export const initRedis = async() => {
  if (client && client.isReady) {
    console.log('✅ Redis já conectado');
    return client;
  }

  try {
    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      // Segurança: Password se configurada
      ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
      // Reconnect strategy
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > MAX_RETRY_ATTEMPTS) {
            console.error(`❌ Redis: máximo de tentativas de reconexão (${MAX_RETRY_ATTEMPTS}) excedido`);
            return new Error('Redis reconnection failed');
          }
          const delay = Math.min(retries * 50, 500);
          return delay;
        },
        connectTimeout: 10000,
        keepAlive: 30000
      }
    };

    client = redis.createClient(redisConfig);

    // Event handlers
    client.on('error', (err) => {
      isHealthy = false;
      console.error('❌ Redis Error:', err.message);
    });

    client.on('connect', () => {
      console.log('🔄 Redis conectando...');
    });

    client.on('ready', () => {
      console.log('✅ Redis pronto para usar');
      isHealthy = true;
    });

    client.on('reconnecting', () => {
      console.log('🔄 Redis reconectando...');
    });

    client.on('end', () => {
      isHealthy = false;
      console.warn('⚠️ Redis desconectado');
    });

    // Conectar ao Redis
    await client.connect();

    // ✅ HEALTH CHECK: Verificar conexão com PING
    const pingResult = await performHealthCheck(client);
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
    console.warn('⚠️ Redis não disponível, operando sem cache:', error.message);
    console.warn('   Funcionalidade de cache e rate limiting baseado em Redis será desabilitada');
    client = null;
    return null;
  }
};

/**
 * Realiza health check no Redis
 * @param {Object} redisClient - Cliente Redis
 * @returns {Promise<boolean>} True se healthy
 */
export const performHealthCheck = async(redisClient) => {
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
    console.error(`❌ Redis health check falhou: ${error.message}`);
    return false;
  }
};

/**
 * Obtém status do Redis
 * @returns {Object} Status atual
 */
export const getRedisStatus = () => {
  return {
    isConnected: client && client.isReady,
    isHealthy: isHealthy,
    status: client
      ? (client.isReady ? 'connected' : 'disconnecting')
      : 'disconnected',
    message: isHealthy ? '✅ Redis operacional' : '⚠️ Redis indisponível - usando fallback'
  };
};

/**
 * Valida se Redis está disponível e saudável
 * @returns {boolean}
 */
export const isRedisAvailable = () => {
  return isHealthy && client && client.isReady;
};

/**
 * Cache JWT Token com TTL automático
 * @param {string} token - Token JWT
 * @param {Object} userData - Dados do usuário
 * @param {number} ttl - Time to live em segundos (padrão: 3600)
 */
export const cacheJWT = async(token, userData, ttl = 3600) => {
  if (!isRedisAvailable()) {
    return; // Fallback silencioso se Redis não estiver disponível
  }

  try {
    await client.setEx(
      `jwt:${token}`,
      ttl,
      JSON.stringify(userData)
    );
  } catch (error) {
    console.error('❌ Erro ao salvar JWT em cache:', error.message);
    // Continuar mesmo se falhar
  }
};

/**
 * Recupera JWT cacheado
 * @param {string} token - Token JWT
 * @returns {Promise<Object|null>}
 */
export const getCachedJWT = async(token) => {
  if (!isRedisAvailable()) {
    return null;
  }

  try {
    const cached = await client.get(`jwt:${token}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('❌ Erro ao buscar JWT em cache:', error.message);
    return null;
  }
};

/**
 * Limpa cache (chave específica ou tudo)
 * @param {string|null} key - Chave a remover (null = limpar tudo)
 */
export const clearCache = async(key = null) => {
  if (!isRedisAvailable()) {
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
    console.error('❌ Erro ao limpar cache:', error.message);
  }
};

/**
 * Desconecta do Redis
 */
export const disconnectRedis = async() => {
  if (client && client.isReady) {
    try {
      await client.quit();
      console.log('✅ Redis desconectado');
      client = null;
      isHealthy = false;
    } catch (error) {
      console.error('❌ Erro ao desconectar Redis:', error.message);
    }
  }
};

/**
 * Retorna o cliente Redis
 * @returns {Object|null}
 */
export const getRedisClient = () => {
  return isRedisAvailable() ? client : null;
};
