import { describe, it, expect, jest } from '@jest/globals';

describe('redisConfig - fonte única de configuração', () => {
  const originalEnv = { ...process.env };

  const load = async() => {
    jest.resetModules();
    return await import('../../src/interfaces/config/redisConfig.js');
  };

  it('resolve REDIS_URL como forma preferida e não define host/port', async() => {
    process.env.REDIS_URL = 'redis://:pw@cache.internal:6380/4';
    process.env.REDIS_HOST = 'ignored';
    process.env.REDIS_PORT = '1234';
    const { getRedisClientOptions } = await load();

    const options = getRedisClientOptions();

    expect(options).toEqual({ url: 'redis://:pw@cache.internal:6380/4' });
  });

  it('cai para host/port/password/db quando REDIS_URL está ausente', async() => {
    delete process.env.REDIS_URL;
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_DB = '2';
    const { getRedisClientOptions } = await load();

    const options = getRedisClientOptions();

    expect(options).toEqual({
      host: 'localhost',
      port: 6380,
      password: 'secret',
      db: 2
    });
  });

  it('omite password quando vazia', async() => {
    delete process.env.REDIS_URL;
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PASSWORD = '';
    const { getRedisClientOptions } = await load();

    const options = getRedisClientOptions();

    expect(options.password).toBeUndefined();
  });

  it('aplica defaults quando nenhuma variável Redis está presente', async() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_DB;
    const { getRedisConfig } = await load();

    const config = getRedisConfig();

    expect(config.host).toBe('localhost');
    expect(config.port).toBe(6379);
    expect(config.db).toBe(0);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });
});
