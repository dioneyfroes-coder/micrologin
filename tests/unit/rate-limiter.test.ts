import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockConnectionModule = (fakeRedisClient: Record<string, unknown> | null) => ({
  initRedis: jest.fn(async() => fakeRedisClient),
  performHealthCheck: jest.fn(async() => !!fakeRedisClient),
  getRedisStatus: jest.fn(() => ({
    isHealthy: !!fakeRedisClient,
    isConnected: !!fakeRedisClient,
    status: fakeRedisClient ? 'connected' : 'disconnected',
    message: ''
  })),
  isRedisAvailable: jest.fn(() => !!fakeRedisClient),
  cacheJWT: jest.fn(async() => {}),
  getCachedJWT: jest.fn(async() => null),
  clearCache: jest.fn(async() => {}),
  getRedisClient: jest.fn(() => fakeRedisClient),
  disconnectRedis: jest.fn(async() => {})
});

const loadRateLimiter = async(fakeRedisClient: Record<string, unknown> | null) => {
  jest.resetModules();
  await jest.unstable_mockModule('../../src/infrastructure/cache/connection.js', () => mockConnectionModule(fakeRedisClient));
  return (await import('../../src/application/middleware/advancedRateLimit.js')).advancedRateLimit;
};

const usableRedisClient = () => ({
  isReady: true,
  on: jest.fn(),
  connect: jest.fn(async() => {}),
  ping: jest.fn(async() => 'PONG')
});

describe('AdvancedRateLimiter - promoção e queda de backend', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
  });

  it('promove para limiters Redis quando um cliente está disponível', async() => {
    const fakeRedisClient = usableRedisClient();

    const limiter = await loadRateLimiter(fakeRedisClient);

    // Antes do init, o limite é local: `usingRedis` é a pergunta que importa.
    expect(limiter.usingRedis).toBe(false);
    await limiter.init();

    expect(limiter.redisClient).toBe(fakeRedisClient);
    expect(limiter.usingRedis).toBe(true);
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterRedis');
    expect(limiter.limiters.login.constructor.name).toBe('RateLimiterRedis');
  });

  it('mantém limiters em memória como fallback sem Redis', async() => {
    const limiter = await loadRateLimiter(null);

    await limiter.init();

    expect(limiter.redisClient).toBeNull();
    expect(limiter.usingRedis).toBe(false);
    expect(limiter.limiters.ip.constructor.name).not.toBe('RateLimiterRedis');
  });

  it('não promove para um cliente que ainda não responde', async() => {
    // `initRedis` resolvendo com socket em reconexão: promover aqui deixaria o
    // limiter Redis pronto para falhar na primeira requisição.
    const limiter = await loadRateLimiter({ isReady: false, on: jest.fn() });

    await limiter.init();

    expect(limiter.usingRedis).toBe(false);
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterMemory');
  });

  it('desce para memória quando a conexão cai, em vez de continuar no Redis morto', async() => {
    const client = usableRedisClient();
    const limiter = await loadRateLimiter(client);
    await limiter.init();
    expect(limiter.usingRedis).toBe(true);

    // A queda é o estado `isReady: false` com o objeto ainda lá: é o que o
    // node-redis apresenta enquanto tenta reconectar.
    limiter.redisClient = { ...client, isReady: false };
    limiter.syncBackend();

    expect(limiter.usingRedis).toBe(false);
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterMemory');
  });

  it('volta para o Redis quando a conexão se restabelece', async() => {
    const client = usableRedisClient();
    const limiter = await loadRateLimiter(client);
    await limiter.init();

    limiter.redisClient = { ...client, isReady: false };
    limiter.syncBackend();
    expect(limiter.usingRedis).toBe(false);

    limiter.redisClient = client;
    limiter.syncBackend();

    // Sem isto, uma queda de meio segundo deixava o limite em memória pelo
    // resto do processo, e cada worker teria seu próprio orçamento.
    expect(limiter.usingRedis).toBe(true);
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterRedis');
  });

  it('o status responde "o limite vale entre processos agora?"', async() => {
    const client = usableRedisClient();
    const limiter = await loadRateLimiter(client);
    await limiter.init();

    expect(limiter.getStatus()).toMatchObject({ usingRedis: true, redisUsable: true, hasRedis: true });

    limiter.redisClient = { ...client, isReady: false };
    expect(limiter.getStatus()).toMatchObject({ usingRedis: true, redisUsable: false, hasRedis: true });
  });

  it('reseta criando limiters novos em memória', async() => {
    const limiter = await loadRateLimiter(null);

    await limiter.reset();

    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterMemory');
  });
});

describe('AdvancedRateLimiter - aplicação de limites', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_IP_POINTS = '2';
    process.env.RATE_LIMIT_PROD_USER_POINTS = '2';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '2';
    delete process.env.REDIS_URL;
  });

  const makeRequest = (ip: string, path: string, user?: { id: string }) => ({
    ip,
    path,
    method: 'GET',
    get: jest.fn(() => 'agent'),
    user,
    headers: {}
  });

  const makeResponse = () => ({
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  });

  it('deixa a requisição passar dentro do limite', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('aplica 429 RATE_LIMIT_EXCEEDED quando o limite do IP é atingido', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);
    await limiter.checkLimits(req as never, res as never, next);
    await limiter.checkLimits(req as never, res as never, next);

    const err = next.mock.calls[0]?.[0] ?? (next.mock.calls[1]?.[0] ?? next.mock.calls[2][0]);
    expect(err).toBeInstanceOf((await import('../../src/shared/utils/errorHandler.js')).HttpError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Retry-After': expect.any(Number) }));
  });

  it('falha do driver Redis vira recusa em memória, e não 429 para o cliente', async() => {
    const limiter = await loadRateLimiter(usableRedisClient());
    await limiter.init();

    // Limiters Redis instalados, driver fora do ar: o que chega no `catch` é
    // um `Error` ("Connection is closed"), sem `msBeforeNext`. Tratar isso como
    // limite estourado respondia 429 com `Retry-After` para todo mundo e
    // registrava "violação de rate limit" numa queda de dependência.
    limiter.limiters = {
      ip: { consume: jest.fn().mockRejectedValue(new Error('Connection is closed.')) },
      user: { consume: jest.fn() },
      login: { consume: jest.fn() }
    };

    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);

    // A requisição passa, e o backend volta a ser local.
    expect(next).toHaveBeenCalledWith();
    expect(limiter.limiters.ip.constructor.name).toBe('RateLimiterMemory');
    expect(limiter.usingRedis).toBe(false);
  });

  it('a recusa de verdade continua sendo 429, mesmo vinda do backend Redis', async() => {
    const limiter = await loadRateLimiter(usableRedisClient());
    await limiter.init();

    // O objeto de recusa do rate-limiter-flexible: tem `msBeforeNext`. É a
    // diferença que separa "você excedeu" de "a dependência caiu".
    limiter.limiters = {
      ip: {
        consume: jest.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue({ msBeforeNext: 5000, remainingPoints: 0, totalPoints: 2 })
      },
      user: { consume: jest.fn() },
      login: { consume: jest.fn() }
    };

    const req = makeRequest('1.2.3.4', '/anything');
    const res = makeResponse();
    const next = jest.fn();

    await limiter.checkLimits(req as never, res as never, next);
    await limiter.checkLimits(req as never, res as never, next);

    // A primeira requisição passou limpa; a segunda recebeu a recusa.
    const err = next.mock.calls[1]?.[0];
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('bloqueia por usuário quando o ID do usuário ultrapassa o limite', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('5.6.7.8', '/anything', { id: 'user-1' });
    const res = makeResponse();
    const next = jest.fn();

    for (let i = 0; i < 3; i += 1) {
      await limiter.checkLimits(req as never, res as never, next);
    }

    expect(next.mock.calls.map(c => c[0]?.statusCode).filter(Boolean)).toContain(429);
  });

  it('ignora paths isentos de rate limit', async() => {
    const limiter = await loadRateLimiter(null);
    const req = makeRequest('1.2.3.4', '/health');
    const res = makeResponse();
    const next = jest.fn();

    for (let i = 0; i < 10; i += 1) {
      await limiter.checkLimits(req as never, res as never, next);
    }

    expect(next.mock.calls.every(c => c.length === 0)).toBe(true);
  });
});

describe('AdvancedRateLimiter - login por conta (brute force distribuído)', () => {
  // Só o orçamento de login importa aqui: IP alto para que o limite por origem
  // nunca seja o que barra, isolando a proteção contra ataque dirigido a uma
  // conta a partir de origens diferentes.
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_IP_POINTS = '1000';
    process.env.RATE_LIMIT_PROD_USER_POINTS = '1000';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '3';
    delete process.env.REDIS_URL;
  });

  const makeLoginRequest = (ip: string, body?: unknown) => ({
    ip,
    path: '/login',
    method: 'POST',
    get: jest.fn(() => 'agent'),
    headers: {},
    body
  });

  const makeResponse = () => ({
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  });

  const attempt = async(limiter: { checkLimits: (req: unknown, res: unknown, next: unknown) => Promise<void> },
    ip: string, body: unknown) => {
    const next = jest.fn();
    const res = makeResponse();
    await limiter.checkLimits(makeLoginRequest(ip, body) as never, res as never, next);
    return next.mock.calls[0]?.[0];
  };

  it('bloqueia a conta mesmo quando cada tentativa vem de um IP diferente', async() => {
    const limiter = await loadRateLimiter(null);
    const errors = [];

    // 3 IPs distintos, a mesma conta atacada: o limite por IP não impede nada
    // aqui, porque cada origem tem orçamento próprio.
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      errors.push(await attempt(limiter, ip, { user: 'alice', password: 'Errada123!' }));
    }

    expect(errors.slice(0, 3).every(e => e === undefined)).toBe(true);
    const blocked = errors[3];
    expect(blocked).toBeDefined();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('a chave é a forma canônica: caixa e espaços não renovam o orçamento', async() => {
    const limiter = await loadRateLimiter(null);

    // Esgota o orçamento de `alice` (3 pontos) a partir de três IPs.
    for (const ip of ['10.1.0.1', '10.1.0.2', '10.1.0.3']) {
      expect(await attempt(limiter, ip, { user: 'alice', password: 'Errada123!' })).toBeUndefined();
    }
    // Mesma conta, outra escrita. Um atacante que ajuste a caixa continua
    // batendo no mesmo contador.
    const blocked = await attempt(limiter, '10.1.0.4', { user: '  ALICE  ', password: 'Errada123!' });

    expect(blocked).toBeDefined();
    expect(blocked.statusCode).toBe(429);
  });

  it('contas diferentes não compartilham orçamento', async() => {
    const limiter = await loadRateLimiter(null);

    // A conta alice já consumiu o orçamento dela com o teste anterior; aqui
    // cada conta é atacada uma vez e nenhuma deve ser barrada.
    const alice = await attempt(limiter, '10.2.0.1', { user: 'alice' });
    const bob = await attempt(limiter, '10.2.0.2', { user: 'bob' });
    const carol = await attempt(limiter, '10.2.0.3', { user: 'carol' });

    expect([alice, bob, carol].every(e => e === undefined)).toBe(true);
  });

  it('sem username no corpo, o orçamento é o do IP (não vira caminho livre)', async() => {
    const limiter = await loadRateLimiter(null);

    const errors = [];
    for (let i = 0; i < 4; i += 1) {
      errors.push(await attempt(limiter, '10.3.0.1', undefined));
    }

    expect(errors[3]).toBeDefined();
    expect(errors[3].statusCode).toBe(429);
  });

  it('username não string também cai no orçamento do IP', async() => {
    const limiter = await loadRateLimiter(null);

    const errors = [];
    for (let i = 0; i < 4; i += 1) {
      errors.push(await attempt(limiter, '10.4.0.1', { user: { $ne: null } }));
    }

    expect(errors[3]).toBeDefined();
    expect(errors[3].statusCode).toBe(429);
  });
});
