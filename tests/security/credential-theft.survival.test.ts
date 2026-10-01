import { describe, expect, it, jest } from '@jest/globals';
import { AuthService } from '../../src/domain/index.js';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';
import { registerSurvivalScenarios, type SurvivalHarness } from './credential-theft.scenarios.js';

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

/**
 * Harness em memória: sem Docker, para `npm run test:unit`.
 *
 * Os cenários T1–T6 vivem em `credential-theft.scenarios.ts` e são registrados
 * aqui e na suíte de Redis real. Este arquivo é a metade que roda sem
 * infraestrutura; a outra metade é `credential-theft.real-redis.test.ts`.
 *
 * Atenção ao alcance do que o `Map` prova: o check-and-set de
 * `consumeRefreshToken` roda dentro de uma única thread, então T4 passa aqui
 * por serialização do event loop, não por atomicidade de `SET NX`. Para o
 * comportamento em produção, veja T4 contra o Redis do compose.
 */
const makeHarness = ({
  redisClient = makeRedisClient(),
  autoRevokeOnRefreshReuse = true
}: {
  redisClient?: ReturnType<typeof makeRedisClient>;
  autoRevokeOnRefreshReuse?: boolean;
} = {}): SurvivalHarness => {
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
  return { authService, tokenService, redisClient, logger, secret: SECRET, es256: null };
};

registerSurvivalScenarios(makeHarness);

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
