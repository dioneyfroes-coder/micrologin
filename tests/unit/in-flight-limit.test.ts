import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

/**
 * O disjuntor de requisições em andamento tem duas formas de ser inútil, e
 * ambas são silenciosas:
 *
 *  1. Deixar de proteger memória — aceitar tudo e confiar na boa vontade.
 *  2. Derrubar o sinal que diz se o serviço está vivo — recusar `/health` e
 *     `/readiness` transforma sobrecarga em reinício, e o container volta do
 *     mesmo jeito gastando o mesmo recurso.
 *
 * Os testes abaixo existem para travar as duas, mais a contabilidade, que é o
 * que separa "limitador" de "vazamento de estado".
 */

const MAX = 3;

type ResponseLike = Response & {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  released: number;
};

const loadLimiter = async(max = MAX) => {
  jest.resetModules();
  jest.unstable_mockModule('../../src/interfaces/config/appConfig.js', () => ({
    serverConfig: {
      inFlight: {
        max,
        bypassPaths: ['/health', '/readiness', '/observability', '/api-docs']
      }
    }
  }));
  return import('../../src/application/middleware/inFlightLimit.js');
};

const makeRes = (): ResponseLike => {
  const listeners: Record<string, (() => void)[]> = { close: [], finish: [] };

  const res = {
    headers: {} as Record<string, string>,
    released: 0,
    setHeader(key: string, value: string) {
      res.headers[key] = value;
    },
    on(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
    },
    emit(event: string) {
      (listeners[event] ?? []).forEach(fn => fn());
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    }
  } as unknown as ResponseLike;

  return res;
};

const makeReq = (path = '/login'): Request => ({ path, url: path } as unknown as Request);

/**
 * `next()` sem erro é o caminho normal, então só um erro de verdade conta.
 * Sem o filtro, toda admissão seria lida como recusa.
 */
const capture = (): { next: NextFunction; errors: unknown[] } => {
  const errors: unknown[] = [];
  return {
    errors,
    next: ((err?: unknown) => {
      if (err) {
        errors.push(err);
      }
    }) as NextFunction
  };
};

describe('inFlightLimit - default do teto', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.MAX_IN_FLIGHT_REQUESTS;
  });

  it('o default é 1024, o teto em que a medição o deixa transparente', async() => {
    const { serverConfig } = await import('../../src/interfaces/config/appConfig.js');

    // 1024 é o valor em que o disjuntor ficou invisível sob a maior carga
    // medida (400 VUs): zero recusas e vazão igual à sem teto. Abaixar disso
    // custa até 50% da vazão do `/refresh` para economizar ~13% de memória —
    // ver `docs/metricas.md` §5. O número está aqui para travar essa escolha,
    // porque "256 parece mais seguro" é exatamente o tipo de intuição que a
    // medição desmontou.
    expect(serverConfig.inFlight.max).toBe(1024);
  });

  it('MAX_IN_FLIGHT_REQUESTS tem precedência sobre o default', async() => {
    process.env.MAX_IN_FLIGHT_REQUESTS = '77';

    const { serverConfig } = await import('../../src/interfaces/config/appConfig.js');

    expect(serverConfig.inFlight.max).toBe(77);
  });

  it('/health, /readiness e /observability estão na lista de bypass', async() => {
    const { serverConfig } = await import('../../src/interfaces/config/appConfig.js');

    expect(serverConfig.inFlight.bypassPaths).toEqual(
      expect.arrayContaining(['/health', '/readiness', '/observability'])
    );
  });
});

describe('inFlightLimit - disjuntor de requisições em andamento', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('admit requisições até o teto e recusa a seguinte com 503', async() => {
    const { inFlightLimit } = await loadLimiter();
    const held: ResponseLike[] = [];

    for (let i = 0; i < MAX; i++) {
      const res = makeRes();
      const seen = capture();
      inFlightLimit(makeReq(), res, seen.next);
      expect(seen.errors).toHaveLength(0);
      held.push(res);
    }

    const res = makeRes();
    const seen = capture();
    inFlightLimit(makeReq(), res, seen.next);

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toMatchObject({ statusCode: 503, code: 'OVERLOADED' });
    expect(res.headers['Retry-After']).toBe('1');
  });

  it('liberar uma requisição reabre uma vaga', async() => {
    const { inFlightLimit } = await loadLimiter();
    const held: ResponseLike[] = [];

    for (let i = 0; i < MAX; i++) {
      const res = makeRes();
      inFlightLimit(makeReq(), res, jest.fn() as NextFunction);
      held.push(res);
    }

    const refused = capture();
    inFlightLimit(makeReq(), makeRes(), refused.next);
    expect(refused.errors).toHaveLength(1);

    held[0].emit('finish');

    const admitted = capture();
    inFlightLimit(makeReq(), makeRes(), admitted.next);
    expect(admitted.errors).toHaveLength(0);
  });

  it('liberar duas vezes no mesmo ciclo não devolve vaga dobrada', async() => {
    const { inFlightLimit, inFlightSnapshot } = await loadLimiter();
    const held: ResponseLike[] = [];

    // Enche até o teto: só assim a vaga fantasma tem onde aparecer.
    for (let i = 0; i < MAX; i++) {
      const res = makeRes();
      inFlightLimit(makeReq(), res, jest.fn() as NextFunction);
      held.push(res);
    }

    // `close` e `finish` podem vir os dois para a mesma resposta: o `finish`
    // dispara e o socket fecha logo depois. Sem a trava, esta resposta
    // devolveria DUAS vagas e o limite passaria a admitir MAX+1 requisições
    // — o vazamento silencioso que faz o limite parecer funcionar.
    held[0].emit('finish');
    held[0].emit('close');

    expect(inFlightSnapshot().current).toBe(MAX - 1);

    // Uma vaga liberada, uma vaga disponível: a segunda tem de ser recusada.
    const first = capture();
    inFlightLimit(makeReq(), makeRes(), first.next);
    expect(first.errors).toHaveLength(0);

    const second = capture();
    inFlightLimit(makeReq(), makeRes(), second.next);
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0]).toMatchObject({ code: 'OVERLOADED' });
  });

  it('NUNCA recusa /health, /readiness nem /observability, nem saturado', async() => {
    const { inFlightLimit } = await loadLimiter();

    for (const path of ['/health', '/readiness', '/observability', '/api-docs']) {
      const seen = capture();
      inFlightLimit(makeReq(path), makeRes(), seen.next);
      expect(seen.errors).toHaveLength(0);
    }
  });

  it('bypass não ocupa nem devolve vaga: saturar de /health não bloqueia /login', async() => {
    const { inFlightLimit } = await loadLimiter();

    for (let i = 0; i < MAX * 3; i++) {
      const res = makeRes();
      inFlightLimit(makeReq('/health'), res, jest.fn() as NextFunction);
    }

    const admitted = capture();
    inFlightLimit(makeReq('/login'), makeRes(), admitted.next);
    expect(admitted.errors).toHaveLength(0);
  });

  it('ignora query string ao decidir o bypass', async() => {
    const { inFlightLimit } = await loadLimiter();
    for (let i = 0; i < MAX; i++) {
      inFlightLimit(makeReq(), makeRes(), jest.fn() as NextFunction);
    }

    const seen = capture();
    inFlightLimit(
      { path: '', url: '/health?verbose=1' } as unknown as Request,
      makeRes(),
      seen.next
    );
    expect(seen.errors).toHaveLength(0);
  });

  it('contabiliza aceitas, recusadas e marca de água para diagnóstico', async() => {
    const { inFlightLimit, inFlightSnapshot } = await loadLimiter();

    for (let i = 0; i < MAX; i++) {
      inFlightLimit(makeReq(), makeRes(), jest.fn() as NextFunction);
    }
    for (let i = 0; i < 2; i++) {
      inFlightLimit(makeReq(), makeRes(), jest.fn() as NextFunction);
    }

    expect(inFlightSnapshot()).toMatchObject({
      current: MAX,
      limit: MAX,
      high_water_mark: MAX,
      accepted: MAX,
      rejected: 2
    });
  });

  it('teto zero ou negativo desliga o limite em vez de recusar tudo', async() => {
    const { inFlightLimit, inFlightSnapshot } = await loadLimiter(0);

    const seen = capture();
    for (let i = 0; i < 10; i++) {
      inFlightLimit(makeReq(), makeRes(), seen.next);
    }

    expect(seen.errors).toHaveLength(0);
    expect(inFlightSnapshot().current).toBe(0);
  });
});
