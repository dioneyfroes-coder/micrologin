import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [healthCheckModule, mongooseModule, cache] = await (async() => {
  const mongooseMock = {
    connection: {
      readyState: 0,
      db: {
        admin: jest.fn().mockReturnValue({
          ping: jest.fn().mockResolvedValue({ ok: 1 })
        })
      }
    }
  };

  await jest.unstable_mockModule('mongoose', () => ({ default: mongooseMock }));
  await jest.unstable_mockModule('../../src/infrastructure/cache/connection.js', () => ({
    getCachedJWT: jest.fn()
  }));

  const healthCheck = await import('../../src/shared/utils/healthCheck.js');
  const mongooseModule = await import('mongoose');
  const cacheModule = await import('../../src/infrastructure/cache/connection.js');

  return [healthCheck, mongooseModule, cacheModule];
})();

const { performHealthCheck } = healthCheckModule;
const mongodb = mongooseModule.default;

describe('performHealthCheck - system health checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports unhealthy when MongoDB is disconnected', async() => {
    mongodb.connection.readyState = 0;
    cache.getCachedJWT.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result.status).toBe('unhealthy');
    expect(result.services.mongodb.status).toBe('unhealthy');
  });

  it('reports healthy when MongoDB and Redis are operational', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    cache.getCachedJWT.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result.services.mongodb.status).toBe('healthy');
    expect(result.services.redis.status).toBe('healthy');
    expect(result.services.uptime.status).toBe('healthy');
    expect(result.status).not.toBe('unhealthy');
  });

  it('reports degraded when Redis is unavailable but MongoDB works', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    cache.getCachedJWT.mockRejectedValue(new Error('redis down'));

    const result = await performHealthCheck();

    expect(result.status).toBe('degraded');
    expect(result.services.redis.status).toBe('degraded');
  });

  it('returns a stable response envelope with timestamp and environment', async() => {
    mongodb.connection.readyState = 1;
    cache.getCachedJWT.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('responseTime');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('environment', 'test');
    expect(result.services).toHaveProperty('memory');
  });
});
