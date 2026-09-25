import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [requestLoggerImport, metricsImport] = await (async() => {
  const metrics = await import('../../src/shared/utils/metrics.js');
  const logger = await import('../../src/application/middleware/requestLogger.js');
  return [logger, metrics];
})();

const { requestLogger } = requestLoggerImport;
const { metricsMiddleware, httpRequestTotal, httpRequestDuration } = metricsImport;
const { requestLogAggregator } = await import('../../src/application/observability/requestLogAggregator.js');

describe('requestLogger - middleware de log de requisições', () => {
  it('define X-Request-Id, loga método/path/status/duration no finish e alimenta o agregador', () => {
    requestLogAggregator.reset();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const setHeader = jest.fn();
    let finishHandler: () => void = () => {};
    const req = { method: 'POST', path: '/login', route: null, get: () => undefined };
    const res = {
      setHeader,
      statusCode: 201,
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const next = jest.fn();

    requestLogger(req as never, res as never, next);

    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
    expect(next).toHaveBeenCalledTimes(1);
    expect(finishHandler).not.toBe(undefined);

    finishHandler();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('POST /login'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('201'));
    expect(requestLogAggregator.getSnapshot().total).toBe(1);
    expect(requestLogAggregator.getSnapshot().by_status['201']).toBe(1);

    logSpy.mockRestore();
  });
});

describe('metricsMiddleware - métricas Prometheus', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('registra duração e contagem quando a resposta termina', () => {
    let finishHandler: () => void = () => {};
    const res = {
      statusCode: 200,
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = { method: 'GET', path: '/health', route: null };
    const next = jest.fn();

    metricsMiddleware(req as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));

    finishHandler();

    expect(httpRequestTotal.name).toBe('http_requests_total');
    expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
  });

  it('sobrevive a erros ao coletar métricas', () => {
    let finishHandler: () => void = () => {};
    const res = {
      get statusCode() {
        throw new Error('status not available');
      },
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = { method: 'GET', path: '/health', route: null };
    const next = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    metricsMiddleware(req as never, res as never, next);
    finishHandler();

    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
