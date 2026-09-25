import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { requireMetricsToken } from '../../src/application/middleware/metricsToken.js';
import { HttpError } from '../../src/shared/utils/errorHandler.js';

const setToken = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.METRICS_TOKEN;
  } else {
    process.env.METRICS_TOKEN = value;
  }
};

describe('requireMetricsToken', () => {
  const original = process.env.METRICS_TOKEN;

  afterEach(() => setToken(original));

  it('passa sem exigir token quando METRICS_TOKEN não está configurado', () => {
    setToken(undefined);
    const next = jest.fn();
    const req = { get: () => undefined };

    requireMetricsToken(req as never, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('passa com header exato quando token existe', () => {
    setToken('sekret-1');
    const next = jest.fn();
    const req = { get: (name: string) => (name === 'x-metrics-token' ? 'sekret-1' : undefined) };

    requireMetricsToken(req as never, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejeita com 401 METRICS_FORBIDDEN quando o header diverge', () => {
    setToken('sekret-1');
    const next = jest.fn();
    const req = { get: () => 'wrong' };

    requireMetricsToken(req as never, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(401);
    expect((err as HttpError).code).toBe('METRICS_FORBIDDEN');
  });

  it('rejeita 401 quando o header está ausente', () => {
    setToken('sekret-1');
    const next = jest.fn();
    const req = { get: () => undefined };

    requireMetricsToken(req as never, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as HttpError).statusCode).toBe(401);
  });
});
