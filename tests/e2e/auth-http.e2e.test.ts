/**
 * E2E HTTP - fluxo de autenticação completo contra infra real.
 *
 * Sobe a aplicação (app.listen) dentro do Jest e fala via HTTP (fetch)
 * usando MongoDB + Redis REAIS (docker compose up -d mongodb redis).
 *
 * Pré-requisito (veja npm run test:e2e):
 *   docker compose up -d mongodb redis
 *
 * Cobertura: health, register, login, profile, update, refresh (rotação),
 * logout + blacklist de tokens no Redis, e falhas esperadas (401/400).
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { Server } from 'http';
import net from 'net';
import mongoose from 'mongoose';
import { disconnectRedis } from '../../src/infrastructure/cache/connection.js';

const E2E_PORT = 3400;
// Portas das dependências (por padrão 27019/6381 p/ não colidir com mongo/redis
// do host; sobrescreva com E2E_MONGO_PORT/E2E_REDIS_PORT se necessário).
const MONGO_PORT = Number(process.env.E2E_MONGO_PORT || 27020);
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || 6380);
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const SECURITY_DASHBOARD_TOKEN = 'e2e-security-dashboard-token-with-32-chars';

const waitForPort = async(port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });

    if (reachable) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(
    `MongoDB/Redis não respondeu em 127.0.0.1:${port} dentro de ${timeoutMs}ms. ` +
    'Suba as dependências: docker compose up -d mongodb redis'
  );
};

const postJson = async(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> => fetch(`${BASE_URL}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const getJson = async(path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${BASE_URL}${path}`, { headers });

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe('E2E HTTP - fluxo completo contra infra real (compose)', () => {
  let server: Server | null = null;

  beforeAll(async() => {
    // Ambiente ANTES de importar o app (appConfig lê env na importação)
    process.env.NODE_ENV = 'test';
    process.env.PORT = String(E2E_PORT);
    process.env.URI_MONGODB = process.env.URI_MONGODB || `mongodb://localhost:${MONGO_PORT}/auth-e2e`;
    process.env.REDIS_URL = process.env.REDIS_URL || `redis://localhost:${REDIS_PORT}/2`;
    process.env.REDIS_ENABLED = 'true';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret-key-with-at-least-32-chars!!';
    process.env.SECURITY_DASHBOARD_TOKEN = SECURITY_DASHBOARD_TOKEN;
    process.env.LOG_LEVEL = 'error';

    // Pré-flight: dependências precisam estar de pé (falha com mensagem útil)
    await waitForPort(MONGO_PORT, 20000);
    await waitForPort(REDIS_PORT, 20000);

    const { default: AuthService } = await import('../../src/app.js');
    const service = new AuthService();
    await service.start(E2E_PORT);
    const { advancedRateLimit } = await import('../../src/application/middleware/advancedRateLimit.js');
    await advancedRateLimit.reset();
    server = service.server;
  }, 30000);

  afterAll(async() => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
      server = null;
    }
    await mongoose.disconnect();
    await disconnectRedis();
  }, 15000);

  it('health reporta mongo e redis operacionais', async() => {
    const res = await getJson('/health');
    const body = await res.json() as { services?: Record<string, { status?: string }> };

    // Infra conectada (mongo+redis healthy). O status geral pode cair para
    // degraded/503 no worker do Jest quando o RSS passa de 200MB (checagem de memória).
    expect([200, 503]).toContain(res.status);
    expect(body.services?.mongodb?.status).toBe('healthy');
    expect(body.services?.redis?.status).toBe('healthy');
  });

  it('protege o dashboard de segurança com token administrativo', async() => {
    const unauthorized = await getJson('/security/stats');
    expect(unauthorized.status).toBe(401);

    const wrongToken = await getJson('/security/stats', {
      'X-Security-Token': 'wrong-token'
    });
    expect(wrongToken.status).toBe(401);

    const authorized = await getJson('/security/stats', {
      'X-Security-Token': SECURITY_DASHBOARD_TOKEN
    });
    expect(authorized.status).toBe(200);
  });

  it('ciclo de vida: register -> login -> profile -> update -> refresh -> logout', async() => {
    const unique = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const password = 'StrongPass123!';

    // 1. Registro cria usuário no MongoDB real
    const registerRes = await postJson('/register', { user: unique, password });
    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json() as {
      success: boolean;
      data?: { user?: { username?: string } };
    };
    expect(registerBody.success).toBe(true);
    expect(registerBody.data?.user?.username).toBe(unique);

    // 2. Login autentica contra o hash persistido
    const loginRes = await postJson('/login', { user: unique, password });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as {
      data?: { accessToken?: string; refreshToken?: string };
    };
    const accessToken = loginBody.data?.accessToken as string;
    const refreshToken = loginBody.data?.refreshToken as string;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // 3. Profile lê o usuário autenticado
    const profileRes = await getJson('/profile', bearer(accessToken));
    expect(profileRes.status).toBe(200);
    const profileBody = await profileRes.json() as { data?: { user?: { username?: string } } };
    expect(profileBody.data?.user?.username).toBe(unique);

    // 4. Atualização persiste no banco
    const newName = `${unique}_v2`.slice(0, 30);
    const updateRes = await fetch(`${BASE_URL}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...bearer(accessToken) },
      body: JSON.stringify({ user: newName })
    });
    expect(updateRes.status).toBe(200);
    const updatedProfile = await getJson('/profile', bearer(accessToken));
    const updatedBody = await updatedProfile.json() as { data?: { user?: { username?: string } } };
    expect(updatedBody.data?.user?.username).toBe(newName);

    // 5. Refresh rota o par de tokens (o antigo deve ser revogado)
    const refreshRes = await postJson('/refresh', { refreshToken });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as {
      data?: { accessToken?: string; refreshToken?: string };
    };
    const rotatedAccess = refreshBody.data?.accessToken as string;
    const rotatedRefresh = refreshBody.data?.refreshToken as string;
    expect(rotatedAccess).toBeTruthy();
    expect(rotatedRefresh).not.toBe(refreshToken);

    // 5a. O refresh token antigo não pode mais ser usado (rotação)
    const reuseRes = await postJson('/refresh', { refreshToken });
    expect(reuseRes.status).toBe(401);

    // 6. Logout revoga o access token no Redis (blacklist)
    const logoutRes = await postJson('/logout', { refreshToken: rotatedRefresh },
      bearer(rotatedAccess));
    expect(logoutRes.status).toBe(200);

    // 6a. Access token revogado é rejeitado (checagem da blacklist)
    const revokedProfile = await getJson('/profile', bearer(rotatedAccess));
    expect(revokedProfile.status).toBe(401);

    // 7. Novo login gera sessão nova (usuário continua válido)
    const reLogin = await postJson('/login', { user: newName, password });
    expect(reLogin.status).toBe(200);
    const reLoginBody = await reLogin.json() as { data?: { accessToken?: string } };
    expect(reLoginBody.data?.accessToken).toBeTruthy();

    // 8. Registro duplicado continua bloqueado
    const duplicateRes = await postJson('/register', { user: newName, password });
    expect(duplicateRes.status).toBe(400);
    const duplicateBody = await duplicateRes.json() as { success?: boolean; code?: string; message?: string };
    expect(duplicateBody).toEqual({
      success: false,
      code: 'REGISTRATION_FAILED',
      message: 'Não foi possível criar a conta'
    });
  }, 30000);

  it('login com credenciais inválidas não enumera usuários', async() => {
    const existingUser = `enum_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const password = 'StrongPass123!';
    const registerRes = await postJson('/register', { user: existingUser, password });
    expect(registerRes.status).toBe(201);

    const wrongPassword = await postJson('/login', {
      user: existingUser,
      password: 'WrongPass123!'
    });
    const unknownUser = await postJson('/login', {
      user: `missing_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      password: 'WrongPass123!'
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);

    const wrongPasswordBody = await wrongPassword.json() as { success?: boolean; code?: string; message?: string };
    const unknownUserBody = await unknownUser.json() as { success?: boolean; code?: string; message?: string };

    expect(wrongPasswordBody).toEqual(unknownUserBody);
    expect(wrongPasswordBody).toEqual({
      success: false,
      code: 'AUTHENTICATION_FAILED',
      message: 'Credenciais inválidas'
    });
  });

  it('sem token, profile responde 401', async() => {
    const res = await getJson('/profile');
    expect(res.status).toBe(401);
  });
});
