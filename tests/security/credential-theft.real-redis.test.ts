import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { decodeProtectedHeader } from 'jose';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { AuthService, User } from '../../src/domain/index.js';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';
import { disconnectRedis } from '../../src/infrastructure/cache/connection.js';
import type { Server } from 'node:http';
import { registerSurvivalScenarios, type SurvivalHarness } from './credential-theft.scenarios.js';

/**
 * Repositório que responde "o usuário existe" para qualquer id.
 *
 * Desde a 1.0.0 a renovação confere a existência do usuário antes de emitir o
 * par novo: um refresh token criptograficamente válido não é prova de que a
 * conta continua de pé. Um repositório vazio (`{}`) faria essa checagem estourar
 * uma exceção e o cenário falharia com `REFRESH_TOKEN_INVALID` — uma falha que
 * parece de token, mas é do harness. Estes cenários testam o comportamento de
 * sessão, então o que importa é que a conta exista.
 */
const existingUsers = {
  findById: async(id: string) => new User(id, 'usuario', 'hash-da-senha', new Date('2025-01-01'), new Date('2025-01-01'))
};

/**
 * T1–T6 contra o Redis do compose, na assinatura de produção (ES256).
 *
 * A suíte em memória (`credential-theft.survival.test.ts`) registra os mesmos
 * corpos de cenário e roda sem Docker. Esta aqui registra os mesmos corpos com
 * o ambiente trocado, e é o que a Fase 5.2 pede: os seis cenários rodando
 * contra o Redis real, com o mesmo resultado.
 *
 * A troca de ambiente não é cosmética. Com um `Map`, o check-and-set de
 * `consumeRefreshToken` roda dentro de uma única thread do Node, então T4
 * passaria por serialização do event loop. Contra o Redis, os dois `SET NX`
 * disputam a mesma chave de verdade.
 *
 * Além dos seis cenários, esta suíte fecha os três números que o P4 exige
 * registrar: quantas rotações o atacante consegue tirar antes de ser detectado,
 * quanto tempo leva, e se ele consegue um 200 em `/profile` depois da revogação
 * — o último medido por HTTP contra o app real, não contra o token service.
 */
const REDIS_HOST_PORT = process.env.CREDENTIAL_THEFT_REDIS_PORT || '6380';
const MONGO_HOST_PORT = process.env.CREDENTIAL_THEFT_MONGO_PORT || '27020';
// Banco exclusivo desta suíte. O E2E usa o /2 e o app de dev usa o /0: um
// `FLUSHDB` aqui não pode tocar em nenhum dos dois.
const REDIS_DB = process.env.CREDENTIAL_THEFT_REDIS_DB || '15';
const REDIS_URL = `redis://localhost:${REDIS_HOST_PORT}/${REDIS_DB}`;
const MONGO_URL = `mongodb://localhost:${MONGO_HOST_PORT}/auth-credential-theft-real`;
const HTTP_PORT = Number(process.env.CREDENTIAL_THEFT_HTTP_PORT || 3401);
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const KID = 'ct-real-es256';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const postJson = async(path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
};

const getJson = async(path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
};

// O `errorHandler` responde `{ success, code, message }` no topo da corpo; o
// código do domínio viaja em `code`, não dentro de um objeto `error`.
const errorCode = (body: Record<string, unknown>) => body.code as string | undefined;

const waitForPort = (port: number, timeoutMs: number) => new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const attempt = () => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', () => {
      socket.destroy();
      if (Date.now() > deadline) {
        reject(new Error(
          `Redis/Mongo não respondeu em 127.0.0.1:${port} dentro de ${timeoutMs}ms. ` +
          'Suba as dependências: docker compose up -d mongodb redis'
        ));
      } else {
        setTimeout(attempt, 250);
      }
    });
  };
  attempt();
});

describe('credential theft survival - Redis real + ES256', () => {
  let redis: RedisClientType;
  let server: Server | null = null;
  let keysDir: string | null = null;
  let keyMaterial: { kid: string; privateKeyPem: string; publicKeyPem: string };


  const makeHarness = ({
    autoRevokeOnRefreshReuse = true
  }: {
    autoRevokeOnRefreshReuse?: boolean;
  } = {}): SurvivalHarness => {
    const tokenService = new JWTTokenService(
      // Segredos vazios de propósito: no caminho ES256 eles não são usados, e
      // deixá-los vazios impede que um accidentally-caído para HS256 passe
      // silencioso. Se o harness voltasse a HS256, a construção explodiria.
      '',
      '',
      redis as never,
      'auth-service',
      'api-users',
      { failOpen: false },
      keyMaterial
    );
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const authService = new AuthService(existingUsers, {}, tokenService, logger, autoRevokeOnRefreshReuse);
    return { authService, tokenService, logger, secret: '', es256: keyMaterial };
  };

  beforeAll(async() => {
    await waitForPort(Number(REDIS_HOST_PORT), 20000);
    await waitForPort(Number(MONGO_HOST_PORT), 20000);

    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    await redis.connect();
    if (!redis.isReady) {
      throw new Error(`Redis não está pronto em ${REDIS_URL}`);
    }
    // Estado limpo: chaves de revogação de uma execução anterior fariam o T1
    // passar por uma versão de sessão já incrementada, e o teste deixaria de
    // medir a revogação.
    await redis.flushDb();

    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    keyMaterial = {
      kid: KID,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    };

    // O app sobe com o mesmo par de chaves e o mesmo Redis, para que a prova
    // HTTP use exatamente a assinatura e o store da prova de domínio.
    keysDir = mkdtempSync(join(tmpdir(), 'ct-real-jwt-'));
    const privateKeyPath = join(keysDir, 'jwt-es256-private.pem');
    const publicKeyPath = join(keysDir, 'jwt-es256-public.pem');
    writeFileSync(privateKeyPath, keyMaterial.privateKeyPem, { mode: 0o600 });
    writeFileSync(publicKeyPath, keyMaterial.publicKeyPem, { mode: 0o644 });

    process.env.NODE_ENV = 'test';
    process.env.PORT = String(HTTP_PORT);
    process.env.URI_MONGODB = MONGO_URL;
    process.env.REDIS_URL = REDIS_URL;
    process.env.REDIS_ENABLED = 'true';
    process.env.JWT_SECRET = 'so-o-hs256-recusaria-32-chars-minimum';
    process.env.JWT_ALGORITHM = 'ES256';
    process.env.JWT_ES256_KID = KID;
    process.env.JWT_ES256_PRIVATE_KEY_PATH = privateKeyPath;
    process.env.JWT_ES256_PUBLIC_KEY_PATH = publicKeyPath;
    process.env.SECURITY_DASHBOARD_TOKEN = 'ct-real-dashboard-token';
    process.env.LOG_LEVEL = 'error';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '500';
    process.env.RATE_LIMIT_PROD_IP_POINTS = '2000';
    process.env.RATE_LIMIT_PROD_USER_POINTS = '2000';

    const { default: AuthApp } = await import('../../src/app.js');
    const app = new AuthApp();
    await app.start(HTTP_PORT);
    server = app.server;
    const { advancedRateLimit } = await import('../../src/application/middleware/advancedRateLimit.js');
    await advancedRateLimit.reset();
  }, 60000);

  afterAll(async() => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
      server = null;
    }
    await mongoose.disconnect();
    await disconnectRedis();
    if (redis?.isOpen) {
      await redis.flushDb();
      await redis.quit();
    }
    if (keysDir) {
      rmSync(keysDir, { recursive: true, force: true });
      keysDir = null;
    }
  }, 20000);

  // Registro no nível do describe: os corpos de T1–T6 são literalmente os
  // mesmos da suíte em memória.
  registerSurvivalScenarios(makeHarness);

  describe('assinatura e store de produção', () => {
    it('assina em ES256 com o kid configurado, e não em HS256', async() => {
      const { tokenService } = makeHarness();
      const pair = await tokenService.generateTokenPair({ id: 'env-proof', username: 'env' });

      const header = decodeProtectedHeader(pair.accessToken);
      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe(KID);
      expect(decodeProtectedHeader(pair.refreshToken).alg).toBe('ES256');

      // Um token HS256 com o mesmo payload passaria em qualquer verificação
      // estrutural; o que garante o caminho é a chave assimétrica, e ela
      // precisa verificar.
      await expect(tokenService.verifyAccessToken(pair.accessToken)).resolves.toMatchObject({
        id: 'env-proof'
      });
    });

    it('grava as chaves de revogação no Redis real, não em memória local', async() => {
      const { tokenService } = makeHarness();
      const pair = await tokenService.generateTokenPair({ id: 'env-real', username: 'real' });

      const revoked = await tokenService.revokeToken(pair.accessToken);

      expect(revoked).toBe(true);
      const keys = await redis.keys('token_blacklist:*');
      expect(keys.length).toBeGreaterThan(0);
    });

    // Esta é a guarda que impede a suíte de passar por um motivo errado: sem
    // ela, um harness que caísse para um `Map` — ou para um duplo — continuaria
    // verde, porque T1–T6 só observam o resultado, nunca onde o estado mora.
    // A leitura vem por uma conexão independente, então o que prova é que a
    // revogação está no servidor, e não num objeto do processo.
    it('o estado de revogação é legível por outra conexão ao Redis', async() => {
      const { tokenService } = makeHarness();
      const pair = await tokenService.generateTokenPair({ id: 'env-outside', username: 'fora' });

      await tokenService.revokeToken(pair.accessToken);

      const observer = createClient({ url: REDIS_URL }) as RedisClientType;
      await observer.connect();
      try {
        const outside = await observer.keys('token_blacklist:*');
        expect(outside.length).toBeGreaterThan(0);

        // E a mesma chave responde `revoked` para quem não é o processo que
        // escreveu — o valor é o que `verifyAccessToken` consulta.
        const values = await Promise.all(outside.map(key => observer.get(key)));
        expect(values).toContain('revoked');
      } finally {
        await observer.quit();
      }
    });
  });

  describe('detecção de reuso: rotação e tempo medidos', () => {
    it('o atacante tira zero rotações antes de ser detectado', async() => {
      const { authService, tokenService } = makeHarness();
      const victim = await tokenService.generateTokenPair({ id: 'reuse-timing', username: 'vitima' });

      // A vítima rotaciona uma vez. Daqui em diante, o refresh antigo é do
      // atacante.
      const rotated = await authService.refreshUserTokens(victim.refreshToken);
      expect(rotated.success).toBe(true);

      let grantedRotations = 0;
      let detections = 0;
      const latencies: number[] = [];
      const stolenRefresh = victim.refreshToken;

      // O atacante repete indefinidamente. A primeira tentativa já tem de
      // falhar: qualquer rotação bem-sucedida aqui já é o defeito.
      for (let attempt = 1; attempt <= 5; attempt++) {
        const startedAt = performance.now();
        const result = await authService.refreshUserTokens(stolenRefresh);
        latencies.push(performance.now() - startedAt);
        if (result.success) {
          grantedRotations++;
          continue;
        }
        detections++;
        if (attempt === 1) {
          // `securityEvent` só aparece quando a revogação *falha*: o
          // controller detecta o reuso pelo `code`, e é por ele que registra
          // o evento de segurança. Ver o caminho HTTP abaixo, que é o que o
          // operador enxerga.
          expect(result.code).toBe('REFRESH_TOKEN_REUSED');
        }
      }

      // Segundas tentativas devem dizer INVALID, não REUSED: o refresh já
      // foi consumido. Distinguir os dois é o que mostra que o primeiro erro
      // gravou estado, e não só respondeu com uma string.
      const afterDetection = await authService.refreshUserTokens(stolenRefresh);
      expect(afterDetection.code).toBe('REFRESH_TOKEN_INVALID');


      console.info(
        '[credential-theft-real-redis] reuso detectado em %d de %d tentativas; ' +
        'rotações concedidas ao atacante: %d; latência 1a tentativa: %s ms',
        detections, 5, grantedRotations, latencies[0].toFixed(2)
      );

      expect(detections).toBe(5);
      expect(grantedRotations).toBe(0);
    });

    it('detecta o reuso em menos de uma rotação, dentro do orçamento medido', async() => {
      const { authService, tokenService } = makeHarness();
      const victim = await tokenService.generateTokenPair({ id: 'reuse-budget', username: 'vitima' });
      await authService.refreshUserTokens(victim.refreshToken);

      const startedAt = performance.now();
      const replay = await authService.refreshUserTokens(victim.refreshToken);
      const elapsedMs = performance.now() - startedAt;

      expect(replay.code).toBe('REFRESH_TOKEN_REUSED');
      // Uma rotação a mais seria o defeito; o limite de tempo aqui é o teto
      // operacional para o alerta de segurança, medido contra Redis real.
      expect(elapsedMs).toBeLessThan(1000);

      console.info('[credential-theft-real-redis] detecção de reuso: %s ms', elapsedMs.toFixed(2));
    });
  });

  describe('o atacante não ganha nada depois da revogação (HTTP contra o app real)', () => {
    it('reuso de refresh derruba a sessão e barra /profile com 401', async() => {
      const unique = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const password = 'StrongPass123!';

      const registered = await postJson('/register', { user: unique, password });
      expect(registered.status).toBe(201);

      const login = await postJson('/login', { user: unique, password });
      expect(login.status).toBe(200);
      const loginData = login.body.data as { accessToken?: string; refreshToken?: string };
      const victimAccess = loginData.accessToken as string;
      const victimRefresh = loginData.refreshToken as string;

      // A vítima tem uma segunda sessão, para provar que a revogação é por
      // identidade e não daquele par só.
      const secondDevice = await postJson('/login', { user: unique, password });
      const secondAccess = (secondDevice.body.data as { accessToken?: string }).accessToken as string;

      // Antes de qualquer revogação, o atacante (com o refresh roubado) tem
      // ainda o que perder: o par legitimo é válido.
      const beforeRevocation = await getJson('/profile', bearer(victimAccess));
      expect(beforeRevocation.status).toBe(200);

      const rotation = await postJson('/refresh', { refreshToken: victimRefresh });
      expect(rotation.status).toBe(200);
      const rotatedAccess = (rotation.body.data as { accessToken?: string }).accessToken as string;

      // O atacante usa o refresh que já foi rotacionado.
      const replay = await postJson('/refresh', { refreshToken: victimRefresh });
      expect(replay.status).toBe(401);
      expect(errorCode(replay.body)).toBe('REFRESH_TOKEN_REUSED');

      // A partir daqui nada do que o atacante ou a vítima rotacionada tinham
      // pode mais servir — e o segundo device também cai, porque a revogação
      // é por identidade.
      const attackerAccess = await getJson('/profile', bearer(rotatedAccess));
      expect(attackerAccess.status).not.toBe(200);

      const attackerStolen = await getJson('/profile', bearer(victimAccess));
      expect(attackerStolen.status).toBe(401);

      const otherDevice = await getJson('/profile', bearer(secondAccess));
      expect(otherDevice.status).toBe(401);

      // E o refresh roubado não resurge: nem uma tentativa a mais.
      const secondReplay = await postJson('/refresh', { refreshToken: victimRefresh });
      expect(secondReplay.status).toBe(401);
      expect(errorCode(secondReplay.body)).toBe('REFRESH_TOKEN_INVALID');

      // Sem login novo, o usuário não recupera nada pelo caminho do atacante.
      const stillDead = await getJson('/profile', bearer(rotatedAccess));
      expect(stillDead.status).toBe(401);
    });

    it('troca de senha barra o /profile do atacante por HTTP', async() => {
      const unique = `ctpwd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const password = 'StrongPass123!';
      const newPassword = 'EvenStronger456!';

      await postJson('/register', { user: unique, password });
      const login = await postJson('/login', { user: unique, password });
      const loginData = login.body.data as { accessToken?: string; refreshToken?: string };
      const stolenAccess = loginData.accessToken as string;

      expect((await getJson('/profile', bearer(stolenAccess))).status).toBe(200);

      const changed = await fetch(`${BASE_URL}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...bearer(stolenAccess) },
        body: JSON.stringify({ currentPassword: password, newPassword })
      });
      expect(changed.status).toBe(200);

      const afterChange = await getJson('/profile', bearer(stolenAccess));
      expect(afterChange.status).toBe(401);

      const relogin = await postJson('/login', { user: unique, password: newPassword });
      expect(relogin.status).toBe(200);
      const freshAccess = (relogin.body.data as { accessToken?: string }).accessToken as string;
      expect((await getJson('/profile', bearer(freshAccess))).status).toBe(200);
    });
  });
});
