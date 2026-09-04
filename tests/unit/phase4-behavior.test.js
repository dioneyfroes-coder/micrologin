import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { AuthWebMiddleware } from '../../src/application/middleware/AuthMiddleware.js';
import { advancedRateLimit } from '../../src/application/middleware/advancedRateLimit.js';
import { securityMonitor } from '../../src/application/middleware/securityMonitoring.js';

describe('Phase 4 - authorization, rate limiting and security monitoring', () => {
  beforeEach(() => {
    securityMonitor.clearThreatLog();

    advancedRateLimit.config = {
      environment: 'development',
      exemptPaths: ['/health'],
      ip: { points: 1, duration: 60, blockDuration: 1 },
      user: { points: 2, duration: 60, blockDuration: 1 },
      login: { points: 1, duration: 60, blockDuration: 1 },
      redis: { keyPrefix: 'phase4_' }
    };

    advancedRateLimit.limiters = {
      ip: new RateLimiterMemory({ keyPrefix: 'phase4_ip_', points: 1, duration: 60, blockDuration: 1 }),
      user: new RateLimiterMemory({ keyPrefix: 'phase4_user_', points: 2, duration: 60, blockDuration: 1 }),
      login: new RateLimiterMemory({ keyPrefix: 'phase4_login_', points: 1, duration: 60, blockDuration: 1 })
    };
    advancedRateLimit.initialized = true;
    advancedRateLimit.redisClient = null;
  });

  it('rejects requests without a bearer token', async() => {
    const middleware = new AuthWebMiddleware(
      { verifyAccessToken: jest.fn() },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'TOKEN_REQUIRED',
      statusCode: 401
    }));
  });

  it('accepts a valid bearer token and attaches the authenticated user', async() => {
    const middleware = new AuthWebMiddleware(
      {
        verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' })
      },
      {
        findById: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' })
      },
      { error: jest.fn() }
    );

    const req = {
      headers: { authorization: 'Bearer valid-token' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks a second request from the same IP once the rate limit is exhausted', async() => {
    const req = {
      ip: '203.0.113.10',
      path: '/login',
      user: { id: 'user-1' },
      get: jest.fn().mockReturnValue('jest-agent')
    };
    const res = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    await advancedRateLimit.checkLimits(req, res, next);
    await advancedRateLimit.checkLimits(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED'
    }));
  });

  it('logs suspicious patterns without blocking the request', async() => {
    const req = {
      ip: '198.51.100.22',
      path: '/login',
      body: { payload: '<script>alert(1)</script>' },
      url: '/login',
      get: jest.fn().mockReturnValue('jest-agent')
    };
    const res = {};
    const next = jest.fn();

    securityMonitor.detectThreats(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(securityMonitor.getThreatReport().length).toBeGreaterThan(0);
  });
});
