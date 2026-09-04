import { describe, it, expect, jest } from '@jest/globals';

const createFakeClient = () => {
  const handlers = {};
  const store = {};
  return {
    isReady: false,
    _handlers: handlers,
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    connect: jest.fn(async() => {
      clientRef.isReady = true;
    }),
    ping: jest.fn(async() => 'PONG'),
    setEx: jest.fn(async(key, ttl, value) => {
      store[key] = value;
    }),
    get: jest.fn(async(key) => store[key]),
    del: jest.fn(async(key) => {
      delete store[key];
    }),
    flushDb: jest.fn(async() => {
      Object.keys(store).forEach(key => delete store[key]);
    }),
    quit: jest.fn(async() => undefined)
  };
};

let clientRef = null;
let createClientMock = null;

const loadCache = async() => {
  jest.resetModules();
  clientRef = createFakeClient();
  createClientMock = jest.fn(() => clientRef);
  await jest.unstable_mockModule('redis', () => ({ default: { createClient: createClientMock } }));
  return await import('../../src/infrastructure/cache/connection.js');
};

describe('Redis cache connection', () => {
  it('returns null and stays disconnected when import state is fresh', async() => {
    const cache = await loadCache();
    expect(cache.getRedisClient()).toBeNull();
    expect(cache.isRedisAvailable()).toBe(false);

    const status = cache.getRedisStatus();
    expect(status.status).toBe('disconnected');
    expect(status.message).toContain('indisponível');
  });

  it('reuses an already-ready client on subsequent init calls', async() => {
    const cache = await loadCache();

    const client = await cache.initRedis();
    expect(client).toBe(clientRef);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(cache.getRedisStatus().isHealthy).toBe(true);

    const again = await cache.initRedis();
    expect(again).toBe(clientRef);
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('sets up reconnect strategy with retry limits on the socket', async() => {
    const cache = await loadCache();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_HOST = 'redis.example.com';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_DB = '2';

    await cache.initRedis();

    const redisConfig = createClientMock.mock.calls[0][0];
    expect(redisConfig.host).toBe('redis.example.com');
    expect(redisConfig.port).toBe(6380);
    expect(redisConfig.db).toBe(2);
    expect(redisConfig.password).toBe('secret');
    expect(redisConfig.socket.connectTimeout).toBe(10000);

    expect(typeof redisConfig.socket.reconnectStrategy).toBe('function');
    expect(redisConfig.socket.reconnectStrategy(4)).toBeInstanceOf(Error);
    expect(redisConfig.socket.reconnectStrategy(1)).toBe(50);
    expect(redisConfig.socket.reconnectStrategy(3)).toBe(150);

    errSpy.mockRestore();
  });

  it('returns null and keeps cache disabled when the health check fails', async() => {
    const cache = await loadCache();
    clientRef.ping = jest.fn(async() => 'NOPE');

    const result = await cache.initRedis();

    expect(result).toBeNull();
    expect(cache.getRedisClient()).toBeNull();
    expect(cache.getRedisStatus().status).toBe('disconnected');
  });

  it('returns null when reading the health-check key returns a mismatch', async() => {
    const cache = await loadCache();
    clientRef.get = jest.fn(async() => 'corrupted');

    const result = await cache.initRedis();

    expect(result).toBeNull();
    expect(cache.isRedisAvailable()).toBe(false);
  });

  it('returns null when connecting throws and logs a warning', async() => {
    const cache = await loadCache();
    clientRef.connect = jest.fn(async() => {
      throw new Error('connection refused');
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await cache.initRedis();

    expect(result).toBeNull();
    expect(warnSpy.mock.calls[0][0]).toContain('sem cache');
    warnSpy.mockRestore();
  });

  it('caches, reads and clears JWTs when redis is available', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    const userData = { userId: '123', role: 'admin' };
    await cache.cacheJWT('tok123', userData);

    expect(clientRef.setEx).toHaveBeenCalledWith(
      'jwt:tok123',
      3600,
      JSON.stringify(userData)
    );

    clientRef.get.mockImplementation(async() => JSON.stringify(userData));
    const cached = await cache.getCachedJWT('tok123');
    expect(cached).toEqual(userData);

    await cache.clearCache('some-key');
    expect(clientRef.del).toHaveBeenCalledWith('some-key');

    await cache.clearCache();
    expect(clientRef.flushDb).toHaveBeenCalled();

    expect(cache.getRedisClient()).toBe(clientRef);
  });

  it('skips cache operations silently when redis is unavailable', async() => {
    const cache = await loadCache();

    await cache.cacheJWT('tok', {});
    expect(clientRef.setEx).not.toHaveBeenCalled();

    expect(await cache.getCachedJWT('tok')).toBeNull();

    await cache.clearCache('key');
    expect(clientRef.del).not.toHaveBeenCalled();
  });

  it('swallows cache write/read errors and returns null', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    clientRef.setEx = jest.fn(async() => {
      throw new Error('ENOMEM');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await cache.cacheJWT('tok', {});
    expect(errSpy.mock.calls[0][0]).toContain('cache');

    clientRef.get = jest.fn(async() => {
      throw new Error('timeout');
    });
    expect(await cache.getCachedJWT('tok')).toBeNull();

    clientRef.del = jest.fn(async() => {
      throw new Error('timeout');
    });
    await cache.clearCache('key');
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('tracks unhealthy state via the error event and disconnects cleanly', async() => {
    const cache = await loadCache();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await cache.initRedis();

    clientRef._handlers.error(new Error('ECONNRESET'));
    expect(cache.getRedisStatus().isHealthy).toBe(false);
    expect(cache.isRedisAvailable()).toBe(false);

    await cache.disconnectRedis();
    expect(clientRef.quit).toHaveBeenCalled();
    expect(cache.getRedisStatus().status).toBe('disconnected');

    // Graceful no-op when already disconnected
    await cache.disconnectRedis();
    expect(clientRef.quit).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('marks healthy when the ready event fires', async() => {
    const cache = await loadCache();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cache.initRedis();

    clientRef.isReady = false;
    clientRef._handlers.ready();

    expect(cache.getRedisStatus().isHealthy).toBe(true);

    warnSpy.mockRestore();
  });
});
