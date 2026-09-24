import { describe, it, expect, jest } from '@jest/globals';

const createFakeClient = () => {
  const handlers: Record<string, () => void> = {};
  const store: Record<string, string> = {};
  const clientRef: Record<string, unknown> = {
    isReady: false,
    on: jest.fn((event: string, handler: () => void) => {
      handlers[event] = handler;
    }),
    connect: jest.fn(async() => {
      clientRef.isReady = true;
    }),
    ping: jest.fn(async() => 'PONG'),
    setEx: jest.fn(async(key: string, ttl: number, value: string) => {
      store[key] = value;
    }),
    get: jest.fn(async(key: string) => store[key]),
    del: jest.fn(async(key: string) => {
      delete store[key];
    }),
    flushDb: jest.fn(async() => {
      Object.keys(store).forEach(key => delete store[key]);
    }),
    quit: jest.fn(async() => undefined)
  };
  return clientRef as {
    isReady: boolean;
    on: ReturnType<typeof jest.fn>;
    connect: ReturnType<typeof jest.fn>;
    ping: ReturnType<typeof jest.fn>;
    setEx: ReturnType<typeof jest.fn>;
    get: ReturnType<typeof jest.fn>;
    del: ReturnType<typeof jest.fn>;
    flushDb: ReturnType<typeof jest.fn>;
    quit: ReturnType<typeof jest.fn>;
  };
};

let clientRef: ReturnType<typeof createFakeClient> | null = null;
let createClientMock: ReturnType<typeof jest.fn> | null = null;

const loadCache = async() => {
  jest.resetModules();
  clientRef = createFakeClient();
  createClientMock = jest.fn(() => clientRef);
  await jest.unstable_mockModule('redis', () => ({ default: { createClient: createClientMock } }));
  return await import('../../src/infrastructure/cache/connection.js');
};

describe('Redis cache - conexão', () => {
  it('inicia desconectado e indisponível', async() => {
    const cache = await loadCache();

    expect(cache.getRedisClient()).toBeNull();
    expect(cache.isRedisAvailable()).toBe(false);

    const status = cache.getRedisStatus();
    expect(status.status).toBe('disconnected');
    expect(status.message).toContain('indisponível');
  });

  it('reutiliza cliente já pronto em chamadas subsequentes de init', async() => {
    const cache = await loadCache();

    const client = await cache.initRedis();
    expect(client).toBe(clientRef);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(cache.getRedisStatus().isHealthy).toBe(true);

    const again = await cache.initRedis();
    expect(again).toBe(clientRef);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('faz fallback para null quando a conexão falha', async() => {
    const cache = await loadCache();
    clientRef!.connect.mockRejectedValue(new Error('connection refused'));

    const client = await cache.initRedis();

    expect(client).toBeNull();
    expect(cache.getRedisStatus().status).toBe('disconnected');
  });

  it('marca health check como falho quando o PING não responde PONG', async() => {
    const cache = await loadCache();
    clientRef!.ping.mockResolvedValue('NOPE');

    const client = await cache.initRedis();

    expect(client).toBeNull();
    expect(cache.getRedisStatus().isHealthy).toBe(false);
  });
});

describe('Redis cache - cacheJWT/getCachedJWT/clearCache', () => {
  it('cacheia e recupera JWT quando o Redis está disponível', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    await cache.cacheJWT('token-x', { id: 'u-1', username: 'alice' }, 120);

    const cached = await cache.getCachedJWT('token-x');
    expect(cached).toEqual({ id: 'u-1', username: 'alice' });

    await cache.clearCache('jwt:token-x');
    expect(await cache.getCachedJWT('token-x')).toBeNull();
  });

  it('não falha quando o Redis está indisponível', async() => {
    const cache = await loadCache();

    await expect(cache.cacheJWT('token', { a: 1 })).resolves.toBeUndefined();
    expect(await cache.getCachedJWT('token')).toBeNull();
    await expect(cache.clearCache()).resolves.toBeUndefined();
  });

  it('limpa todo o cache com clearCache() sem chave', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    await cache.cacheJWT('a', { n: 1 });

    await cache.clearCache();

    expect(await cache.getCachedJWT('a')).toBeNull();
    expect(clientRef!.flushDb).toHaveBeenCalled();
  });

  it('desconecta do Redis com disconnectRedis', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    await cache.disconnectRedis();

    expect(cache.getRedisStatus().status).toBe('disconnected');
  });
});
