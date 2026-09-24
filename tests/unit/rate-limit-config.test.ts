import { describe, it, expect, jest, afterEach } from '@jest/globals';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const load = async() => {
  jest.resetModules();
  return await import('../../src/interfaces/config/rateLimitConfig.js');
};

describe('rateLimitConfig - configuração centralizada', () => {
  it('parseEnvNumber converte strings com fallback', async() => {
    const { parseEnvNumber } = await load();
    expect(parseEnvNumber('42', 10)).toBe(42);
    expect(parseEnvNumber(undefined, 10)).toBe(10);
    expect(parseEnvNumber('abc', 10)).toBe(10);
  });

  it('usa a configuração de produção quando NODE_ENV=test', async() => {
    process.env.NODE_ENV = 'test';
    const { getActiveConfig } = await load();

    const config = getActiveConfig();

    expect(config.environment).toBe('production');
    expect(config.ip.points).toBe(100);
    expect(config.login.points).toBe(5);
    expect(config.exemptPaths).toEqual(expect.arrayContaining(['/health', '/metrics']));
  });

  it('usa a configuração de desenvolvimento quando NODE_ENV=development', async() => {
    process.env.NODE_ENV = 'development';
    delete process.env.RATE_LIMIT_IP_POINTS;
    const { getActiveConfig } = await load();

    const config = getActiveConfig();

    expect(config.environment).toBe('development');
    expect(config.ip.points).toBe(1000);
    expect(config.login.points).toBe(50);
  });

  it('respeita variáveis de ambiente personalizadas', async() => {
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '3';
    process.env.RATE_LIMIT_PROD_LOGIN_DURATION = '60';
    const { getActiveConfig } = await load();

    const config = getActiveConfig();

    expect(config.login.points).toBe(3);
    expect(config.login.duration).toBe(60);
  });

  it('valida a configuração ativa como válida com defaults', async() => {
    process.env.NODE_ENV = 'test';
    const { validateRateLimitConfig } = await load();

    const result = validateRateLimitConfig();

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.config.redis.keyPrefix).toBe('rl_');
  });

  it('inválida a configuração com pontos zerados via env', async() => {
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_IP_POINTS = '0';
    const { validateRateLimitConfig } = await load();

    const result = validateRateLimitConfig();

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('ip.points')]));
  });
});
