import { describe, it, expect, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';

const SECRET = 'test-secret-key-with-at-least-32-characters-for-tests';

const makeRedisClient = () => {
  const store = new Map<string, string>();
  return {
    store,
    setEx: jest.fn(async(key: string, ttl: number, value: string) => {
      store.set(key, value);
    }),
    set: jest.fn(async(key: string, value: string, options?: { NX?: boolean; EX?: number }) => {
      if (options?.NX && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async(key: string) => store.get(key) ?? null)
  };
};

const makeBrokenRedisClient = () => ({
  setEx: jest.fn(async() => {
    throw new Error('connection lost');
  }),
  set: jest.fn(async() => {
    throw new Error('connection lost');
  }),
  get: jest.fn(async() => {
    throw new Error('connection lost');
  })
});

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

describe('JWTTokenService - blacklist keyed by jti', () => {
  it('uses o jti como chave e nunca o token completo', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const { accessToken } = await service.generateTokenPair({ id: 'user-30', username: 'ana' });

    await service.revokeToken(accessToken, 60000);

    expect(redis.setEx).toHaveBeenCalledTimes(1);
    const [key] = redis.setEx.mock.calls[0] as [string, number, string];
    expect(key).toMatch(/^token_blacklist:jti:[0-9a-f-]{36}$/);
    expect(key).not.toContain(accessToken);
  });

  it('access e refresh recebem jti próprios (revogar um não derruba o outro)', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const pair = await service.generateTokenPair({ id: 'user-31', username: 'bruno' });

    const accessJti = (service.decodeToken(pair.accessToken) as { jti: string }).jti;
    const refreshJti = (service.decodeToken(pair.refreshToken) as { jti: string }).jti;
    expect(accessJti).toBeTruthy();
    expect(refreshJti).toBeTruthy();
    expect(accessJti).not.toBe(refreshJti);

    await service.revokeToken(pair.refreshToken, 60000);

    // O access da mesma emissão continua válido
    const decoded = await service.verifyAccessToken(pair.accessToken);
    expect(decoded.id).toBe('user-31');
  });

  it('fallback para hash sha256 em token sem jti, sem expor o token', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const legacyToken = jwt.sign({ id: 'user-32', username: 'carla', token_type: 'access' }, SECRET, {
      expiresIn: '1h',
      issuer: 'auth-service',
      audience: 'api-users'
    });

    await service.revokeToken(legacyToken, 60000);

    const [key] = redis.setEx.mock.calls[0] as [string, number, string];
    expect(key).toMatch(/^token_blacklist:sha256:[0-9a-f]{64}$/);
    expect(key).not.toContain(legacyToken);
    await expect(service.verifyAccessToken(legacyToken)).rejects.toThrow('Token inválido');
  });

  it('honra blacklist legada (token completo) para tokens sem jti', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const legacyToken = jwt.sign({ id: 'user-33', username: 'dani', token_type: 'access' }, SECRET, {
      expiresIn: '1h',
      issuer: 'auth-service',
      audience: 'api-users'
    });

    // Simula o formato gravado por uma versão anterior do serviço
    redis.store.set(`token_blacklist:${legacyToken}`, 'true');

    await expect(service.verifyAccessToken(legacyToken)).rejects.toThrow('Token inválido');
  });

  it('o TTL da blacklist acompanha a expiração natural do token', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const { accessToken } = await service.generateTokenPair(
      { id: 'user-34', username: 'eva' },
      { accessExpiresIn: '10m' }
    );

    await service.revokeToken(accessToken, 3600000);

    const [, ttl] = redis.setEx.mock.calls[0] as [string, number, string];
    expect(ttl).toBeGreaterThan(540);
    expect(ttl).toBeLessThanOrEqual(600);
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

  it('consome o refresh token atomicamente: uma requisição por token', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const { refreshToken } = await service.generateTokenPair(
      { id: 'user-40', username: 'hugo' },
      { refreshExpiresIn: '1h' }
    );

    const [first, second] = await Promise.allSettled([
      service.refreshTokens(refreshToken),
      service.refreshTokens(refreshToken)
    ]);

    const succeeded = [first, second].filter(r => r.status === 'fulfilled');
    const failed = [first, second].filter(r => r.status === 'rejected');

    // SET NX decide o vencedor: só uma rotação pode acontecer.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'REFRESH_TOKEN_REUSED'
    });

    // O perdedor não pode ter ganhado um par de tokens
    const winner = (succeeded[0] as PromiseFulfilledResult<{ accessToken: string }>).value;
    expect(winner.accessToken).toBeTruthy();
  });

  it('o marcador de rotação usa SET NX com o TTL restante do token', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const { refreshToken } = await service.generateTokenPair(
      { id: 'user-41', username: 'iris' },
      { refreshExpiresIn: '1h' }
    );

    await service.refreshTokens(refreshToken);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, options] = redis.set.mock.calls[0] as [string, string, { NX?: boolean; EX?: number }];
    expect(key).toMatch(/^token_blacklist:jti:/);
    expect(value).toBe('rotated');
    expect(options.NX).toBe(true);
    expect(options.EX).toBeGreaterThan(3500);
    expect(options.EX).toBeLessThanOrEqual(3600);
  });

  it('refresh token já revogado por logout falha como inválido, não como reuso', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const { refreshToken } = await service.generateTokenPair(
      { id: 'user-42', username: 'jack' },
      { refreshExpiresIn: '1h' }
    );

    await service.revokeToken(refreshToken, 3600000);

    await expect(service.refreshTokens(refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_INVALID'
    });
  });

  it('o novo par de tokens não repete o jti do refresh consumido', async() => {
    const redis = makeRedisClient();
    const service = new JWTTokenService(SECRET, SECRET, redis as never);
    const first = await service.generateTokenPair({ id: 'user-43', username: 'kate' }, { refreshExpiresIn: '1h' });

    const rotated = await service.refreshTokens(first.refreshToken, { refreshExpiresIn: '1h' });

    const oldJti = (service.decodeToken(first.refreshToken) as { jti: string }).jti;
    const newJti = (service.decodeToken(rotated.refreshToken) as { jti: string }).jti;
    expect(newJti).not.toBe(oldJti);
    expect(await service.isTokenBlacklisted(rotated.refreshToken)).toBe(false);
  });

  it('fail-open: rotação degrada quando o armazenamento está fora do ar', async() => {
    const service = new JWTTokenService(
      SECRET,
      SECRET,
      makeBrokenRedisClient() as never,
      'auth-service',
      'api-users',
      { failOpen: true }
    );
    const { refreshToken } = await service.generateTokenPair({ id: 'user-44', username: 'lara' });

    const rotated = await service.refreshTokens(refreshToken);
    expect(rotated.accessToken).toBeTruthy();
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

describe('JWTTokenService - política de revogação (fail-closed vs fail-open)', () => {
  const failClosed = (redis: unknown) =>
    new JWTTokenService(SECRET, SECRET, redis as never, 'auth-service', 'api-users', { failOpen: false });

  it('fail-closed: nega verificação de access token sem armazenamento de revogação', async() => {
    const service = failClosed(null);
    const { accessToken } = await service.generateTokenPair({ id: 'user-20', username: 'nina' });

    await expect(service.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-closed: nega verificação de refresh token sem armazenamento de revogação', async() => {
    const service = failClosed(null);
    const { refreshToken } = await service.generateTokenPair({ id: 'user-21', username: 'olivia' });

    await expect(service.verifyRefreshToken(refreshToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-closed: nega revogação (logout) em vez de fingir sucesso', async() => {
    const service = failClosed(null);

    await expect(service.revokeToken('token')).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
    await expect(service.revokeUserTokens('user-22')).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-closed: nega quando o cliente Redis está desconectado', async() => {
    const disconnected = { ...makeRedisClient(), isReady: false };
    const service = failClosed(disconnected);
    const { accessToken } = await service.generateTokenPair({ id: 'user-23', username: 'pedro' });

    await expect(service.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-closed: nega quando o armazenamento responde com erro', async() => {
    const service = failClosed(makeBrokenRedisClient());
    const { accessToken } = await service.generateTokenPair({ id: 'user-24', username: 'rita' });

    await expect(service.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
    await expect(service.revokeToken(accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-closed: nega refresh (rotação) sem armazenamento de revogação', async() => {
    const service = failClosed(null);
    const { refreshToken } = await service.generateTokenPair({ id: 'user-25', username: 'sergio' });

    await expect(service.refreshTokens(refreshToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });

  it('fail-open: mantém o comportamento degradado (token sem revogação é aceito)', async() => {
    const service = new JWTTokenService(SECRET, SECRET, null, 'auth-service', 'api-users', { failOpen: true });
    const { accessToken } = await service.generateTokenPair({ id: 'user-26', username: 'tania' });

    const decoded = await service.verifyAccessToken(accessToken);
    expect(decoded.id).toBe('user-26');
    expect(await service.revokeToken(accessToken)).toBe(false);
  });

  it('fail-open: degrada para false quando o armazenamento responde com erro', async() => {
    const service = new JWTTokenService(SECRET, SECRET, makeBrokenRedisClient() as never, 'auth-service', 'api-users', { failOpen: true });
    const { accessToken } = await service.generateTokenPair({ id: 'user-27', username: 'ugo' });

    const decoded = await service.verifyAccessToken(accessToken);
    expect(decoded.id).toBe('user-27');
    expect(await service.revokeToken(accessToken)).toBe(false);
    expect(await service.isTokenBlacklisted(accessToken)).toBe(false);
  });

  it('fail-closed: volta a aceitar tokens quando o armazenamento é reconectado', async() => {
    const redis = makeRedisClient();
    const service = failClosed(redis);
    const { accessToken } = await service.generateTokenPair({ id: 'user-28', username: 'val' });

    // Redis fora do ar
    service.setRedisClient({ ...redis, isReady: false } as never);
    await expect(service.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });

    // Redis de volta
    service.setRedisClient(redis as never);
    const decoded = await service.verifyAccessToken(accessToken);
    expect(decoded.id).toBe('user-28');
  });
});
