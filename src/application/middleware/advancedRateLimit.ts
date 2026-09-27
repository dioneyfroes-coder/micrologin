import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import type { NextFunction, Request, Response } from 'express';
import { validateRateLimitConfig } from '../../interfaces/config/rateLimitConfig.js';
import { securityAuditLogger } from './securityAudit.js';
import { HttpError } from '../../shared/utils/errorHandler.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeUsername } from '../../shared/utils/usernamePolicy.js';
import type { RedisClient } from '../../infrastructure/cache/connection.js';

class AdvancedRateLimiter {
  private redisClient: RedisClient | null = null;
  private limiters: Record<string, RateLimiterAbstract> = {};
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private lastInitAttempt: number | null = null;
  private config;

  constructor() {
    const validation = validateRateLimitConfig();
    if (!validation.isValid) {
      logger.error('❌ Erro na configuração de rate limiting', { errors: validation.errors });
      throw new Error('Configuração de rate limiting inválida: ' + validation.errors.join(', '));
    }

    this.config = validation.config;

    this.setupLimiters();
  }

  setupLimiters(): void {
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
  }

  setupRedisLimiters(): void {
    const redisLimiterOptions = {
      storeClient: this.redisClient,
      useRedisPackage: true,
      keyPrefix: this.config.redis.keyPrefix
    };

    this.limiters = {
      ip: new RateLimiterRedis({
        ...redisLimiterOptions,
        points: this.config.ip.points,
        duration: this.config.ip.duration,
        blockDuration: this.config.ip.blockDuration
      }),
      user: new RateLimiterRedis({
        ...redisLimiterOptions,
        points: this.config.user.points,
        duration: this.config.user.duration,
        blockDuration: this.config.user.blockDuration
      }),
      login: new RateLimiterRedis({
        ...redisLimiterOptions,
        points: this.config.login.points,
        duration: this.config.login.duration,
        blockDuration: this.config.login.blockDuration
      })
    };
  }

  async init(): Promise<void> {
    if (this.redisClient) {
      this.initialized = true;
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async() => {
      try {
        // Tentar conectar ao Redis se disponível
        const { initRedis } = await import('../../infrastructure/cache/connection.js');
        const redisClient = await initRedis();

        if (redisClient) {
          this.redisClient = redisClient;
          this.setupRedisLimiters();
        }
      } catch (error) {
        logger.warn('⚠️ Redis não disponível para rate limiting, usando memória', error);
      } finally {
        this.initialized = true;
        this.initPromise = null;
        this.lastInitAttempt = Date.now();
      }
    })();

    return this.initPromise;
  }

  ensureInit(): void {
    if (this.initialized || this.redisClient || this.initPromise) {
      return;
    }

    // Não tentar reconectar com muita frequência (a cada 30s no máximo)
    if (this.lastInitAttempt && Date.now() - this.lastInitAttempt < 30000) {
      return;
    }

    this.init().catch(() => {});
  }

  /**
   * Conta alvo do orçamento de tentativas de login.
   *
   * O limite por IP sozinho não segura um ataque distribuído: trocar de origem
   * a cada tentativa entrega um orçamento novo, e o mesmo par de credenciais é
   * testado indefinidamente. Por isso o login também consome o orçamento por
   * conta - e a chave é o username canônico, para que `Alice`, `alice` e
   * `  alice  ` compartilhem o mesmo contador.
   *
   * Sem username utilizável no corpo (payload ausente ou do tipo errado), a
   * chave é o próprio IP: a requisição já será rejeitada pela validação, e a
   * intenção aqui é não deixar a proteção virar caminho livre.
   */
  private loginAccountKey(req: Request, ip: string): string {
    const username = (req.body as { user?: unknown } | undefined)?.user;
    const canonical = typeof username === 'string' ? normalizeUsername(username) : '';
    return canonical ? `account:${canonical}` : `anon:${ip}`;
  }

  checkLimits = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Promove para Redis assim que disponível sem bloquear a requisição
    this.ensureInit();

    const ip = req.ip || 'unknown';
    const userId = req.user?.id;
    const isLogin = req.path.includes('/login');

    const isExempt = this.config.exemptPaths.some(path => req.path === path || req.path.startsWith(path));

    if (isExempt) {
      next();
      return;
    }

    try {
      await this.limiters.ip.consume(ip);

      if (userId) {
        await this.limiters.user.consume(userId);
      }
      if (isLogin) {
        // Duas dimensões independentes: a origem e a conta atacada. A primeira
        // segura varredura (muitas contas a partir de uma origem), a segunda
        // segura o ataque dirigido a uma conta - que é o que brute force de
        // verdade é, e que trocar de IP não contorna.
        await this.limiters.login.consume(`${ip}_login`);
        await this.limiters.login.consume(this.loginAccountKey(req, ip));
      }

      next();

    } catch (rejRes) {
      const rejection = rejRes as { remainingPoints?: number; msBeforeNext?: number; totalPoints?: number };
      const remainingPoints = rejection.remainingPoints || 0;
      const msBeforeNext = rejection.msBeforeNext || 1000;
      const secondsToWait = Math.round(msBeforeNext / 1000) || 1;

      // Registrar violação no sistema de auditoria
      securityAuditLogger.logRateLimitViolation(
        ip,
        req.path,
        req.get('User-Agent') || undefined,
        rejection.totalPoints || 'unknown'
      );

      res.set({
        'Retry-After': secondsToWait,
        'X-RateLimit-Limit': rejection.totalPoints || 'unknown',
        'X-RateLimit-Remaining': remainingPoints,
        'X-RateLimit-Reset': new Date(Date.now() + msBeforeNext).toISOString()
      });

      const message = this.config.environment === 'development'
        ? `Rate limit atingido (${this.config.environment.toUpperCase()}: ${secondsToWait}s). IP: ${ip}, Path: ${req.path}`
        : `Rate limit exceeded. Try again in ${secondsToWait} seconds.`;

      next(new HttpError(429, 'RATE_LIMIT_EXCEEDED', message, {
        retryAfter: secondsToWait,
        environment: this.config.environment,
        ip: ip,
        path: req.path,
        remaining: remainingPoints,
        resetTime: new Date(Date.now() + msBeforeNext).toISOString(),
        limits: {
          ip: this.config.ip,
          user: this.config.user,
          login: this.config.login
        }
      }));
    }
  };

  async reset(): Promise<void> {
    if (this.redisClient) {
      try {
        const keys = await this.redisClient.keys(`${this.config.redis.keyPrefix}*`);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      } catch (error) {
        logger.warn('⚠️ Erro ao limpar Redis', error);
      }

      this.setupRedisLimiters();
    } else {
      this.setupLimiters();
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      initialized: this.initialized,
      environment: this.config?.environment || 'unknown',
      hasRedis: !!this.redisClient,
      limiters: Object.keys(this.limiters),
      config: this.config
    };
  }

  updateConfig(newConfig: Record<string, unknown>): boolean {
    if (this.config.environment !== 'development') {
      logger.warn('⚠️ Atualização de configuração só é permitida em desenvolvimento');
      return false;
    }

    this.config = { ...this.config, ...newConfig };

    // Recriar limiters com nova configuração, preservando o backend atual
    if (this.redisClient) {
      this.setupRedisLimiters();
    } else {
      this.setupLimiters();
    }

    return true;
  }
}

export const advancedRateLimit = new AdvancedRateLimiter();
