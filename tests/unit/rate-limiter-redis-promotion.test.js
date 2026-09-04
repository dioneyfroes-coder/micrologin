import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockConnectionModule = (fakeRedisClient) => ({
  initRedis: jest.fn(async() => fakeRedisClient),
  performHealthCheck: jest.fn(async() => !!fakeRedisClient),
  getRedisStatus: jest.fn(() => ({
    isHealthy: !!fakeRedisClient,
    status: fakeRedisClient ? 'connected' : 'disconnected'
  })),
  isRedisAvailable: jest.fn(() => !!fakeRedisClient),
  cacheJWT: jest.fn(async() => {}),
  getCachedJWT: jest.fn(async() => null),
  clearCache: jest.fn(async() => {}),
  getRedisClient: jest.fn(() => fakeRedisClient),
  disconnectRedis: jest.fn(async() => {})
});

const loadRateLimiter = async(fakeRedisClient) => {
  jest.resetModules();
  await jest.unstable_mockModule('../../src/infrastructure/cache/connection.js', () => mockConnectionModule(fakeRedisClient));
  return (await import('../../src/application/middleware/advancedRateLimit.js')).advancedRateLimit;
};

describe('Rate limiter Redis promotion', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('dynamically upgrades to Redis limiters when a Redis client is available', async() => {
    const fakeRedisClient = {
      isReady: true,
      on: jest.fn(),
      connect: jest.fn(async() => {}),
      ping: jest.fn(async() => 'PONG')
    };

    const advancedRateLimit = await loadRateLimiter(fakeRedisClient);

    expect(advancedRateLimit.initialized).toBe(false);

    await advancedRateLimit.init();

    expect(advancedRateLimit.redisClient).toBe(fakeRedisClient);
    expect(advancedRateLimit.initialized).toBe(true);
    expect(advancedRateLimit.limiters.ip.constructor.name).toBe('RateLimiterRedis');
    expect(advancedRateLimit.limiters.user.constructor.name).toBe('RateLimiterRedis');
    expect(advancedRateLimit.limiters.login.constructor.name).toBe('RateLimiterRedis');
  });

  it('keeps memory limiters as fallback when no Redis client is available', async() => {
    const advancedRateLimit = await loadRateLimiter(null);

    await advancedRateLimit.init();

    expect(advancedRateLimit.redisClient).toBeNull();
    expect(advancedRateLimit.initialized).toBe(true);
    expect(advancedRateLimit.limiters.ip.constructor.name).not.toBe('RateLimiterRedis');
  });

  it('throttles reconnection attempts after a failure', async() => {
    const advancedRateLimit = await loadRateLimiter(null);

    await advancedRateLimit.init();
    expect(advancedRateLimit.initialized).toBe(true);

    advancedRateLimit.initialized = false;
    advancedRateLimit.lastInitAttempt = Date.now();

    advancedRateLimit.ensureInit();
    expect(advancedRateLimit.initPromise).toBeNull();

    advancedRateLimit.lastInitAttempt = Date.now() - 60000;
    advancedRateLimit.ensureInit();
    expect(advancedRateLimit.initPromise).not.toBeNull();

    await advancedRateLimit.initPromise;
  });
});
