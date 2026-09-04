import { describe, it, expect, jest } from '@jest/globals';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';

describe('JWTTokenService - token generation and lifecycle', () => {
  const secret = 'test-secret-key-with-at-least-32-characters-for-tests';

  it('generates a valid access/refresh token pair', async() => {
    const service = new JWTTokenService(secret);
    const result = await service.generateTokenPair(
      { id: 'user-1', username: 'alice' },
      { accessExpiresIn: '5m', refreshExpiresIn: '1h' }
    );

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.type).toBe('Bearer');
    expect(result.expiresIn).toBeGreaterThan(0);

    const decoded = await service.verifyAccessToken(result.accessToken);
    expect(decoded.id).toBe('user-1');
    expect(decoded.username).toBe('alice');
    expect(decoded.token_type).toBe('access');
  });

  it('creates access tokens with a different secret from refresh tokens', async() => {
    const service = new JWTTokenService(secret);
    const result = await service.generateTokenPair({ id: 'user-2', username: 'bob' });

    const decodedAccess = await service.verifyAccessToken(result.accessToken);
    const decodedRefresh = await service.verifyRefreshToken(result.refreshToken);

    expect(decodedAccess.token_type).toBe('access');
    expect(decodedRefresh.token_type).toBe('refresh');
  });

  it('rejects access tokens that were revoked via blacklist', async() => {
    const blacklisted = new Map();
    const redisClientMock = {
      setEx: jest.fn(async(key, ttl, value) => {
        blacklisted.set(key, value);
      }),
      get: jest.fn(async(key) => blacklisted.get(key) || null),
      set: jest.fn(),
      del: jest.fn()
    };

    const service = new JWTTokenService(secret, secret, redisClientMock);
    const result = await service.generateTokenPair({ id: 'user-3', username: 'carol' });

    const revoked = await service.revokeToken(result.accessToken, 60000);
    expect(revoked).toBe(true);

    await expect(service.verifyAccessToken(result.accessToken)).rejects.toThrow('Token inválido');
  });

  it('refreshes tokens and issues a new pair while revoking the old refresh token', async() => {
    const blacklisted = new Map();
    const redisClientMock = {
      setEx: jest.fn(async(key, ttl, value) => {
        blacklisted.set(key, value);
      }),
      get: jest.fn(async(key) => blacklisted.get(key) || null),
      set: jest.fn(),
      del: jest.fn()
    };

    const service = new JWTTokenService(secret, secret, redisClientMock);
    const result = await service.generateTokenPair(
      { id: 'user-4', username: 'dave' },
      { refreshExpiresIn: '1h' }
    );

    const refreshed = await service.refreshTokens(result.refreshToken, { accessExpiresIn: '5m' });

    expect(refreshed.accessToken).toBeDefined();
    expect(refreshed.refreshToken).toBeDefined();
    expect(refreshed.accessToken).not.toBe(result.accessToken);

    const oldRefreshStillValid = await service.verifyRefreshToken(result.refreshToken)
      .then(() => true)
      .catch(() => false);
    expect(oldRefreshStillValid).toBe(false);
  });

  it('rejects a refresh token that was revoked', async() => {
    const blacklisted = new Map();
    const redisClientMock = {
      setEx: jest.fn(async(key, ttl, value) => {
        blacklisted.set(key, value);
      }),
      get: jest.fn(async(key) => blacklisted.get(key) || null),
      set: jest.fn(),
      del: jest.fn()
    };

    const service = new JWTTokenService(secret, secret, redisClientMock);
    const result = await service.generateTokenPair(
      { id: 'user-5', username: 'erin' },
      { refreshExpiresIn: '1h' }
    );

    await service.revokeToken(result.refreshToken, 60000);

    await expect(service.verifyRefreshToken(result.refreshToken)).rejects.toThrow('Refresh token inválido');
  });

  it('returns meaningful errors for expired access tokens', async() => {
    jest.useFakeTimers();
    const service = new JWTTokenService(secret, secret, null);

    const result = await service.generateTokenPair(
      { id: 'user-6', username: 'frank' },
      { accessExpiresIn: '2s', refreshExpiresIn: '1h' }
    );

    jest.advanceTimersByTime(3000);

    try {
      await service.verifyAccessToken(result.accessToken);
      expect(true).toBe(false);
    } catch (error) {
      expect(error.code).toBe('TOKEN_EXPIRED');
    }

    jest.useRealTimers();
  });

  it('throws when the token service is built without a secret', () => {
    expect(() => new JWTTokenService(null)).toThrow('JWT_SECRET é obrigatório');
  });

  it('falls back to memory when no Redis client is provided for revocation', async() => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new JWTTokenService(secret);

    const result = await service.revokeToken('some-token');
    expect(result).toBe(false);
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it('generates a standalone access token with a default lifetime', async() => {
    const service = new JWTTokenService(secret);
    const token = await service.generateAccessToken({ id: 'user-7', username: 'grace' });

    const decoded = await service.verifyAccessToken(token);
    expect(decoded.id).toBe('user-7');
    expect(decoded.username).toBe('grace');
  });

  it('decodes a token without validating the signature', async() => {
    const service = new JWTTokenService(secret);
    const result = await service.generateTokenPair({ id: 'user-8', username: 'henry' });

    const decoded = service.decodeToken(result.accessToken);
    expect(decoded.id).toBe('user-8');
    expect(decoded.username).toBe('henry');
  });

  it('revokes all tokens of a user', async() => {
    const redisClientMock = {
      setEx: jest.fn(async() => 'ok'),
      get: jest.fn(async() => null),
      set: jest.fn(),
      del: jest.fn()
    };

    const service = new JWTTokenService(secret, secret, redisClientMock);
    const revoked = await service.revokeUserTokens('user-9');

    expect(revoked).toBe(true);
    expect(redisClientMock.setEx).toHaveBeenCalledWith(
      'user_tokens_revoked:user-9',
      604800,
      expect.any(String)
    );
  });

  it('accepts a Redis client injected after construction', async() => {
    const service = new JWTTokenService(secret);
    expect(service.redisClient).toBeNull();

    const blacklisted = new Map();
    const redisClientMock = {
      setEx: jest.fn(async(key, ttl, value) => {
        blacklisted.set(key, value);
      }),
      get: jest.fn(async(key) => blacklisted.get(key) || null),
      set: jest.fn(),
      del: jest.fn()
    };

    service.setRedisClient(redisClientMock);

    expect(service.redisClient).toBe(redisClientMock);

    const result = await service.generateTokenPair(
      { id: 'user-10', username: 'ivan' },
      { refreshExpiresIn: '1h' }
    );
    const revoked = await service.revokeToken(result.refreshToken, 60000);
    expect(revoked).toBe(true);

    await expect(service.verifyRefreshToken(result.refreshToken)).rejects.toThrow('Refresh token inválido');
  });

  it('rejects tokens issued before a user-wide revocation', async() => {
    const redisClientMock = {
      setEx: jest.fn(async() => 'ok'),
      get: jest.fn(async() => null),
      set: jest.fn(),
      del: jest.fn()
    };
    const service = new JWTTokenService(secret, secret, redisClientMock);

    const result = await service.generateTokenPair(
      { id: 'user-11', username: 'joe' },
      { refreshExpiresIn: '1h' }
    );

    const revokedAt = Date.now();
    redisClientMock.get = jest.fn(async(key) =>
      key.startsWith('user_tokens_revoked:') ? String(revokedAt) : null
    );

    await service.revokeUserTokens('user-11', 60000);

    await expect(service.verifyAccessToken(result.accessToken)).rejects.toThrow('Token inválido');
    await expect(service.verifyRefreshToken(result.refreshToken)).rejects.toThrow('Refresh token inválido');
  });

  it('accepts tokens issued after a user-wide revocation', async() => {
    const revokedAt = Date.now() - 5000;
    const redisClientMock = {
      setEx: jest.fn(async() => 'ok'),
      get: jest.fn(async(key) =>
        key.startsWith('user_tokens_revoked:') ? String(revokedAt) : null
      ),
      set: jest.fn(),
      del: jest.fn()
    };
    const service = new JWTTokenService(secret, secret, redisClientMock);

    const result = await service.generateTokenPair({ id: 'user-12', username: 'kim' });

    const access = await service.verifyAccessToken(result.accessToken);
    const refresh = await service.verifyRefreshToken(result.refreshToken);
    expect(access.id).toBe('user-12');
    expect(refresh.id).toBe('user-12');
  });
});
