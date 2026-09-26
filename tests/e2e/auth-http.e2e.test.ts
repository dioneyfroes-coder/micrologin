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

const putJson = async(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> => fetch(`${BASE_URL}${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

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
    // Limites folgados: o E2E exercita vários logins por IP e não deve
    // depender do orçamento de rate limit (a política é testada em unidade).
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = process.env.RATE_LIMIT_PROD_LOGIN_POINTS || '500';
    process.env.RATE_LIMIT_PROD_IP_POINTS = process.env.RATE_LIMIT_PROD_IP_POINTS || '2000';
    process.env.RATE_LIMIT_PROD_USER_POINTS = process.env.RATE_LIMIT_PROD_USER_POINTS || '2000';

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

  it('troca de senha: exige a atual, recusa reuso e encerra as sessões', async() => {
    const unique = `pwd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const oldPassword = 'OldStrongPass123!';
    const newPassword = 'NewStrongPass456!';

    await postJson('/register', { user: unique, password: oldPassword });
    const loginRes = await postJson('/login', { user: unique, password: oldPassword });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as {
      data?: { accessToken?: string; refreshToken?: string };
    };
    const accessToken = loginBody.data?.accessToken as string;
    const refreshToken = loginBody.data?.refreshToken as string;

    // 1. Senha atual errada é recusada (401) e nada muda
    const wrongCurrent = await putJson('/password',
      { currentPassword: 'Errada123!', newPassword }, bearer(accessToken));
    expect(wrongCurrent.status).toBe(401);
    expect((await postJson('/login', { user: unique, password: oldPassword })).status).toBe(200);

    // 2. Reutilizar a senha atual é recusado
    const samePassword = await putJson('/password',
      { currentPassword: oldPassword, newPassword: oldPassword }, bearer(accessToken));
    expect(samePassword.status).toBe(400);

    // 3. Senha fraca é recusada
    const weak = await putJson('/password',
      { currentPassword: oldPassword, newPassword: 'fraca' }, bearer(accessToken));
    expect(weak.status).toBe(400);

    // 4. Troca válida
    const changeRes = await putJson('/password',
      { currentPassword: oldPassword, newPassword }, bearer(accessToken));
    expect(changeRes.status).toBe(200);

    // 5. As sessões existentes foram encerradas
    expect((await getJson('/profile', bearer(accessToken))).status).toBe(401);
    expect((await postJson('/refresh', { refreshToken })).status).toBe(401);

    // 6. A senha antiga não autentica mais; a nova autentica
    expect((await postJson('/login', { user: unique, password: oldPassword })).status).toBe(401);
    const newLogin = await postJson('/login', { user: unique, password: newPassword });
    expect(newLogin.status).toBe(200);

    // 7. A senha antiga não pode ser "reutilizada" (histórico)
    const newLoginBody = await newLogin.json() as { data?: { accessToken?: string } };
    const reuseOld = await putJson('/password',
      { currentPassword: newPassword, newPassword: oldPassword }, bearer(newLoginBody.data?.accessToken as string));
    expect(reuseOld.status).toBe(400);
    expect((await reuseOld.json() as { code?: string }).code).toBe('PASSWORD_REUSED');

    // 8. A senha antiga continua barrada
    expect((await postJson('/login', { user: unique, password: oldPassword })).status).toBe(401);
  }, 40000);

  it('recusa troca de senha sem autenticação e por /update', async() => {
    const unique = `pwd2_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const oldPassword = 'OldStrongPass123!';

    await postJson('/register', { user: unique, password: oldPassword });
    const loginRes = await postJson('/login', { user: unique, password: oldPassword });
    const loginBody = await loginRes.json() as { data?: { accessToken?: string } };

    // Sem token
    const anonymous = await putJson('/password', {
      currentPassword: oldPassword,
      newPassword: 'NewStrongPass456!'
    });
    expect(anonymous.status).toBe(401);

    // /update não troca senha
    const viaUpdate = await putJson('/update', { password: 'NewStrongPass456!' },
      bearer(loginBody.data?.accessToken as string));
    expect(viaUpdate.status).toBe(400);

    // A senha original continua valendo
    expect((await postJson('/login', { user: unique, password: oldPassword })).status).toBe(200);
  }, 40000);

  it('refresh concorrente: uma requisição rotaciona, a outra é rejeitada', async() => {
    const unique = `race_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const password = 'StrongPass123!';

    await postJson('/register', { user: unique, password });
    const loginRes = await postJson('/login', { user: unique, password });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { data?: { refreshToken?: string } };
    const refreshToken = loginBody.data?.refreshToken as string;

    // Duas requisições simultâneas com o MESMO refresh token.
    // O consumo é atômico (SET NX): só uma pode rotacionar.
    const [first, second] = await Promise.all([
      postJson('/refresh', { refreshToken }),
      postJson('/refresh', { refreshToken })
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);

    const rejected = first.status === 401 ? first : second;
    const rejectedBody = await rejected.json() as { success?: boolean; code?: string };
    expect(rejectedBody.success).toBe(false);
    expect(rejectedBody.code).toMatch(/REFRESH_TOKEN_(INVALID|REUSED)/);

    // O vencedor recebeu um par novo e utilizável
    const winner = first.status === 200 ? first : second;
    const winnerBody = await winner.json() as { data?: { accessToken?: string; refreshToken?: string } };
    expect(winnerBody.data?.accessToken).toBeTruthy();
    expect(winnerBody.data?.refreshToken).not.toBe(refreshToken);

    const profile = await getJson('/profile', bearer(winnerBody.data?.accessToken as string));
    expect(profile.status).toBe(200);
  }, 30000);

  it('identidade é case-insensitive em registro, login e atualização', async() => {
    const unique = `case_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const mixedCase = `Case_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const password = 'StrongPass123!';

    // Registro com maiúsculas é persistado na forma canônica (minúsculas)
    const registerRes = await postJson('/register', { user: mixedCase, password });
    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json() as {
      data?: { user?: { username?: string } };
    };
    expect(registerBody.data?.user?.username).toBe(mixedCase.toLowerCase());

    // Login funciona com qualquer variação de caixa
    const lowerLogin = await postJson('/login', { user: mixedCase.toLowerCase(), password });
    const upperLogin = await postJson('/login', { user: mixedCase.toUpperCase(), password });
    const paddedLogin = await postJson('/login', { user: `  ${mixedCase}  `, password });
    expect(lowerLogin.status).toBe(200);
    expect(upperLogin.status).toBe(200);
    expect(paddedLogin.status).toBe(200);

    // Username duplicado com caixa diferente é rejeitado
    const duplicateRes = await postJson('/register', { user: mixedCase.toUpperCase(), password });
    expect(duplicateRes.status).toBe(400);

    // Atualização normaliza o novo username
    const loginBody = await lowerLogin.json() as { data?: { accessToken?: string } };
    const accessToken = loginBody.data?.accessToken as string;
    const updateRes = await fetch(`${BASE_URL}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...bearer(accessToken) },
      body: JSON.stringify({ user: unique.toUpperCase() })
    });
    expect(updateRes.status).toBe(200);
    const updatedBody = await updateRes.json() as { data?: { user?: { username?: string } } };
    expect(updatedBody.data?.user?.username).toBe(unique);
  }, 30000);
});
