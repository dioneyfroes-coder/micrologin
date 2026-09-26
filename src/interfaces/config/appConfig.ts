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
import { getRedisConfig } from './redisConfig.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Converte `TRUST_PROXY` em algo que o Express aceite como `trust proxy`.
 *
 * Aceita:
 *   - `false`/`0`/`off`/`no`  -> não confiar em nenhum proxy (padrão seguro)
 *   - número inteiro         -> número de saltos de proxy confiáveis
 *   - CIDR ou lista de CIDRs  -> faixa do proxy confiável
 *   - qualquer outro valor    -> ligado (`true`), com aviso no log
 */
const parseTrustProxy = (raw: string | undefined): boolean | number | string | string[] => {
  const value = (raw ?? 'false').trim().toLowerCase();

  if (['false', '0', 'off', 'no', 'none', 'never', ''].includes(value)) {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return parseEnvNumber(value, 0);
  }

  if (value === 'true' || ['on', 'yes', 'always', 'all'].includes(value)) {
    logger.warn('⚠️ TRUST_PROXY ligado sem restrição: qualquer cliente pode forjar X-Forwarded-For e escapar do rate limit por IP.');
    return true;
  }

  return raw!.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
};

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
    // SSL habilitado por padrão apenas em produção ("NODE_ENV=production");
    // em dev/test, habilitar explicitamente com SSL_ENABLED=true
    enabled: process.env.SSL_ENABLED !== 'false' &&
      (process.env.NODE_ENV === 'production' || process.env.SSL_ENABLED === 'true')
  },

  // Clustering
  cluster: {
    // Clustering desabilitado por padrão em dev/test (rodar o app direto);
    // habilitar com CLUSTER_ENABLED=true ou em produção.
    enabled: process.env.NODE_ENV === 'production'
      ? process.env.CLUSTER_ENABLED !== 'false'
      : process.env.CLUSTER_ENABLED === 'true',
    workers: parseEnvNumber(process.env.CLUSTER_WORKERS, os.cpus().length),
    maxWorkers: parseEnvNumber(process.env.CLUSTER_MAX_WORKERS, os.cpus().length * 2),
    respawnDelay: parseEnvNumber(process.env.CLUSTER_RESPAWN_DELAY, 1000)
  },

  // Timeouts
  timeout: {
    server: parseEnvNumber(process.env.SERVER_TIMEOUT, 30000),
    gracefulShutdown: parseEnvNumber(process.env.GRACEFUL_SHUTDOWN_TIMEOUT, 5000)
  },

  // Confiança em cabeçalhos de proxy
  proxy: {
    /**
     * `false` (padrão) é a postura segura: `X-Forwarded-For` é controlado por
     * quem fala com o Node, então, sem proxy declarado, aceitar o cabeçalho
     * deixaria qualquer cliente forjar `req.ip` e burlar o rate limit por IP.
     *
     * Atrás de proxy/load balancer, configure `TRUST_PROXY` com o número de
     * saltos (`1`) ou com a faixa de CIDR do proxy. Nunca use `true` (= confiar
     * em toda a cadeia) sem um proxy reverso que reescreva o cabeçalho.
     */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY)
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
    ...getRedisConfig()
  }
};

/**
 * Configurações de segurança
 */

// `isProduction` é derivado aqui (antes de `environmentConfig`) porque a
// política de revogação depende do ambiente já na leitura das configs.
const isProductionEnv = (process.env.NODE_ENV || 'development') === 'production';

// Política de revogação quando o Redis (blacklist) está indisponível:
//   false (padrão em produção) = fail-closed: nega operações que dependem de
//                               revogação, preservando segurança sobre disponibilidade.
//   true  (padrão em dev/test) = fail-open: mantém disponibilidade, aceitando
//                               que tokens revogados não sejam barrados.
const sessionFailOpenEnv = process.env.SESSION_FAIL_OPEN;

export const securityConfig = {
  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    expiresIn: process.env.JWT_EXPIRES || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
    issuer: process.env.JWT_ISSUER || 'auth-service',
    audience: process.env.JWT_AUDIENCE || 'api-users'
  },

  dashboardToken: process.env.SECURITY_DASHBOARD_TOKEN,

  session: {
    failOpen: sessionFailOpenEnv === undefined
      ? !isProductionEnv
      : sessionFailOpenEnv === 'true'
  },

  bcrypt: {
    saltRounds: parseEnvNumber(process.env.BCRYPT_SALT_ROUNDS, 12)
  },

  cors: {
    // ✅ REMOVIDO: CORS origins agora vem APENAS do .env
    // Nunca adicione URLs hardcoded aqui - configure em variáveis de ambiente
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map(origin => origin.trim()),
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
    format: process.env.LOG_FORMAT || 'console' // console, structured
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
export function validateConfiguration(): boolean {
  const errors: string[] = [];

  // Validações obrigatórias
  if (!securityConfig.jwt.secret) {
    errors.push('JWT_SECRET é obrigatório');
  }

  if (environmentConfig.isProduction && !securityConfig.dashboardToken) {
    errors.push('SECURITY_DASHBOARD_TOKEN é obrigatório em produção');
  }

  if (environmentConfig.isProduction && securityConfig.dashboardToken && securityConfig.dashboardToken.length < 32) {
    errors.push('SECURITY_DASHBOARD_TOKEN deve ter pelo menos 32 caracteres em produção');
  }

  if (!databaseConfig.mongodb.uri) {
    errors.push('URI_MONGODB é obrigatório');
  }

  // Validações de segurança
  if (securityConfig.jwt.secret && securityConfig.jwt.secret.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres');
  }

  if (environmentConfig.isProduction && !securityConfig.jwt.refreshSecret) {
    errors.push('JWT_REFRESH_SECRET é obrigatório em produção');
  }

  if (securityConfig.jwt.refreshSecret && securityConfig.jwt.refreshSecret.length < 32) {
    errors.push('JWT_REFRESH_SECRET deve ter pelo menos 32 caracteres');
  }

  if (environmentConfig.isProduction &&
      securityConfig.jwt.refreshSecret &&
      securityConfig.jwt.refreshSecret === securityConfig.jwt.secret) {
    errors.push('JWT_REFRESH_SECRET deve ser diferente de JWT_SECRET');
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
    logger.warn('⚠️ SSL não está habilitado em produção');
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
      refreshJwt: !!securityConfig.jwt.refreshSecret,
      dashboardTokenConfigured: Boolean(securityConfig.dashboardToken),
      bcrypt: securityConfig.bcrypt.saltRounds
    },
    session: {
      // false = fail-closed (recomendado em produção): sem Redis, operações
      // que dependem de revogação são negadas em vez de aceitas sem controle.
      failOpen: securityConfig.session.failOpen
    },
    features: environmentConfig.features
  };
}
