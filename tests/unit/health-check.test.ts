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

const { performHealthCheck, performLivenessCheck, performReadinessCheck } = healthCheckModule;
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

describe('performReadinessCheck - o startup não é tráfego válido', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    cacheGet.mockResolvedValue(null);
  });

  it('durante a conexão (readyState=2), o serviço ainda NÃO está pronto', async() => {
    // O processo subiu e o connectDatabase ainda não terminou. É a janela em
    // que um readiness otimista colocaria tráfego num serviço incapaz de
    // consultar o banco.
    mongodb.connection.readyState = 2;

    const result = await performReadinessCheck();

    expect(result.ready).toBe(false);
    expect(result.status).toBe('not_ready');
    expect(result.checks.mongodb.status).toBe('unhealthy');
    expect(result.checks.mongodb.state).toBe('connecting');
    // Já degradado: quem não está pronto também não está saudável.
    expect(result.degraded).toBe(true);
  });

  it('no mesmo instante do startup, o liveness continua verde', async() => {
    // O probe de liveness não pode depender do banco: se dependesse, o
    // orquestrador reiniciaria o container enquanto ele tentava conectar, e a
    // inicialização nunca terminaria.
    mongodb.connection.readyState = 2;

    const readiness = await performReadinessCheck();
    const liveness = performLivenessCheck();

    expect(readiness.ready).toBe(false);
    expect(liveness.status).toBe('alive');
    expect(liveness.pid).toBe(process.pid);
  });

  it('perda do Mongo depois do startup também tira a prontidão, mas não a vida', async() => {
    mongodb.connection.readyState = 0;

    const readiness = await performReadinessCheck();

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.mongodb.status).toBe('unhealthy');
    expect(readiness.checks.mongodb.state).toBe('disconnected');
    expect(performLivenessCheck().status).toBe('alive');
  });

  it('Mongo de pé com o Redis fora continua pronto, apenas degradado', async() => {
    mongodb.connection.readyState = 1;
    cacheGet.mockRejectedValue(new Error('redis down'));

    const result = await performReadinessCheck();

    // O cache é fail-open por padrão em dev/test: sem Redis o serviço ainda
    // cumpre o contrato dos endpoints de negócio.
    expect(result.ready).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.degraded).toBe(true);
    expect(result.checks.redis.status).toBe('degraded');
  });

  it('pronto só quando o Mongo responde ao ping de verdade', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockRejectedValue(new Error('ping falhou'));

    const result = await performReadinessCheck();

    // readyState=1 com o ping recusado é o caso perigoso: a conexão parece
    // de pé, mas o banco não responde. "ready" aqui seria mentira.
    expect(result.ready).toBe(false);
    expect(result.status).toBe('not_ready');
    expect(result.checks.mongodb.status).toBe('unhealthy');
  });
});
