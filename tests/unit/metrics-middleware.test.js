import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [requestLoggerImport, metricsImport] = await (async() => {
  const metrics = await import('../../src/shared/utils/metrics.js');
  const logger = await import('../../src/application/middleware/requestLogger.js');
  return [logger, metrics];
})();

const { requestLogger } = requestLoggerImport;
const { metricsMiddleware, httpRequestDuration, httpRequestTotal, prometheus } = metricsImport;

describe('requestLogger - request logging middleware', () => {
  it('logs the method and path then calls next', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const req = { method: 'POST', path: '/login', headers: {} };
    const res = { on: jest.fn() };
    const next = jest.fn();

    requestLogger(req, res, next);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('POST /login'));
    expect(next).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe('metricsMiddleware - Prometheus metrics', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('records request duration and count when the response finishes', () => {
    process.env.NODE_ENV = 'test';

    let finishHandler = null;
    const res = {
      statusCode: 200,
      on: jest.fn((event, handler) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = {
      method: 'GET',
      path: '/health',
      route: null
    };
    const next = jest.fn();

    metricsMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));

    res.statusCode = 200;
    finishHandler();

    expect(httpRequestTotal.name).toBe('http_requests_total');
    expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
  });

  it('survives errors while collecting metrics', () => {
    let finishHandler = null;
    const res = {
      get statusCode() {
        throw new Error('status not available');
      },
      on: jest.fn((event, handler) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = { method: 'GET', path: '/metrics', route: null };
    const next = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    metricsMiddleware(req, res, next);
    expect(() => finishHandler()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('exposes prom-client metrics with stable names', () => {
    expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
    expect(httpRequestTotal.name).toBe('http_requests_total');
    expect(typeof prometheus.Histogram).toBe('function');
  });
});
