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
const cacheGet = cache.getCachedJWT as jest.Mock;

describe('performHealthCheck - health checks de sistema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reporta unhealthy quando o MongoDB está desconectado', async() => {
    mongodb.connection.readyState = 0;
    cacheGet.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result.status).toBe('unhealthy');
    expect(result.services?.mongodb.status).toBe('unhealthy');
  });

  it('reporta saudável quando MongoDB e Redis estão operacionais', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    cacheGet.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result.services?.mongodb.status).toBe('healthy');
    expect(result.services?.redis.status).toBe('healthy');
    expect(result.services?.uptime.status).toBe('healthy');
    expect(result.status).not.toBe('unhealthy');
  });

  it('reporta degraded quando o Redis está indisponível mas o MongoDB funciona', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    cacheGet.mockRejectedValue(new Error('redis down'));

    const result = await performHealthCheck();

    expect(result.services?.mongodb.status).toBe('healthy');
    expect(result.services?.redis.status).toBe('degraded');
    expect(result.status).toBe('degraded');
  });

  it('inclui informação de memória e uptime', async() => {
    mongodb.connection.readyState = 0;
    cacheGet.mockResolvedValue(null);

    const result = await performHealthCheck();

    expect(result.services?.memory).toBeDefined();
    expect(result.services?.memory.status).toBeDefined();
    expect(result.services?.uptime.pid).toBe(process.pid);
  });
});
