import { describe, it, expect, jest } from '@jest/globals';

describe('helmet security configuration', () => {
  it('applies helmet with strong security directives and extra headers', async() => {
    const helmetMiddleware = jest.fn((_req, _res, next) => next());
    const helmetMock = jest.fn(() => helmetMiddleware);

    jest.resetModules();
    await jest.unstable_mockModule('helmet', () => ({ default: helmetMock }));

    const setupSecurity = (await import('../../src/interfaces/config/helmet.js')).default;

    const setHeader = jest.fn();
    const res = { setHeader };
    const next = jest.fn();
    const app = { use: jest.fn() };

    setupSecurity(app);

    expect(helmetMock).toHaveBeenCalledTimes(1);
    const helmetOptions = helmetMock.mock.calls[0][0];
    expect(helmetOptions.contentSecurityPolicy.directives.objectSrc).toEqual(['\'none\'']);
    expect(helmetOptions.contentSecurityPolicy.directives.frameSrc).toEqual(['\'none\'']);
    expect(helmetOptions.hsts.maxAge).toBe(31536000);
    expect(helmetOptions.hsts.preload).toBe(true);

    expect(app.use).toHaveBeenCalledTimes(2);

    const headerMiddleware = app.use.mock.calls[1][0];
    headerMiddleware({}, res, next);

    const headerNames = setHeader.mock.calls.map(call => call[0]);
    expect(headerNames).toEqual(expect.arrayContaining([
      'X-Content-Type-Options',
      'X-Frame-Options',
      'X-XSS-Protection',
      'Referrer-Policy',
      'Permissions-Policy'
    ]));
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
