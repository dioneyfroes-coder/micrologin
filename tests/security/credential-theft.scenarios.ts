import { describe, expect, it, jest } from '@jest/globals';
import { AuthService, User } from '../../src/domain/index.js';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';
import type { Es256KeyMaterial } from '../../src/infrastructure/external-services/jwtTokenService.js';

/**
 * Os seis cenários T1–T6 e o caso fail-closed, em um só corpo.
 *
 * Eles são registrados a partir de um `makeHarness` injetado porque a
 * diferença que P4 exige medir é justamente o **ambiente**, não o cenário.
 * Redis real e Redis em memória exercitam caminhos diferentes do código sob
 * teste: `SET NX` atômico entre processos, `INCR` de versão de sessão e TTL
 * real contra um `Map` que faz check-and-set dentro de uma única thread do
 * Node. Rodar duas suítes quase iguais não provaria nada sobre a segunda —
 * o que P4 exige é o mesmo resultado nos dois, e "mesmo resultado" só é
 * verificável se o corpo do teste for literalmente o mesmo.
 *
 * `credential-theft.survival.test.ts` registra com o harness em memória (não
 * precisa de Docker); `credential-theft.real-redis.test.ts` registra com o
 * Redis do compose e assinatura ES256.
 */
export type SurvivalHarness = {
  authService: AuthService;
  tokenService: JWTTokenService;
  logger: Logger;
  /** Segredo simétrico do harness; o caminho HS256 exige, o ES256 ignora. */
  secret: string;
  /** Material ES256 quando o harness assina assimetricamente; null em HS256. */
  es256: Es256KeyMaterial | null;
};

export type MakeSurvivalHarness = (options?: {
  autoRevokeOnRefreshReuse?: boolean;
}) => SurvivalHarness;

const makeUser = (id: string, username: string, hashedPassword: string) =>
  new User(id, username, hashedPassword, new Date('2025-01-01'), new Date('2025-01-01'));

export const registerSurvivalScenarios = (makeHarness: MakeSurvivalHarness) => {
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
        hash: jest.fn(async() => 'new-hash'),
        compareDummy: jest.fn(async() => false)
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

    // Este é o cenário que mais ganha com Redis real. Com um `Map` em memória o
    // check-and-set de `consumeRefreshToken` roda dentro de uma única thread,
    // então "um vencedor" é garantido pela serialização do event loop. Contra o
    // Redis do compose, os dois `SET NX` disputam a mesma chave de verdade e o
    // que o teste mede passa a ser o comportamento em produção.
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
        compare: jest.fn(async(plain: string, hash: string) => plain === 'LeakedPass123!' && hash === 'same-hash'),
        compareDummy: jest.fn(async() => false)
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
      const { tokenService, secret, es256 } = makeHarness();
      const pair = await tokenService.generateTokenPair({ id: 'no-redis-user', username: 'sem-redis' });
      // Mesmo par de chaves do harness, sem store: o que muda é só a
      // disponibilidade da revogação. Passar o material evita que o teste
      // dependa do segredo simétrico, que no caminho ES256 não existe.
      const withoutRedis = new JWTTokenService(
        secret,
        secret,
        null,
        'auth-service',
        'api-users',
        { failOpen: false },
        es256
      );

      await expect(withoutRedis.verifyAccessToken(pair.accessToken)).rejects.toMatchObject({
        code: 'REVOCATION_UNAVAILABLE'
      });
    });
  });
};
