import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fonte única do Mongo (Fase 1.3). O que estes testes prendem:
 *
 *   - credencial separada da URI vira `auth`/`authSource`, que é o formato que
 *     o driver aceita e que não aparece em log de conexão;
 *   - credencial na URI e nas variáveis ao mesmo tempo é conflito detectado
 *     aqui, e recusado na validação, em vez de resolvido dentro do driver;
 *   - `mongodb+srv://` implica TLS, e `MONGODB_TLS` cobre o resto.
 */

const originalEnv = { ...process.env };

const MONGO_ENV = [
  'URI_MONGODB', 'MONGODB_USER', 'MONGODB_PASSWORD', 'MONGODB_PASSWORD_PATH',
  'MONGODB_AUTH_SOURCE', 'MONGODB_TLS', 'MONGODB_MAX_POOL_SIZE',
  'MONGODB_TIMEOUT', 'MONGODB_SOCKET_TIMEOUT'
];

const load = async() => {
  jest.resetModules();
  return await import('../../src/interfaces/config/mongoConfig.js');
};

const clearMongoEnv = () => {
  for (const key of MONGO_ENV) {
    delete process.env[key];
  }
};

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'mongo-config-'));

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('mongoConfig - fonte única de configuração', () => {
  it('detecta credencial embutida na URI', async() => {
    clearMongoEnv();
    const { mongoUriHasCredentials } = await load();

    expect(mongoUriHasCredentials('mongodb://user:senha@host:27017/db')).toBe(true);
    expect(mongoUriHasCredentials('mongodb://host:27017/db')).toBe(false);
    expect(mongoUriHasCredentials(undefined)).toBe(false);
  });

  it('monta auth/authSource a partir das variáveis separadas', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb://mongodb:27017/auth';
    process.env.MONGODB_USER = 'auth-service';
    process.env.MONGODB_PASSWORD = 'senha-de-teste';
    const { getMongoConfig, getMongoClientOptions } = await load();

    const config = getMongoConfig();
    expect(config.auth).toEqual({ username: 'auth-service', password: 'senha-de-teste', source: 'admin' });
    expect(config.credentialsConflict).toBe(false);

    const { options } = getMongoClientOptions();
    expect(options).toMatchObject({
      auth: { username: 'auth-service', password: 'senha-de-teste' },
      authSource: 'admin'
    });
  });

  it('lê a senha de arquivo, sem ela passar pela URI', async() => {
    clearMongoEnv();
    const dir = freshDir();
    const file = join(dir, 'mongo-app-password');
    writeFileSync(file, 'senha-no-arquivo\n');
    process.env.URI_MONGODB = 'mongodb://mongodb:27017/auth';
    process.env.MONGODB_USER = 'auth-service';
    process.env.MONGODB_PASSWORD_PATH = file;
    const { getMongoConfig } = await load();

    const config = getMongoConfig();

    expect(config.uri).not.toContain('senha-no-arquivo');
    expect(config.auth?.password).toBe('senha-no-arquivo');
    expect(config.authError).toBeUndefined();
  });

  it('recusa a senha em variável e em arquivo ao mesmo tempo', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb://mongodb:27017/auth';
    process.env.MONGODB_PASSWORD = 'da-variavel';
    process.env.MONGODB_PASSWORD_PATH = '/qualquer/caminho';
    const { getMongoConfig } = await load();

    const config = getMongoConfig();

    expect(config.auth).toBeUndefined();
    expect(config.authError).toMatch(/MONGODB_PASSWORD e MONGODB_PASSWORD_PATH/);
  });

  it('marca conflito quando a URI e as variáveis trazem credencial', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb://user:senha@mongodb:27017/auth';
    process.env.MONGODB_USER = 'auth-service';
    process.env.MONGODB_PASSWORD = 'outra-senha';
    const { getMongoConfig } = await load();

    expect(getMongoConfig().credentialsConflict).toBe(true);
  });

  it('trata mongodb+srv como TLS por definição', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb+srv://cluster.example.net/auth';
    const { getMongoConfig } = await load();

    expect(getMongoConfig().tls).toBe(true);
  });

  it('liga TLS por MONGODB_TLS sem exigir esquema srv', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb://mongodb:27017/auth';
    process.env.MONGODB_TLS = 'true';
    const { getMongoClientOptions } = await load();

    expect(getMongoClientOptions().options.tls).toBe(true);
  });

  it('propaga pool e timeouts, que antes ficavam sem efeito', async() => {
    clearMongoEnv();
    process.env.URI_MONGODB = 'mongodb://mongodb:27017/auth';
    process.env.MONGODB_MAX_POOL_SIZE = '25';
    process.env.MONGODB_TIMEOUT = '10000';
    process.env.MONGODB_SOCKET_TIMEOUT = '45000';
    const { getMongoClientOptions } = await load();

    expect(getMongoClientOptions().options).toEqual({
      maxPoolSize: 25,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });
  });
});
