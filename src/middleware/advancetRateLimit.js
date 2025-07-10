import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { validateRateLimitConfig, logRateLimitConfig } from '../config/rateLimitConfig.js';
import { securityAuditLogger } from './securityAudit.js';

class AdvancedRateLimiter {
  constructor() {
    this.redisClient = null;
    this.limiters = {};
    this.initialized = false;
    this.config = null;

    const validation = validateRateLimitConfig();
    if (!validation.isValid) {
      console.error('❌ Erro na configuração de rate limiting:', validation.errors);
      throw new Error('Configuração de rate limiting inválida: ' + validation.errors.join(', '));
    }

    this.config = validation.config;

    if (process.env.NODE_ENV === 'development') {
      console.log(`🔧 Rate Limiter inicializando... Environment: ${this.config.environment}`);
    }

    logRateLimitConfig();
    this.setupLimiters();
  }

  setupLimiters() {
    this.limiters = {
      ip: new RateLimiterMemory({
        keyPrefix: `${this.config.redis.keyPrefix}ip`,
        points: this.config.ip.points,
        duration: this.config.ip.duration,
        blockDuration: this.config.ip.blockDuration
      }),
      user: new RateLimiterMemory({
        keyPrefix: `${this.config.redis.keyPrefix}user`,
        points: this.config.user.points,
        duration: this.config.user.duration,
        blockDuration: this.config.user.blockDuration
      }),
      login: new RateLimiterMemory({
        keyPrefix: `${this.config.redis.keyPrefix}login`,
        points: this.config.login.points,
        duration: this.config.login.duration,
        blockDuration: this.config.login.blockDuration
      })
    };

    this.initialized = true;

    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ Rate limiters configurados para: ${this.config.environment.toUpperCase()}`);
    }
  }

  async init() {
    if (this.initialized) {
      return;
    }

    try {
      // Tentar conectar ao Redis se disponível
      const { initRedis } = await import('../config/cache.js');
      this.redisClient = await initRedis();

      if (this.redisClient) {
        if (process.env.NODE_ENV === 'development') {
          console.log('🔧 Atualizando rate limiters para usar Redis...');
        }
        this.setupRedisLimiters();
      }
    } catch (error) {
      console.warn('⚠️ Redis não disponível para rate limiting, usando memória:', error.message);
    }

    this.initialized = true;
  }

  setupRedisLimiters() {
    this.limiters = {
      ip: new RateLimiterRedis({
        storeClient: this.redisClient,
        keyPrefix: `${this.config.redis.keyPrefix}ip`,
        points: this.config.ip.points,
        duration: this.config.ip.duration,
        blockDuration: this.config.ip.blockDuration
      }),
      user: new RateLimiterRedis({
        storeClient: this.redisClient,
        keyPrefix: `${this.config.redis.keyPrefix}user`,
        points: this.config.user.points,
        duration: this.config.user.duration,
        blockDuration: this.config.user.blockDuration
      }),
      login: new RateLimiterRedis({
        storeClient: this.redisClient,
        keyPrefix: `${this.config.redis.keyPrefix}login`,
        points: this.config.login.points,
        duration: this.config.login.duration,
        blockDuration: this.config.login.blockDuration
      })
    };

    if (process.env.NODE_ENV === 'development') {
      console.log('✅ Rate limiters atualizados para Redis');
    }
  }

  checkLimits = async(req, res, next) => {
    if (!this.initialized) {
      console.warn('⚠️ Rate limiter não inicializado, permitindo requisição');
      return next();
    }

    const ip = req.ip || 'unknown';
    const userId = req.user?.id;
    const isLogin = req.path.includes('/login');

    const isExempt = this.config.exemptPaths.some(path => req.path === path || req.path.startsWith(path));

    if (isExempt) {
      return next();
    }

    try {
      await this.limiters.ip.consume(ip);

      if (userId) {
        await this.limiters.user.consume(userId);
      }
      if (isLogin) {
        await this.limiters.login.consume(`${ip}_login`);
      }

      next();

    } catch (rejRes) {
      const remainingPoints = rejRes.remainingPoints || 0;
      const msBeforeNext = rejRes.msBeforeNext || 1000;
      const secondsToWait = Math.round(msBeforeNext / 1000) || 1;

      console.warn(`⚠️ Rate limit atingido: ${ip} em ${req.path} - aguardar ${secondsToWait}s`);

      // Registrar violação no sistema de auditoria
      securityAuditLogger.logRateLimitViolation(
        ip,
        req.path,
        req.get('User-Agent'),
        rejRes.totalPoints || 'unknown'
      );

      res.set({
        'Retry-After': secondsToWait,
        'X-RateLimit-Limit': rejRes.totalPoints || 'unknown',
        'X-RateLimit-Remaining': remainingPoints,
        'X-RateLimit-Reset': new Date(Date.now() + msBeforeNext).toISOString()
      });

      const message = this.config.environment === 'development'
        ? `Rate limit atingido (${this.config.environment.toUpperCase()}: ${secondsToWait}s). IP: ${ip}, Path: ${req.path}`
        : `Rate limit exceeded. Try again in ${secondsToWait} seconds.`;

      res.status(429).json({
        error: 'Too Many Requests',
        message,
        retryAfter: secondsToWait,
        environment: this.config.environment,
        details: {
          ip: ip,
          path: req.path,
          remaining: remainingPoints,
          resetTime: new Date(Date.now() + msBeforeNext).toISOString(),
          limits: {
            ip: this.config.ip,
            user: this.config.user,
            login: this.config.login
          }
        }
      });
    }
  };

  async reset() {
    if (this.redisClient) {
      try {
        const keys = await this.redisClient.keys(`${this.config.redis.keyPrefix}*`);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
          if (process.env.NODE_ENV === 'development') {
            console.log(`✅ ${keys.length} chaves de rate limit removidas do Redis`);
          }
        }
      } catch (error) {
        console.warn('⚠️ Erro ao limpar Redis:', error.message);
      }
    }

    this.setupLimiters();

    if (process.env.NODE_ENV === 'development') {
      console.log('✅ Rate limiters resetados');
    }
  }

  getStatus() {
    return {
      initialized: this.initialized,
      environment: this.config?.environment || 'unknown',
      hasRedis: !!this.redisClient,
      limiters: Object.keys(this.limiters),
      config: this.config
    };
  }

  updateConfig(newConfig) {
    if (this.config.environment !== 'development') {
      console.warn('⚠️ Atualização de configuração só é permitida em desenvolvimento');
      return false;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('🔧 Atualizando configuração de rate limiting...');
    }

    this.config = { ...this.config, ...newConfig };

    // Recriar limiters com nova configuração
    this.setupLimiters();

    if (process.env.NODE_ENV === 'development') {
      console.log('✅ Configuração de rate limiting atualizada');
    }

    logRateLimitConfig();

    return true;
  }
}

export const advancedRateLimit = new AdvancedRateLimiter();
