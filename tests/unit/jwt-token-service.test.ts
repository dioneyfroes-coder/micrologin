import { describe, it, expect, jest } from '@jest/globals';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';

const SECRET = 'test-secret-key-with-at-least-32-characters-for-tests';

const makeRedisClient = () => {
  const store = new Map<string, string>();
  return {
    setEx: jest.fn(async(key: string, ttl: number, value: string) => {
      store.set(key, value);
    }),
    get: jest.fn(async(key: string) => store.get(key) ?? null)
  };
};

describe('JWTTokenService - geração e verificação', () => {
  it('gera par válido de access/refresh tokens e verifica o access token', async() => {
    const service = new JWTTokenService(SECRET);
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

  it('usa secrets distintos para access e refresh', async() => {
    const service = new JWTTokenService(SECRET, 'different-refresh-secret-32-characters!!');
    const result = await service.generateTokenPair({ id: 'user-2', username: 'bob' });

    const decodedAccess = await service.verifyAccessToken(result.accessToken);
    const decodedRefresh = await service.verifyRefreshToken(result.refreshToken);

    expect(decodedAccess.token_type).toBe('access');
    expect(decodedRefresh.token_type).toBe('refresh');
  });

  it('lança erro quando o secret é ausente', () => {
    expect(() => new JWTTokenService('')).toThrow('JWT_SECRET é obrigatório');
  });

  it('aplica issuer e audience personalizados', async() => {
    const service = new JWTTokenService(SECRET, null, null, 'custom-issuer', 'custom-audience');
    const result = await service.generateTokenPair({ id: 'user-3', username: 'carol' });

    const payload = service.decodeToken(result.accessToken) as { iss?: string; aud?: string };
    expect(payload.iss).toBe('custom-issuer');
    expect(payload.aud).toBe('custom-audience');
  });

  it('rejeita access token assinado com outro secret', async() => {
    const service = new JWTTokenService(SECRET);
    const result = await service.generateTokenPair({ id: 'user-4', username: 'dave' });

    const other = new JWTTokenService('outro-secret-com-pelo-menos-32-caracteres!!!');
    await expect(other.verifyAccessToken(result.accessToken)).rejects.toThrow('Token inválido');
  });
});

describe('JWTTokenService - revogação e blacklist', () => {
  it('rejeita access token revogado via blacklist', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const result = await service.generateTokenPair({ id: 'user-5', username: 'erin' });

    const revoked = await service.revokeToken(result.accessToken, 60000);
    expect(revoked).toBe(true);

    await expect(service.verifyAccessToken(result.accessToken)).rejects.toThrow('Token inválido');
  });

  it('rejeita refresh token revogado via blacklist', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const result = await service.generateTokenPair({ id: 'user-6', username: 'frank' });

    await service.revokeToken(result.refreshToken, 60000);

    await expect(service.verifyRefreshToken(result.refreshToken)).rejects.toThrow('Refresh token inválido');
  });

  it('revoga todos os tokens do usuário (tokens emitidos antes da revogação)', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const result = await service.generateTokenPair({ id: 'user-7', username: 'grace' }, { refreshExpiresIn: '1d' });

    await service.revokeUserTokens('user-7');

    await expect(service.verifyAccessToken(result.accessToken)).rejects.toThrow('Token foi revogado');
  });

  it('retorna false para revogação sem Redis disponível', async() => {
    const service = new JWTTokenService(SECRET);
    expect(await service.revokeToken('token')).toBe(false);
    expect(await service.revokeUserTokens('user')).toBe(false);
  });
});

describe('JWTTokenService - rotação de refresh token', () => {
  it('emite novo par e revoga o refresh token antigo', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const result = await service.generateTokenPair(
      { id: 'user-8', username: 'heidi' },
      { refreshExpiresIn: '1h' }
    );

    const refreshed = await service.refreshTokens(result.refreshToken, { accessExpiresIn: '5m' });

    expect(refreshed.accessToken).toBeDefined();
    expect(refreshed.refreshToken).toBeDefined();
    expect(refreshed.accessToken).not.toBe(result.accessToken);

    await expect(service.verifyRefreshToken(result.refreshToken)).rejects.toThrow('Refresh token inválido');
  });

  it('rejeita refresh token inválido', async() => {
    const service = new JWTTokenService(SECRET);
    await expect(service.refreshTokens('not-a-token', {})).rejects.toThrow('Refresh token inválido');
  });
});

describe('JWTTokenService - decode e access token isolado', () => {
  it('gera apenas access token sem refresh', async() => {
    const service = new JWTTokenService(SECRET);
    const access = await service.generateAccessToken({ id: 'user-9', username: 'ivan' });

    const decoded = await service.verifyAccessToken(access);
    expect(decoded.id).toBe('user-9');
    expect(decoded.token_type).toBe('access');
  });

  it('decodifica token sem validar assinatura', async() => {
    const service = new JWTTokenService(SECRET);
    const result = await service.generateTokenPair({ id: 'user-10', username: 'judy' });

    const payload = service.decodeToken(result.accessToken) as { id: string };
    expect(payload.id).toBe('user-10');
  });

  it('propaga erro TOKEN_EXPIRED para access token', async() => {
    const service = new JWTTokenService(SECRET);
    const expired = await service.generateAccessToken({ id: 'user-11', username: 'karl' }, '1ms');
    await new Promise(resolve => setTimeout(resolve, 30));

    try {
      await service.verifyAccessToken(expired);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('TOKEN_EXPIRED');
    }
  });
});
