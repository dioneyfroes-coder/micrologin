import { describe, it, expect, jest } from '@jest/globals';

const createFakeClient = () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const store: Record<string, string> = {};
  const clientRef: Record<string, unknown> = {
    isReady: false,
    isOpen: false,
    handlers,
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    connect: jest.fn(async() => {
      clientRef.isReady = true;
      clientRef.isOpen = true;
      // O node-redis emite `ready` na conexão inicial, não só nas reconexões.
      // Reproduzir isso aqui é o que torna o teste da corrida real.
      handlers.ready?.();
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
    quit: jest.fn(async() => undefined),
    destroy: jest.fn(() => {
      clientRef.isOpen = false;
      clientRef.isReady = false;
    })
  };
  return clientRef as {
    isReady: boolean;
    isOpen: boolean;
    handlers: Record<string, (...args: unknown[]) => void>;
    on: ReturnType<typeof jest.fn>;
    connect: ReturnType<typeof jest.fn>;
    ping: ReturnType<typeof jest.fn>;
    setEx: ReturnType<typeof jest.fn>;
    get: ReturnType<typeof jest.fn>;
    del: ReturnType<typeof jest.fn>;
    flushDb: ReturnType<typeof jest.fn>;
    quit: ReturnType<typeof jest.fn>;
    destroy: ReturnType<typeof jest.fn>;
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

describe('Redis cache - reconexão', () => {
  it('o ready da conexão inicial não disputa a saúde com o health check do init', async() => {
    // O `ready` do node-redis também dispara na primeira conexão. Sem a
    // guarda, o handler roda um PING em paralelo com o health check do
    // `initRedis` e quem terminasse por último escrevia `isHealthy` — inclusive
    // sobrescrevendo um `true` válido por um `false` apenas por perder a
    // corrida. Num arranque com o Redis lento, o serviço começava reportando
    // "Redis indisponível" mesmo tendo conectado.
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = await loadCache();

    await cache.initRedis();

    // O PING do handler não pode ter acontecido: só o do `initRedis`.
    expect(clientRef!.ping).toHaveBeenCalledTimes(1);
    expect(cache.getRedisStatus().isHealthy).toBe(true);
    const reconnectLogs = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
      .filter(([message]) => String(message).includes('reconect'));
    expect(reconnectLogs).toHaveLength(0);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('a estratégia de reconexão nunca desiste: devolve atraso, não erro', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    const options = (createClientMock as ReturnType<typeof jest.fn>).mock.calls[0][0];
    const strategy = options.socket.reconnectStrategy;

    // Desistir é o pior desfecho possível sob fail-closed: um cliente morto
    // com `isReady === false` deixa a autenticação inteira devolvendo 503 até
    // alguém reiniciar o processo, e o único sinal é uma linha de log.
    const delays = [0, 1, 2, 3, 5, 8, 20].map((retries: number) => strategy(retries));

    expect(delays.every((delay: unknown) => typeof delay === 'number' && delay > 0)).toBe(true);
    // Backoff cresce, mas com teto: espera infinita empurraria a recuperação
    // para depois do que a janela de tolerate do orquestrador permite.
    expect(delays[6]).toBeGreaterThan(delays[0]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5000);
  });

  it('a queda marca o cache como indisponível para o resto do serviço', async() => {
    const cache = await loadCache();
    await cache.initRedis();
    expect(cache.isRedisAvailable()).toBe(true);

    // `isReady: false` com o objeto ainda referenciado é o estado de queda: o
    // node-redis mantém o mesmo cliente e passa a reconectar por baixo.
    clientRef!.isReady = false;
    clientRef!.handlers.error(new Error('socket closed'));

    expect(cache.isRedisAvailable()).toBe(false);
    expect(cache.getRedisStatus().isHealthy).toBe(false);
    // `getRedisClient()` devolvendo `null` é o que faz o health check dizer
    // "degradado" e o rate limiter descer para memória.
    expect(cache.getRedisClient()).toBeNull();
  });

  it('o evento ready religa a saúde depois da reconexão', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    clientRef!.isReady = false;
    clientRef!.handlers.error(new Error('socket closed'));
    expect(cache.getRedisStatus().isHealthy).toBe(false);

    clientRef!.isReady = true;
    clientRef!.handlers.ready();
    await new Promise((resolve) => setImmediate(resolve));

    // Sem isto, o serviço voltava a funcionar e continuava reportando Redis
    // degradado para sempre: o monitor mentia e o rate limiter nunca promovia
    // de volta o limite global.
    expect(cache.getRedisStatus().isHealthy).toBe(true);
    expect(cache.isRedisAvailable()).toBe(true);
  });

  it('não cria um segundo cliente enquanto o primeiro reconecta', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    // `isOpen` com `isReady: false` é a reconexão em curso. Outro cliente seria
    // uma tentativa duplicada, com o dobro de log de erro e nenhuma vantagem.
    clientRef!.isReady = false;
    clientRef!.isOpen = true;

    expect(await cache.initRedis()).toBeNull();
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it('desconectar limpa a referência mesmo sem resposta do Redis', async() => {
    const cache = await loadCache();
    await cache.initRedis();
    clientRef!.quit.mockRejectedValue(new Error('timeout'));

    await cache.disconnectRedis();

    // Um cliente que não confirmou o encerramento não pode continuar sendo o
    // cliente do processo: todo mundo voltaria a falar com ele.
    expect(cache.getRedisClient()).toBeNull();
    expect(cache.getRedisStatus().isHealthy).toBe(false);
    expect(cache.getRedisStatus().status).toBe('disconnected');
  });

  it('destrói o socket em reconexão em vez de tentar um comando sem resposta', async() => {
    const cache = await loadCache();
    await cache.initRedis();

    // `quit()` manda um comando ao Redis. Com o socket reconectando, ninguém o
    // atende, e o timer de reconexão continua rodando: o processo não encerra.
    clientRef!.isReady = false;

    await cache.disconnectRedis();

    expect(clientRef!.quit).not.toHaveBeenCalled();
    expect(clientRef!.destroy).toHaveBeenCalled();
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
