import { describe, it, expect, jest } from '@jest/globals';
import { AuthWebMiddleware } from '../../src/application/middleware/AuthMiddleware.js';
import { HttpError } from '../../src/shared/utils/errorHandler.js';

const makeMiddleware = (tokenAdapter: Record<string, any>, userRepository: Record<string, any>, logger: Record<string, any>) =>
  new AuthWebMiddleware(tokenAdapter as never, userRepository as never, logger as never);

describe('AuthWebMiddleware - authenticate obrigatório', () => {
  it('responde 401 quando não há header de autorização', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn() },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: {} };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('TOKEN_REQUIRED');
  });

  it('aceita token sem prefixo Bearer', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { findById: jest.fn().mockResolvedValue({ id: 'u-1' }) },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'raw-token' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('anexa o usuário à requisição quando o token é válido', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { findById: jest.fn().mockResolvedValue({ id: 'u-1' }) },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer valid-token' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
    expect(next.mock.calls).toHaveLength(1);
  });

  it('responde 401 quando o token está expirado', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockRejectedValue(Object.assign(new Error('token expirado'), { code: 'TOKEN_EXPIRED' })) },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer expired' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  it('responde 401 quando o token é inválido', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'TOKEN_INVALID' })) },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer bad-token' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('TOKEN_INVALID');
  });

  it('responde 401 quando o usuário não existe mais', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'ghost', username: 'x' }) },
      { findById: jest.fn().mockResolvedValue(null) },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer token' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('USER_NOT_FOUND');
  });

  it('responde 500 quando o TokenService não implementa verifyAccessToken', async() => {
    const middleware = makeMiddleware(
      {},
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer token' } };
    const next = jest.fn();

    await middleware.authenticate(req, {} as never, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('TOKEN_SERVICE_ERROR');
  });
});

describe('AuthWebMiddleware - optionalAuth', () => {
  it('define user como null quando não há token', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn() },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: {} };
    const next = jest.fn();

    await middleware.optionalAuth(req, {} as never, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('anexa usuário quando recebe token válido', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }) },
      { findById: jest.fn().mockResolvedValue({ id: 'u-1' }) },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer valid' } };
    const next = jest.fn();

    await middleware.optionalAuth(req, {} as never, next);

    expect(req.user).toEqual({ id: 'u-1', username: 'alice' });
  });

  it('mantém user null quando o token é inválido', async() => {
    const middleware = makeMiddleware(
      { verifyAccessToken: jest.fn().mockRejectedValue(new Error('bad')) },
      { findById: jest.fn() },
      { error: jest.fn() }
    );

    const req = { headers: { authorization: 'Bearer bad' } };
    const next = jest.fn();

    await middleware.optionalAuth(req, {} as never, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
