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
    getRedisClient: jest.fn(),
    performHealthCheck: jest.fn()
  }));

  const healthCheck = await import('../../src/shared/utils/healthCheck.js');
  const mongooseModule = await import('mongoose');
  const cacheModule = await import('../../src/infrastructure/cache/connection.js');

  return [healthCheck, mongooseModule, cacheModule];
})();

const { performHealthCheck, performLivenessCheck, performReadinessCheck } = healthCheckModule;
const mongodb = mongooseModule.default;
const getRedisClient = cache.getRedisClient as jest.Mock;
const redisPing = cache.performHealthCheck as jest.Mock;

/** Redis no ar: cliente presente e respondendo ao PING. */
const redisUp = () => {
  getRedisClient.mockReturnValue({ isReady: true });
  redisPing.mockResolvedValue(true);
};

/** Redis instanciado mas sem responder: o caso de uma conexão em reconexão. */
const redisUnresponsive = () => {
  getRedisClient.mockReturnValue({ isReady: false });
  redisPing.mockResolvedValue(false);
};

/** Sem cliente nenhum: o Redis nunca subiu, ou a conexão foi descartada. */
const redisAbsent = () => {
  getRedisClient.mockReturnValue(null);
};

describe('performHealthCheck - health checks de sistema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reporta unhealthy quando o MongoDB está desconectado', async() => {
    mongodb.connection.readyState = 0;
    redisUp();

    const result = await performHealthCheck();

    expect(result.status).toBe('unhealthy');
    expect(result.services?.mongodb.status).toBe('unhealthy');
  });

  it('reporta saudável quando MongoDB e Redis estão operacionais', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    redisUp();

    const result = await performHealthCheck();

    expect(result.services?.mongodb.status).toBe('healthy');
    expect(result.services?.redis.status).toBe('healthy');
    expect(result.services?.uptime.status).toBe('healthy');
    expect(result.status).not.toBe('unhealthy');
  });

  it('reporta degraded quando o Redis está indisponível mas o MongoDB funciona', async() => {
    mongodb.connection.readyState = 1;
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    redisUnresponsive();

    const result = await performHealthCheck();

    expect(result.services?.mongodb.status).toBe('healthy');
    expect(result.services?.redis.status).toBe('degraded');
    expect(result.status).toBe('degraded');
  });

  it('reporta degraded quando não há cliente Redis, em vez de healthy', async() => {
    // O caso que a implementação anterior não enxergava: `getCachedJWT` engole
    // erro e devolve `null`, então ler o cache "funcionava" mesmo com o Redis
    // fora, e o health check dizia que estava tudo bem. A revogação de token
    // estava inoperante e o monitor não tinha como saber.
    mongodb.connection.readyState = 1;
    redisAbsent();

    const result = await performHealthCheck();

    expect(result.services?.redis.status).toBe('degraded');
    expect(result.status).toBe('degraded');
  });

  it('reporta degraded quando o PING do Redis falha com erro', async() => {
    mongodb.connection.readyState = 1;
    getRedisClient.mockReturnValue({ isReady: true });
    redisPing.mockRejectedValue(new Error('redis down'));

    const result = await performHealthCheck();

    expect(result.services?.redis.status).toBe('degraded');
    expect(result.status).toBe('degraded');
  });

  it('inclui informação de memória e uptime', async() => {
    mongodb.connection.readyState = 0;
    redisUp();

    const result = await performHealthCheck();

    expect(result.services?.memory).toBeDefined();
    expect(result.services?.memory.status).toBeDefined();
    expect(result.services?.uptime.pid).toBe(process.pid);
  });

  it('reporta a memória contra o limite do container, não um teto arbitrário', async() => {
    mongodb.connection.readyState = 0;
    redisUp();

    const result = await performHealthCheck();
    const memory = result.services?.memory.memory as Record<string, unknown>;

    // O alerta de memória é fração do `mem_limit` (lido do cgroup), porque um
    // MB fixo erra nas duas direções: no container de 1 GiB ele dispararia
    // durante o pico normal de logins, e num container maior nunca dispararia.
    expect(memory).toHaveProperty('limit');
    expect(memory).toHaveProperty('warningAbove');
    expect(typeof memory.ratio === 'number' || memory.ratio === null).toBe(true);
  });
});

describe('performReadinessCheck - o startup não é tráfego válido', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongodb.connection.db.admin().ping.mockResolvedValue({ ok: 1 });
    redisUp();
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
    redisUnresponsive();

    const result = await performReadinessCheck();

    // O cache é fail-open por padrão em dev/test: sem Redis o serviço ainda
    // cumpre o contrato dos endpoints de negócio. Em produção a política é
    // fail-closed e o próprio endpoint de login recusa - o que deixa o
    // processo pronto, mas indisponível para tráfego, que são coisas distintas.
    expect(result.ready).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.degraded).toBe(true);
    expect(result.checks.redis.status).toBe('degraded');
  });

  it('Mongo de pé e Redis ausente continua pronto, e reporta a degradação', async() => {
    mongodb.connection.readyState = 1;
    redisAbsent();

    const result = await performReadinessCheck();

    // Mesmo desfecho do cliente em reconexão: o readiness não pode ser
    // dependente do Redis, ou uma queda do cache tiraria o serviço de tráfego.
    expect(result.ready).toBe(true);
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
