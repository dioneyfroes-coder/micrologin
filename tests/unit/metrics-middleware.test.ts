import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [requestLoggerImport, metricsImport] = await (async() => {
  const metrics = await import('../../src/shared/utils/metrics.js');
  const logger = await import('../../src/application/middleware/requestLogger.js');
  return [logger, metrics];
})();

const { requestLogger } = requestLoggerImport;
const { metricsMiddleware, httpRequestTotal, httpRequestDuration } = metricsImport;

describe('requestLogger - middleware de log de requisições', () => {
  it('loga método e path e chama next', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const req = { method: 'POST', path: '/login', headers: {} };
    const next = jest.fn();

    requestLogger(req as never, {} as never, next);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('POST /login'));
    expect(next).toHaveBeenCalledTimes(1);

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
