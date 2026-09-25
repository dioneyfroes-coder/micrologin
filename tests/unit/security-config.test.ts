import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalEnv = { ...process.env };

const loadConfig = async() => {
  jest.resetModules();
  return import('../../src/interfaces/config/appConfig.js');
};

const configureProduction = (token: string) => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
  process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
  process.env.SECURITY_DASHBOARD_TOKEN = token;
};

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
});

describe('configuração do dashboard de segurança', () => {
  it('exige token em produção', async() => {
    configureProduction('');

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/SECURITY_DASHBOARD_TOKEN é obrigatório/);
  });

  it('exige token com pelo menos 32 caracteres em produção', async() => {
    configureProduction('too-short');

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/pelo menos 32 caracteres/);
  });

  it('aceita um token forte em produção', async() => {
    configureProduction('a'.repeat(32));

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });
});
