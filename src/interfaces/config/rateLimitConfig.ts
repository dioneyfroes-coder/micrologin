/**
 * @fileoverview Configurações centralizadas de Rate Limiting
 * Lê configurações do .env e fornece defaults sensatos
 */

import { getRedisConfig } from './redisConfig.js';

/**
 * Converte string para número com fallback
 * @param {string} value - Valor do .env
 * @param {number} defaultValue - Valor padrão
 * @returns {number}
 */
export const parseEnvNumber = (value: string | undefined, defaultValue: number): number => {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

interface RateLimitRule {
  points: number;
  duration: number;
  blockDuration: number;
}

interface RateLimitEnvironment {
  ip: RateLimitRule;
  user: RateLimitRule;
  login: RateLimitRule;
}

interface ActiveRateLimitConfig extends RateLimitEnvironment {
  environment: string;
  exemptPaths: string[];
  redis: {
    keyPrefix: string;
    enabled: boolean;
    host: string;
    port: number;
    password?: string;
    db: number;
    ttl: number;
    url: string | null;
  };
}

/**
 * Configurações de Rate Limiting baseadas no ambiente
 */
export const rateLimitConfig = {
  isDevelopment: process.env.NODE_ENV === 'development',

  development: {
    ip: {
      points: parseEnvNumber(process.env.RATE_LIMIT_IP_POINTS, 1000),
      duration: parseEnvNumber(process.env.RATE_LIMIT_IP_DURATION, 60),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_IP_BLOCK_DURATION, 5)
    },
    user: {
      points: parseEnvNumber(process.env.RATE_LIMIT_USER_POINTS, 500),
      duration: parseEnvNumber(process.env.RATE_LIMIT_USER_DURATION, 60),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_USER_BLOCK_DURATION, 5)
    },
    login: {
      points: parseEnvNumber(process.env.RATE_LIMIT_LOGIN_POINTS, 50),
      duration: parseEnvNumber(process.env.RATE_LIMIT_LOGIN_DURATION, 3600),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_LOGIN_BLOCK_DURATION, 10)
    }
  },

  production: {
    ip: {
      points: parseEnvNumber(process.env.RATE_LIMIT_PROD_IP_POINTS, 100),
      duration: parseEnvNumber(process.env.RATE_LIMIT_PROD_IP_DURATION, 60),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_PROD_IP_BLOCK_DURATION, 300)
    },
    user: {
      points: parseEnvNumber(process.env.RATE_LIMIT_PROD_USER_POINTS, 200),
      duration: parseEnvNumber(process.env.RATE_LIMIT_PROD_USER_DURATION, 60),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_PROD_USER_BLOCK_DURATION, 600)
    },
    login: {
      points: parseEnvNumber(process.env.RATE_LIMIT_PROD_LOGIN_POINTS, 5),
      duration: parseEnvNumber(process.env.RATE_LIMIT_PROD_LOGIN_DURATION, 900),
      blockDuration: parseEnvNumber(process.env.RATE_LIMIT_PROD_LOGIN_BLOCK_DURATION, 1800)
    }
  },

  // Endpoints de operação não passam por rate limit. Um probe que recebe 429
  // é um probe que mente: o orquestrador marcaria o container como unhealthy
  // (ou o deploy reverteria uma versão boa) por causa de limite de capacidade,
  // não de defeito. `/liveness` e `/readiness` entram aqui junto de `/health`
  // pelos mesmos motivos - são consultados por máquina, não por usuário.
  exemptPaths: [
    '/health',
    '/liveness',
    '/readiness',
    '/metrics',
    '/observability',
    '/api-docs',
    '/favicon.ico'
  ],

  redis: {
    keyPrefix: 'rl_',
    ...getRedisConfig()
  }
};

/**
 * Obtém configuração ativa baseada no ambiente
 * @returns Configuração de rate limiting
 */
export const getActiveConfig = (): ActiveRateLimitConfig => {
  const environmentConfig: RateLimitEnvironment = rateLimitConfig.isDevelopment
    ? rateLimitConfig.development
    : rateLimitConfig.production;

  return {
    ...environmentConfig,
    environment: rateLimitConfig.isDevelopment ? 'development' : 'production',
    exemptPaths: rateLimitConfig.exemptPaths,
    redis: rateLimitConfig.redis
  };
};

/**
 * Valida se todas as configurações necessárias estão definidas
 * @returns Resultado da validação
 */
export const validateRateLimitConfig = (): { isValid: boolean; errors: string[]; config: ActiveRateLimitConfig } => {
  const config = getActiveConfig();
  const errors: string[] = [];

  // Validar configurações obrigatórias
  (['ip', 'user', 'login'] as const).forEach(type => {
    if (!config[type] || typeof config[type] !== 'object') {
      errors.push(`Configuração de ${type} inválida`);
      return;
    }

    (['points', 'duration', 'blockDuration'] as const).forEach(field => {
      if (typeof config[type][field] !== 'number' || config[type][field] <= 0) {
        errors.push(`${type}.${field} deve ser um número positivo`);
      }
    });
  });

  return {
    isValid: errors.length === 0,
    errors,
    config
  };
};
