import { describe, it, expect, jest } from '@jest/globals';
import { AuthWebMiddleware } from '../../src/application/middleware/AuthMiddleware.js';

describe('AuthWebMiddleware - optional and edge cases', () => {
  const makeMiddleware = (tokenAdapter, userRepository, logger) =>
    new AuthWebMiddleware(tokenAdapter, userRepository, logger);

  it('sets user to null when optionalAuth has no token', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn() },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: {} };
    const res = {};
    const next = jest.fn();

    await middleware.optionalAuth(req, res, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('attaches a user when optionalAuth receives a valid token', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { findById: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { error: jest.fn() }
    );

    const req = {
      headers: { authorization: 'Bearer valid-token' }
    };
    const res = {};
    const next = jest.fn();

    await middleware.optionalAuth(req, res, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
  });

  it('sets user to null when optionalAuth receives an invalid token', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockRejectedValue(new Error('bad token')) },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = {
      headers: { authorization: 'Bearer bad-token' }
    };
    const res = {};
    const next = jest.fn();

    await middleware.optionalAuth(req, res, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a token without the Bearer prefix', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { findById: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { error: jest.fn() }
    );

    const req = {
      headers: { authorization: 'raw-token' }
    };
    const res = {};
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns TOKEN_EXPIRED when the token has expired', async() => {
    const tokenError = new Error('Access token expirado');
    tokenError.code = 'TOKEN_EXPIRED';
    tokenError.name = 'TokenExpiredError';

    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockRejectedValue(tokenError) },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = {
      headers: { authorization: 'Bearer expired-token' }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'TOKEN_EXPIRED',
      statusCode: 401
    }));
  });

  it('returns USER_NOT_FOUND when the user was deleted', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-deleted', username: 'ghost' }) },
      { findById: jest.fn().mockResolvedValue(null) },
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

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'USER_NOT_FOUND',
      statusCode: 401
    }));
  });
});
