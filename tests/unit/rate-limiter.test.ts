import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockConnectionModule = (fakeRedisClient: Record<string, unknown> | null) => ({
  initRedis: jest.fn(async() => fakeRedisClient),
  performHealthCheck: jest.fn(async() => !!fakeRedisClient),
  getRedisStatus: jest.fn(() => ({
    isHealthy: !!fakeRedisClient,
    isConnected: !!fakeRedisClient,
    status: fakeRedisClient ? 'connected' : 'disconnected',
    message: ''
  })),
  isRedisAvailable: jest.fn(() => !!fakeRedisClient),
  cacheJWT: jest.fn(async() => {}),
  getCachedJWT: jest.fn(async() => null),
  clearCache: jest.fn(async() => {}),
  getRedisClient: jest.fn(() => fakeRedisClient),
  disconnectRedis: jest.fn(async() => {})
});

const loadRateLimiter = async(fakeRedisClient: Record<string, unknown> | null) => {
  jest.resetModules();
  await jest.unstable_mockModule('../../src/infrastructure/cache/connection.js', () => mockConnectionModule(fakeRedisClient));
  return (await import('../../src/application/middleware/advancedRateLimit.js')).advancedRateLimit;
};

describe('AdvancedRateLimiter - promoção para Redis', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
  });

  it('promove para limiters Redis quando um cliente está disponível', async() => {
    const fakeRedisClient = {
      isReady: true,
      on: jest.fn(),
      connect: jest.fn(async() => {}),
      ping: jest.fn(async() => 'PONG')
    };

    const limiter = await loadRateLimiter(fakeRedisClient);

    expect(limiter.initialized).toBe(false);
    await limiter.init();

    expect(limiter.redisClient).toBe(fakeRedisClient);
    expect(limiter.initialized).toBe(true);
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterRedis');
    expect(limiter.limiters.login.constructor.name).toBe('RateLimiterRedis');
  });

  it('mantém limiters em memória como fallback sem Redis', async() => {
    const limiter = await loadRateLimiter(null);

    await limiter.init();

    expect(limiter.redisClient).toBeNull();
    expect(limiter.initialized).toBe(true);
    expect(limiter.limiters.ip.constructor.name).not.toBe('RateLimiterRedis');
  });

  it('reseta criando limiters novos em memória', async() => {
    const limiter = await loadRateLimiter(null);

    await limiter.reset();

    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterMemory');
  });
});

describe('AdvancedRateLimiter - aplicação de limites', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_IP_POINTS = '2';
    process.env.RATE_LIMIT_PROD_USER_POINTS = '2';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '2';
    delete process.env.REDIS_URL;
  });

  const makeRequest = (ip: string, path: string, user?: { id: string }) => ({
    ip,
    path,
    method: 'GET',
    get: jest.fn(() => 'agent'),
    user,
    headers: {}
  });

  const makeResponse = () => ({
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  });

  it('deixa a requisição passar dentro do limite', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('aplica 429 RATE_LIMIT_EXCEEDED quando o limite do IP é atingido', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);
    await limiter.checkLimits(req as never, res as never, next);
    await limiter.checkLimits(req as never, res as never, next);

    const err = next.mock.calls[0]?.[0] ?? (next.mock.calls[1]?.[0] ?? next.mock.calls[2][0]);
    expect(err).toBeInstanceOf((await import('../../src/shared/utils/errorHandler.js')).HttpError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Retry-After': expect.any(Number) }));
  });

  it('bloqueia por usuário quando o ID do usuário ultrapassa o limite', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('5.6.7.8', '/anything', { id: 'user-1' });
    const res = makeResponse();
    const next = jest.fn();

    for (let i = 0; i < 3; i += 1) {
      await limiter.checkLimits(req as never, res as never, next);
    }

    expect(next.mock.calls.map(c => c[0]?.statusCode).filter(Boolean)).toContain(429);
  });

  it('ignora paths isentos de rate limit', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/health');
    const res = makeResponse();
    const next = jest.fn();

    for (let i = 0; i < 10; i += 1) {
      await limiter.checkLimits(req as never, res as never, next);
    }

    expect(next.mock.calls.every(c => c.length === 0)).toBe(true);
  });
});
