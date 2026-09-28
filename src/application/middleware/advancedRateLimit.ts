import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import type { NextFunction, Request, Response } from 'express';
import { validateRateLimitConfig } from '../../interfaces/config/rateLimitConfig.js';
import { securityAuditLogger } from './securityAudit.js';
import { HttpError } from '../../shared/utils/errorHandler.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeUsername } from '../../shared/utils/usernamePolicy.js';
import type { RedisClient } from '../../infrastructure/cache/connection.js';

/** Intervalo mínimo entre tentativas de conectar ao Redis quando não há cliente. */
const REDIS_RETRY_INTERVAL_MS = 30000;

/**
 * A rejeição veio do limite ou da infraestrutura?
 *
 * `rate-limiter-flexible` recusa com um objeto que traz `msBeforeNext` e
 * `remainingPoints`. Qualquer outra coisa — um `Error` do driver de Redis — é
 * indisponibilidade do armazenamento. Confundir os dois faz uma queda de
 * dependência aparecer para o cliente (e para a auditoria) como abuso de taxa.
 */
const isRateLimitRejection = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { msBeforeNext?: unknown }).msBeforeNext === 'number';
};

class AdvancedRateLimiter {
  private redisClient: RedisClient | null = null;
  private limiters: Record<string, RateLimiterAbstract> = {};
  private usingRedis = false;
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
    this.usingRedis = false;
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

    this.usingRedis = true;
  }

  /**
   * O armazenamento compartilhado está utilizável agora?
   *
   * `isReady !== false` em vez de `isReady === true` porque clientes de teste
   * (e o contrato de `TokenService`) tratam a ausência do campo como "pronto".
   */
  private isRedisUsable(): boolean {
    return !!this.redisClient && this.redisClient.isReady !== false;
  }

  /**
   * Conecta ao Redis, se ainda não conectado.
   *
   * Só é chamada quando não há cliente nenhum. Havendo cliente, quem recupera a
   * conexão é o próprio node-redis (`reconnectStrategy`), que a restabelece sem
   * trocar o objeto.
   */
  async init(): Promise<void> {
    if (this.redisClient) {
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
          // Só-promove se o cliente já responde. Promover para um socket em
          // reconexão trocaria os limiters de memória por um backend que falha
          // na primeira requisição, e o `syncBackend` desfaria isso logo em
          // seguida: duas reconfigurações por queda, sem ganho nenhum.
          if (this.isRedisUsable()) {
            this.setupRedisLimiters();
          }
        }
      } catch (error) {
        logger.warn('⚠️ Redis não disponível para rate limiting, usando memória', error);
      } finally {
        this.initPromise = null;
        this.lastInitAttempt = Date.now();
      }
    })();

    return this.initPromise;
  }

  /**
   * Mantém o backend dos limiters em sintonia com a disponibilidade do Redis.
   *
   * As duas direções importam, e as duas já falhavam:
   *
   * - **desce para memória** quando a conexão cai, porque o `RateLimiterRedis`
   *   rejeita a operação e o middleware tratava a rejeição como "limite
   *   estourado". Uma indisponibilidade do Redis virava 429 para todo mundo e
   *   ainda registrav violação de rate limit na auditoria — o serviço afirmava
   *   estar sob ataque quando o que tinha caído era a dependência;
   * - **sobe para o Redis** quando ela volta, para que o limite volte a ser
   *   global. Sem isto, uma única queda de meio segundo deixava o limite em
   *   memória pelo resto do processo: com vários workers, cada um com seu
   *   orçamento, que é exatamente o bypass que o limite por conta existe para
   *   impedir.
   */
  syncBackend(): void {
    if (this.isRedisUsable()) {
      if (!this.usingRedis) {
        this.setupRedisLimiters();
        logger.info('✅ Rate limiting migrado para o Redis (limite compartilhado entre processos)');
      }
      return;
    }

    if (this.usingRedis) {
      this.setupLimiters();
      logger.warn('⚠️ Redis indisponível: rate limiting por memória (limite passa a valer só neste processo)');
    }

    // Sem cliente (Redis fora desde o startup, ou a reconexão em curso):
    // refaz a tentativa no máximo a cada 30s, senão cada requisição paga uma
    // conexão recusada.
    if (!this.redisClient && !this.initPromise) {
      if (this.lastInitAttempt && Date.now() - this.lastInitAttempt < REDIS_RETRY_INTERVAL_MS) {
        return;
      }
      void this.init();
    }
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

  /**
   * Pontos a consumir nesta requisição, na ordem.
   *
   * Extrair para um método é o que permite repetir o consumo em memória depois
   * de uma falha de infraestrutura: o mesmo conjunto de chaves, o mesmo cálculo
   * de chave de conta, sem risco de as duas pontas divergirem.
   */
  private consumptionPlan(req: Request, ip: string, userId?: string): Array<{ limiter: 'ip' | 'user' | 'login', key: string }> {
    const plan: Array<{ limiter: 'ip' | 'user' | 'login', key: string }> = [
      { limiter: 'ip', key: ip }
    ];

    if (userId) {
      plan.push({ limiter: 'user', key: userId });
    }

    if (req.path.includes('/login')) {
      // Duas dimensões independentes: a origem e a conta atacada. A primeira
      // segura varredura (muitas contas a partir de uma origem), a segunda
      // segura o ataque dirigido a uma conta - que é o que brute force de
      // verdade é, e que trocar de IP não contorna.
      plan.push({ limiter: 'login', key: `${ip}_login` });
      plan.push({ limiter: 'login', key: this.loginAccountKey(req, ip) });
    }

    return plan;
  }

  private async consume(plan: ReturnType<AdvancedRateLimiter['consumptionPlan']>): Promise<void> {
    for (const { limiter, key } of plan) {
      await this.limiters[limiter].consume(key);
    }
  }

  checkLimits = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip || 'unknown';
    const userId = req.user?.id;

    const isExempt = this.config.exemptPaths.some(path => req.path === path || req.path.startsWith(path));

    if (isExempt) {
      next();
      return;
    }

    // Fora do caminho isento: promoções e quedas de backend fazem sentido aqui.
    this.syncBackend();

    const plan = this.consumptionPlan(req, ip, userId);

    let rejection: unknown;
    try {
      await this.consume(plan);
      next();
      return;
    } catch (caught) {
      rejection = caught;
    }

    if (!isRateLimitRejection(rejection)) {
      // Falha de infraestrutura, não limite estourado. Um `Error` do driver
      // (conexão recusada, cliente fechado) não tem nada de `msBeforeNext`, e
      // tratá-lo como recusa transformava a queda do Redis em 429 para todo
      // mundo, com `Retry-After` e violação registrada na auditoria.
      logger.warn('⚠️ Falha no armazenamento de rate limit, refazendo em memória', rejection as Error);
      this.setupLimiters();
      try {
        await this.consume(plan);
        next();
        return;
      } catch (memoryRejection) {
        rejection = memoryRejection;
      }
    }

    const details = rejection as { remainingPoints?: number; msBeforeNext?: number; totalPoints?: number };
    const remainingPoints = details.remainingPoints || 0;
    const msBeforeNext = details.msBeforeNext || 1000;
    const secondsToWait = Math.round(msBeforeNext / 1000) || 1;

    // Registrar violação no sistema de auditoria
    securityAuditLogger.logRateLimitViolation(
      ip,
      req.path,
      req.get('User-Agent') || undefined,
      details.totalPoints || 'unknown'
    );

    res.set({
      'Retry-After': secondsToWait,
      'X-RateLimit-Limit': details.totalPoints || 'unknown',
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
  };

  /**
   * Zera os contadores e recria os limiters.
   *
   * A limpeza no Redis usa SCAN, e não KEYS: `KEYS` bloqueia o servidor
   * enquanto varre o keyspace inteiro, e quem roda isto é um endpoint de
   * desenvolvimento, mas o bloqueio em Redis é do servidor — não do processo que
   * pediu.
   */
  async reset(): Promise<void> {
    if (this.redisClient && this.isRedisUsable()) {
      try {
        let cursor = '0';
        do {
          const page = await this.redisClient.scan(cursor, {
            MATCH: `${this.config.redis.keyPrefix}*`,
            COUNT: 100
          });
          cursor = page.cursor;
          if (page.keys.length > 0) {
            await this.redisClient.del(page.keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        logger.warn('⚠️ Erro ao limpar Redis', error);
        this.setupLimiters();
        return;
      }

      this.setupRedisLimiters();
    } else {
      // Cliente morto não é motivo para reinstalar limiters Redis: o
      // `getStatus` mentiria, dizendo limite compartilhado com o Redis fora.
      this.setupLimiters();
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      // `usingRedis` é a pergunta que importa ("o limite vale entre processos
      // agora?"), não "já tentamos conectar alguma vez" — o limite em memória
      // numa instância com cliente Redis no ar é justamente o estado perigoso.
      usingRedis: this.usingRedis,
      redisUsable: this.isRedisUsable(),
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
    if (this.isRedisUsable()) {
      this.setupRedisLimiters();
    } else {
      this.setupLimiters();
    }

    return true;
  }
}

export const advancedRateLimit = new AdvancedRateLimiter();
