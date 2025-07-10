/**
 * CONFIGURAÇÃO CENTRALIZADA DA APLICAÇÃO
 *
 * Centraliza todas as configurações de forma segura e organizada.
 * Separação entre configurações públicas e sensíveis.
 */

// Carregar variáveis de ambiente PRIMEIRO
import './env.js';

import os from 'os';
import { parseEnvNumber } from './rateLimitConfig.js';

/**
 * Configurações de servidor e aplicação
 */
export const serverConfig = {
  // Servidor
  port: process.env.PORT || 3443,
  host: process.env.HOST || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',

  // SSL/TLS
  ssl: {
    keyPath: process.env.SSL_KEY_PATH || 'server.key',
    certPath: process.env.SSL_CERT_PATH || 'server.crt',
    enabled: process.env.SSL_ENABLED !== 'false'
  },

  // Clustering
  cluster: {
    enabled: process.env.CLUSTER_ENABLED !== 'false',
    workers: parseEnvNumber(process.env.CLUSTER_WORKERS, os.cpus().length),
    maxWorkers: parseEnvNumber(process.env.CLUSTER_MAX_WORKERS, os.cpus().length * 2),
    respawnDelay: parseEnvNumber(process.env.CLUSTER_RESPAWN_DELAY, 1000)
  },

  // Timeouts
  timeout: {
    server: parseEnvNumber(process.env.SERVER_TIMEOUT, 30000),
    gracefulShutdown: parseEnvNumber(process.env.GRACEFUL_SHUTDOWN_TIMEOUT, 5000)
  }
};

/**
 * Configurações de banco de dados
 */
export const databaseConfig = {
  mongodb: {
    uri: process.env.URI_MONGODB,
    options: {
      maxPoolSize: parseEnvNumber(process.env.MONGODB_MAX_POOL_SIZE, 10),
      serverSelectionTimeoutMS: parseEnvNumber(process.env.MONGODB_TIMEOUT, 5000),
      socketTimeoutMS: parseEnvNumber(process.env.MONGODB_SOCKET_TIMEOUT, 45000)
    }
  },

  redis: {
    enabled: process.env.REDIS_ENABLED !== 'false',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseEnvNumber(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD,
    db: parseEnvNumber(process.env.REDIS_DB, 0),
    ttl: parseEnvNumber(process.env.REDIS_TTL, 3600)
  }
};

/**
 * Configurações de segurança
 */
export const securityConfig = {
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES || '6h',
    issuer: process.env.JWT_ISSUER || 'auth-service',
    audience: process.env.JWT_AUDIENCE || 'api-users'
  },

  bcrypt: {
    saltRounds: parseEnvNumber(process.env.BCRYPT_SALT_ROUNDS, 12)
  },

  cors: {
    origins: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:8081',
      'http://localhost:8081/login',
      'http://localhost:8081/profile',
      'http://localhost:8081/update',
      'http://localhost:8081/delete',
      'http://localhost:8081/register'
    ],
    credentials: true
  }
};

/**
 * Configurações de monitoramento e logging
 */
export const monitoringConfig = {
  metrics: {
    enabled: process.env.METRICS_ENABLED !== 'false',
    endpoint: process.env.METRICS_ENDPOINT || '/metrics'
  },

  healthCheck: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    endpoint: process.env.HEALTH_CHECK_ENDPOINT || '/health'
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'console', // console, structured
    file: process.env.LOG_FILE || null
  }
};

/**
 * Configurações de desenvolvimento/produção
 */
export const environmentConfig = {
  isDevelopment: serverConfig.nodeEnv === 'development',
  isProduction: serverConfig.nodeEnv === 'production',
  isTest: serverConfig.nodeEnv === 'test',

  // Features toggles
  features: {
    swagger: process.env.SWAGGER_ENABLED !== 'false',
    clustering: serverConfig.cluster.enabled,
    ssl: serverConfig.ssl.enabled,
    redis: databaseConfig.redis.enabled
  }
};

/**
 * Validação de configurações obrigatórias
 */
export function validateConfiguration() {
  const errors = [];

  // Validações obrigatórias
  if (!securityConfig.jwt.secret) {
    errors.push('JWT_SECRET é obrigatório');
  }

  if (!databaseConfig.mongodb.uri) {
    errors.push('URI_MONGODB é obrigatório');
  }

  // Validações de segurança
  if (securityConfig.jwt.secret && securityConfig.jwt.secret.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres');
  }

  // Validações de cluster
  if (serverConfig.cluster.workers < 1) {
    errors.push('CLUSTER_WORKERS deve ser pelo menos 1');
  }

  if (serverConfig.cluster.workers > serverConfig.cluster.maxWorkers) {
    errors.push('CLUSTER_WORKERS não pode ser maior que CLUSTER_MAX_WORKERS');
  }

  // Validações de SSL em produção
  if (environmentConfig.isProduction && !serverConfig.ssl.enabled) {
    console.warn('⚠️ SSL não está habilitado em produção');
  }

  if (errors.length > 0) {
    throw new Error(`Configuração inválida:\n${errors.map(err => `- ${err}`).join('\n')}`);
  }

  return true;
}

/**
 * Função para obter configuração completa
 */
export function getAppConfig() {
  return {
    server: serverConfig,
    database: databaseConfig,
    security: securityConfig,
    monitoring: monitoringConfig,
    environment: environmentConfig
  };
}

/**
 * Função para debug das configurações (sem dados sensíveis)
 */
export function getConfigSummary() {
  return {
    server: {
      port: serverConfig.port,
      host: serverConfig.host,
      nodeEnv: serverConfig.nodeEnv,
      ssl: serverConfig.ssl.enabled,
      cluster: {
        enabled: serverConfig.cluster.enabled,
        workers: serverConfig.cluster.workers
      }
    },
    database: {
      mongodb: !!databaseConfig.mongodb.uri,
      redis: databaseConfig.redis.enabled
    },
    security: {
      jwt: !!securityConfig.jwt.secret,
      bcrypt: securityConfig.bcrypt.saltRounds
    },
    features: environmentConfig.features
  };
}
