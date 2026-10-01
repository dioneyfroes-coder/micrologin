import { describe, expect, it, jest } from '@jest/globals';
import { AuthService, User } from '../../src/domain/index.js';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';

const SECRET = 'credential-theft-survival-test-secret-32-bytes';

const makeRedisClient = () => {
  const store = new Map<string, string>();
  return {
    store,
    setEx: jest.fn(async(key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    set: jest.fn(async(key: string, value: string, options?: { NX?: boolean; EX?: number }) => {
      if (options?.NX && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    }),
    incr: jest.fn(async(key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async() => true),
    get: jest.fn(async(key: string) => store.get(key) ?? null)
  };
};

const makeHarness = ({
  redisClient = makeRedisClient(),
  autoRevokeOnRefreshReuse = true
}: {
  redisClient?: ReturnType<typeof makeRedisClient>;
  autoRevokeOnRefreshReuse?: boolean;
} = {}) => {
  const tokenService = new JWTTokenService(
    SECRET,
    SECRET,
    redisClient as never,
    'auth-service',
    'api-users',
    { failOpen: false }
  );
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const authService = new AuthService({}, {}, tokenService, logger, autoRevokeOnRefreshReuse);
  return { authService, tokenService, redisClient, logger };
};

const makeUser = (id: string, username: string, hashedPassword: string) =>
  new User(id, username, hashedPassword, new Date('2025-01-01'), new Date('2025-01-01'));

describe('credential theft survival - servicos de sessao', () => {
  it('T1: reuso sequencial de refresh encerra as sessoes do usuario e exige novo login', async() => {
    const { authService, tokenService } = makeHarness();
    const legitimate = await tokenService.generateTokenPair({ id: 't1-user', username: 'legitimo' });
    const secondDevice = await tokenService.generateTokenPair({ id: 't1-user', username: 'legitimo' });

    const rotated = await authService.refreshUserTokens(legitimate.refreshToken);
    const replay = await authService.refreshUserTokens(legitimate.refreshToken);

    expect(replay).toMatchObject({ success: false, code: 'REFRESH_TOKEN_REUSED' });
    for (const accessToken of [legitimate.accessToken, secondDevice.accessToken, rotated.token!.accessToken]) {
      await expect(tokenService.verifyAccessToken(accessToken)).rejects.toMatchObject({
        code: 'TOKEN_INVALID'
      });
    }
    await expect(authService.refreshUserTokens(legitimate.refreshToken)).resolves.toMatchObject({
      success: false,
      code: 'REFRESH_TOKEN_INVALID'
    });
  });

  it('T2: troca de senha invalida access roubado e preserva a senha nova', async() => {
    const user = makeUser('t2-user', 'conta-t2', 'old-hash');
    const repository = {
      findById: jest.fn(async() => user),
      findByUsername: jest.fn(async() => user),
      save: jest.fn(async(value: User) => value)
    };
    const crypto = {
      compare: jest.fn(async(plain: string, hash: string) => (
        (plain === 'CurrentPass123!' && hash === 'old-hash') ||
        (plain === 'NewStrongPass456!' && hash === 'new-hash')
      )),
      hash: jest.fn(async() => 'new-hash')
    };
    const harness = makeHarness();
    const authService = new AuthService(repository, crypto, harness.tokenService, harness.logger);
    const stolen = await harness.tokenService.generateTokenPair({ id: user.id!, username: user.username });

    const changed = await authService.changePassword(user.id!, 'CurrentPass123!', 'NewStrongPass456!');

    expect(changed.success).toBe(true);
    expect(user.hashedPassword).toBe('new-hash');
    expect((await authService.authenticateUser(user.username, 'NewStrongPass456!')).success).toBe(true);
    await expect(harness.tokenService.verifyAccessToken(stolen.accessToken)).rejects.toMatchObject({
      code: 'TOKEN_INVALID'
    });
  });

  it('T3: refresh roubado apos logout permanece invalido', async() => {
    const { authService, tokenService } = makeHarness();
    const pair = await tokenService.generateTokenPair({ id: 't3-user', username: 'logout-t3' });

    const logout = await authService.endSession({ refreshToken: pair.refreshToken });
    const stolenReplay = await authService.refreshUserTokens(pair.refreshToken);

    expect(logout.success).toBe(true);
    expect(stolenReplay).toMatchObject({ success: false, code: 'REFRESH_TOKEN_INVALID' });
    await expect(tokenService.verifyAccessToken(pair.accessToken)).rejects.toMatchObject({
      code: 'TOKEN_INVALID'
    });
  });

  it('T4: disputa pelo mesmo refresh tem um vencedor, mas a deteccao derruba a sessao', async() => {
    const { authService, tokenService } = makeHarness();
    const original = await tokenService.generateTokenPair({ id: 't4-user', username: 'corrida-t4' });

    const results = await Promise.all([
      authService.refreshUserTokens(original.refreshToken),
      authService.refreshUserTokens(original.refreshToken)
    ]);
    const winners = results.filter(result => result.success);
    const reused = results.filter(result => result.code === 'REFRESH_TOKEN_REUSED');

    expect(winners).toHaveLength(1);
    expect(reused).toHaveLength(1);
    await expect(tokenService.verifyAccessToken(winners[0].token!.accessToken)).rejects.toMatchObject({
      code: 'TOKEN_INVALID'
    });
  });

  it('T5: senha compartilhada entre contas nao e detectavel pelo hash individual', async() => {
    const accounts = new Map([
      ['conta-a', makeUser('t5-a', 'conta-a', 'same-hash')],
      ['conta-b', makeUser('t5-b', 'conta-b', 'same-hash')]
    ]);
    const repository = {
      findByUsername: jest.fn(async(username: string) => accounts.get(username) ?? null)
    };
    const crypto = {
      compare: jest.fn(async(plain: string, hash: string) => plain === 'LeakedPass123!' && hash === 'same-hash')
    };
    const { tokenService, logger } = makeHarness();
    const authService = new AuthService(repository, crypto, tokenService, logger);

    const accountA = await authService.authenticateUser('conta-a', 'LeakedPass123!');
    const accountB = await authService.authenticateUser('conta-b', 'LeakedPass123!');

    expect(accountA.success).toBe(true);
    expect(accountB.success).toBe(true);
  });

  it('T6: encerramento global por identidade invalida todos os devices', async() => {
    const { authService, tokenService } = makeHarness();
    const firstDevice = await tokenService.generateTokenPair({ id: 't6-user', username: 'comprometido' });
    const secondDevice = await tokenService.generateTokenPair({ id: 't6-user', username: 'comprometido' });

    const ended = await authService.endSession({ authenticatedUserId: 't6-user' });

    expect(ended.success).toBe(true);
    for (const accessToken of [firstDevice.accessToken, secondDevice.accessToken]) {
      await expect(tokenService.verifyAccessToken(accessToken)).rejects.toMatchObject({
        code: 'TOKEN_INVALID'
      });
    }
  });

  it('sem Redis em fail-closed, tokens preexistentes nao sao aceitos', async() => {
    const { tokenService } = makeHarness();
    const pair = await tokenService.generateTokenPair({ id: 'no-redis-user', username: 'sem-redis' });
    const withoutRedis = new JWTTokenService(
      SECRET,
      SECRET,
      null,
      'auth-service',
      'api-users',
      { failOpen: false }
    );

    await expect(withoutRedis.verifyAccessToken(pair.accessToken)).rejects.toMatchObject({
      code: 'REVOCATION_UNAVAILABLE'
    });
  });
});

/**
 * O opt-out de `AUTO_REVOKE_ON_REUSE` e o mutation check da Fase 5.2: as duas
 * metades abaixo precisam falhar se a revogação automática for removida de
 * `src/domain/index.ts` (a primeira) ou deixar de ser condicionável (a segunda).
 *
 * O que o opt-out desliga e so a resposta agressiva. A deteccao continua: o
 * resultado segue vindo com `code: 'REFRESH_TOKEN_REUSED'`, que e o que o
 * controller usa para registrar o evento de seguranca — um opt-out de
 * infraestrutura nao pode ser um switch para silenciar o alerta.
 */
describe('AUTO_REVOKE_ON_REUSE: padrao e opt-out', () => {
  it('com o padrao, o reuso revoga a sessao inteira do usuario', async() => {
    const { authService, tokenService } = makeHarness();
    const revogar = jest.spyOn(tokenService, 'revokeUserTokens');
    const legitimo = await tokenService.generateTokenPair({ id: 'reuse-user', username: 'reuso' });

    await authService.refreshUserTokens(legitimo.refreshToken);
    const replay = await authService.refreshUserTokens(legitimo.refreshToken);

    expect(replay).toMatchObject({ success: false, code: 'REFRESH_TOKEN_REUSED' });
    expect(revogar).toHaveBeenCalledWith('reuse-user');
  });

  it('com o opt-out, o reuso continua recusado mas nao derruba a sessao', async() => {
    const { authService, tokenService } = makeHarness({ autoRevokeOnRefreshReuse: false });
    const revogar = jest.spyOn(tokenService, 'revokeUserTokens');
    const legitimo = await tokenService.generateTokenPair({ id: 'reuse-user', username: 'reuso' });
    const segundoDispositivo = await tokenService.generateTokenPair({ id: 'reuse-user', username: 'reuso' });

    const rotacionado = await authService.refreshUserTokens(legitimo.refreshToken);
    const replay = await authService.refreshUserTokens(legitimo.refreshToken);

    // 401 continua sendo a resposta: o opt-out existe para o caso de retry de
    // proxy, nao para devolver a sessao ao atacante.
    expect(replay).toMatchObject({ success: false, code: 'REFRESH_TOKEN_REUSED' });
    expect(revogar).not.toHaveBeenCalled();

    // E a deteccao nao foi silenciada: o codigo que o controller transforma em
    // evento de seguranca segue no resultado.
    expect(replay.code).toBe('REFRESH_TOKEN_REUSED');
    expect(replay.securityEvent).toBeUndefined();

    // A sessao sobrevive, que e o ponto do opt-out.
    await expect(tokenService.verifyAccessToken(segundoDispositivo.accessToken)).resolves.toMatchObject({
      id: 'reuse-user'
    });
    await expect(tokenService.verifyAccessToken(rotacionado.token!.accessToken)).resolves.toMatchObject({
      id: 'reuse-user'
    });
  });

  it('o opt-out nao vaza para a proxima chamada: cada requisicao le a configuracao', async() => {
    const { authService, tokenService } = makeHarness({ autoRevokeOnRefreshReuse: false });
    const legitimo = await tokenService.generateTokenPair({ id: 'reuse-user', username: 'reuso' });

    await authService.refreshUserTokens(legitimo.refreshToken);
    const replay = await authService.refreshUserTokens(legitimo.refreshToken);

    expect(replay.success).toBe(false);
    // Sem revogacao, o token rotacionado continua sendo o token vivo: o
    // atacante que usou o refresh velho nao matou a sessao legitima.
    await expect(tokenService.verifyAccessToken(legitimo.accessToken)).resolves.toMatchObject({
      id: 'reuse-user'
    });
  });
});
