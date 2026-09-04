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
export const parseEnvNumber = (value, defaultValue) => {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

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

  exemptPaths: [
    '/health',
    '/metrics',
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
 * @returns {Object} Configuração de rate limiting
 */
export const getActiveConfig = () => {
  const environmentConfig = rateLimitConfig.isDevelopment
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
 * @returns {Object} Resultado da validação
 */
export const validateRateLimitConfig = () => {
  const config = getActiveConfig();
  const errors = [];

  // Validar configurações obrigatórias
  ['ip', 'user', 'login'].forEach(type => {
    if (!config[type] || typeof config[type] !== 'object') {
      errors.push(`Configuração de ${type} inválida`);
      return;
    }

    ['points', 'duration', 'blockDuration'].forEach(field => {
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

/**
 * Log das configurações ativas
 */
export const logRateLimitConfig = () => {
  const activeConfig = getActiveConfig();
  const environment = activeConfig.environment;

  console.log(`🔧 Rate Limit Config (${environment.toUpperCase()}):`);
  console.log(`   📊 IP: ${activeConfig.ip.points} req/${activeConfig.ip.duration}s (block: ${activeConfig.ip.blockDuration}s)`);
  console.log(`   👤 User: ${activeConfig.user.points} req/${activeConfig.user.duration}s (block: ${activeConfig.user.blockDuration}s)`);
  console.log(`   🔐 Login: ${activeConfig.login.points} req/${activeConfig.login.duration}s (block: ${activeConfig.login.blockDuration}s)`);
  console.log(`   🚫 Exempt paths: ${activeConfig.exemptPaths.join(', ')}`);
};
