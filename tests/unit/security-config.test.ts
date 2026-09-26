import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalEnv = { ...process.env };

const loadConfig = async() => {
  jest.resetModules();
  return import('../../src/interfaces/config/appConfig.js');
};

const configureProduction = (token: string) => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-with-32-chars-min!!';
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

describe('configuração dos segredos JWT', () => {
  it('exige JWT_REFRESH_SECRET em produção (sem fallback para JWT_SECRET)', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.JWT_REFRESH_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET é obrigatório/);
  });

  it('exige JWT_REFRESH_SECRET com pelo menos 32 caracteres', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_REFRESH_SECRET = 'curto';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET deve ter pelo menos 32 caracteres/);
  });

  it('rejeita JWT_REFRESH_SECRET igual a JWT_SECRET em produção', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_REFRESH_SECRET = process.env.JWT_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET deve ser diferente/);
  });

  it('aceita segredos distintos e não os expõe no resumo', async() => {
    configureProduction('a'.repeat(32));

    const { validateConfiguration, getConfigSummary } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    const summary = getConfigSummary() as unknown as {
      security: { jwt: boolean; refreshJwt: boolean };
    };
    expect(summary.security.jwt).toBe(true);
    expect(summary.security.refreshJwt).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('test-secret-key');
  });

  it('não exige JWT_REFRESH_SECRET fora de produção', async() => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
    delete process.env.JWT_REFRESH_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });
});

describe('política de revogação com Redis indisponível', () => {
  it('é fail-closed por padrão em produção', async() => {
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_FAIL_OPEN;

    const { securityConfig } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(false);
  });

  it('é fail-open por padrão fora de produção', async() => {
    process.env.NODE_ENV = 'development';
    delete process.env.SESSION_FAIL_OPEN;

    const { securityConfig } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(true);
  });

  it('respeita SESSION_FAIL_OPEN=true explícito em produção', async() => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_FAIL_OPEN = 'true';

    const { securityConfig, getConfigSummary } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(true);
    expect((getConfigSummary() as unknown as { session: { failOpen: boolean } }).session.failOpen).toBe(true);
  });
});
