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
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { decodeProtectedHeader } from 'jose';
import { disconnectRedis } from '../../src/infrastructure/cache/connection.js';

const E2E_PORT = 3400;
// Portas das dependências (por padrão 27019/6381 p/ não colidir com mongo/redis
// do host; sobrescreva com E2E_MONGO_PORT/E2E_REDIS_PORT se necessário).
const MONGO_PORT = Number(process.env.E2E_MONGO_PORT || 27020);
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || 6380);
const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const SECURITY_DASHBOARD_TOKEN = 'e2e-security-dashboard-token-with-32-chars';
// `kid` do par efêmero do teste. O token precisa sair com este valor no header:
// sem o `kid`, o verificador teria que testar todas as chaves, que é
// exatamente o que a rotação veio para evitar.
const E2E_KID = 'e2e-v1';

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

/**
 * Extrai um objeto JSON a partir de `start`, contando chaves e ignorando
 * chaves e barras que estejam dentro de strings.
 */
const extractJsonObject = (source: string, start: number): string => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index++) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error('swagger-ui-init.js não contém um objeto JSON balanceado');
};

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

/**
 * GET por socket cru, sem validação de header no cliente. É o caminho que um
 * cliente hostil usaria para mandar CRLF ou payload gigante no X-Request-Id.
 */
const rawGet = (path: string, requestId: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port: E2E_PORT }, () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${E2E_PORT}\r\nConnection: close\r\n` +
      `X-Request-Id: ${requestId}\r\n\r\n`
    );
  });

  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk as Buffer));
  socket.once('error', reject);
  socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

describe('E2E HTTP - fluxo completo contra infra real (compose)', () => {
  let server: Server | null = null;
  let keysDir: string | null = null;
  let privateKeyPath = '';
  let publicKeyPath = '';

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

    // A assinatura é a de produção: ES256. Um E2E em HS256 validaria um caminho
    // que produção recusa no arranque, e foi exatamente essa distância que
    // deixou passar um par de chaves no formato errado — o serviço subia,
    // passava no health check e devolvia 401 de credencial inválida no primeiro
    // login, porque a assinatura é que falhava. `E2E_JWT_ALGORITHM=HS256`
    // reexecuta a suíte no caminho legado quando for isso que se quer medir.
    process.env.JWT_ALGORITHM = process.env.E2E_JWT_ALGORITHM || 'ES256';
    if (process.env.JWT_ALGORITHM === 'ES256') {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keysDir = mkdtempSync(join(tmpdir(), 'e2e-jwt-keys-'));
      privateKeyPath = join(keysDir, 'jwt-es256-private.pem');
      publicKeyPath = join(keysDir, 'jwt-es256-public.pem');
      writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });

      process.env.JWT_ES256_KID = E2E_KID;
      // Por arquivo, como em produção: chave privada em variável de ambiente é
      // texto de configuração, e texto de configuração vaza em log, em dump e
      // em `docker inspect`.
      process.env.JWT_ES256_PRIVATE_KEY_PATH = privateKeyPath;
      process.env.JWT_ES256_PUBLIC_KEY_PATH = publicKeyPath;
    }
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
    if (keysDir) {
      rmSync(keysDir, { recursive: true, force: true });
      keysDir = null;
    }
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

  it('liveness e readiness respondem com semântica própria', async() => {
    const liveness = await getJson('/liveness');
    expect(liveness.status).toBe(200);
    const livenessBody = await liveness.json() as { status: string; pid: number };
    expect(livenessBody.status).toBe('alive');
    expect(livenessBody.pid).toBe(process.pid);

    // Com a infra real no ar, o serviço tem de estar pronto para tráfego.
    const readiness = await getJson('/readiness');
    expect(readiness.status).toBe(200);
    const readinessBody = await readiness.json() as {
      ready: boolean;
      degraded: boolean;
      checks: Record<string, { status: string }>;
    };
    expect(readinessBody.ready).toBe(true);
    expect(readinessBody.degraded).toBe(false);
    expect(readinessBody.checks.mongodb.status).toBe('healthy');
    expect(readinessBody.checks.redis.status).toBe('healthy');
  });

  it('liveness não depende de dependency externa: responde mesmo com X-Forwarded-For forjado', async() => {
    const forged = await getJson('/liveness', { 'X-Forwarded-For': '203.0.113.7' });
    expect(forged.status).toBe(200);
  });

  it('descarta X-Request-Id externo que não é UUID', async() => {
    // `fetch` recusa CRLF em header, então o caminho realista de um cliente
    // hostil é socket cru: são esses bytes que chegam ao Express.
    const raw = await rawGet('/health', 'forjado\r\nX-Injected: 1');
    expect(raw).not.toContain('X-Injected: 1');
    expect(raw).toMatch(/x-request-id: [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);

    const oversized = await rawGet('/health', 'a'.repeat(2000));
    expect(oversized).toMatch(/x-request-id: [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);

    const trusted = await getJson('/health', { 'X-Request-Id': '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    expect(trusted.headers.get('x-request-id')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
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

    // O token que o serviço devolve tem que sair no esquema que ele declara.
    // A checagem é do header, sem verificar assinatura: o que se prova aqui é
    // que o par configurado é o que assinou. Um token que o serviço não
    // consegue assinar vira, para o cliente, 401 de credencial inválida.
    if ((process.env.JWT_ALGORITHM || 'ES256') === 'ES256') {
      const header = decodeProtectedHeader(accessToken);
      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe(E2E_KID);
      expect(decodeProtectedHeader(refreshToken).kid).toBe(E2E_KID);
    }

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

  it('/api-docs serve um documento com os endpoints reais', async() => {
    // Prova pela fronteira HTTP, e não por unidade: o bug do item 2.3 era o
    // documento vazio, que abria bonito e não descrevia nada. Aqui a UI é
    // servida de verdade e o `swagger-ui-init.js` — onde o `swagger-ui-express`
    // coloca o documento — é lido do outro lado do socket.
    const page = await fetch(`${BASE_URL}/api-docs/`);
    expect(page.status).toBe(200);

    const init = await fetch(`${BASE_URL}/api-docs/swagger-ui-init.js`);
    expect(init.status).toBe(200);
    const source = await init.text();

    // O `swagger-ui-init.js` é JavaScript com o documento embutido em
    // `swaggerDoc`. O corte é feito por contagem de chaves ciente de strings em
    // vez de por `indexOf('}')`: o documento tem mais de mil linhas e contain
    // texto livre (descrições com `}`), então um casamento ingênuo traria
    // metade do objeto — que é justamente o tipo de falha que um teste de
    // fumaça passaria adiante.
    const start = source.indexOf('"swaggerDoc":') + '"swaggerDoc":'.length;
    const document = JSON.parse(extractJsonObject(source, start)) as {
      info: { version: string };
      paths: Record<string, unknown>;
    };

    for (const endpoint of ['/login', '/register', '/refresh', '/logout', '/profile', '/password', '/delete']) {
      expect(Object.keys(document.paths)).toContain(endpoint);
    }
    // A versão vem do `package.json` pelo mesmo caminho do `/health`.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(document.info.version).toBe(pkg.version);
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

    // O vencedor recebe o par, mas a detecção do reuso revoga a sessão inteira.
    const winner = first.status === 200 ? first : second;
    const winnerBody = await winner.json() as { data?: { accessToken?: string; refreshToken?: string } };
    expect(winnerBody.data?.accessToken).toBeTruthy();
    expect(winnerBody.data?.refreshToken).not.toBe(refreshToken);

    const profile = await getJson('/profile', bearer(winnerBody.data?.accessToken as string));
    expect(profile.status).toBe(401);
  }, 30000);

  it('logout só com o refresh token encerra a sessão inteira', async() => {
    // Contrato do logout: o refresh token identifica a sessão. Um cliente que
    // perdeu o access token (expirou, foi rotacionado) ainda precisa encerrar a
    // sessão - e o access token que ele NÃO apresentou tem de morrer junto.
    const unique = `lo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const password = 'StrongPass123!';

    await postJson('/register', { user: unique, password });
    const loginRes = await postJson('/login', { user: unique, password });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as {
      data?: { accessToken?: string; refreshToken?: string };
    };
    const accessToken = loginBody.data?.accessToken as string;
    const refreshToken = loginBody.data?.refreshToken as string;

    // O access token funciona antes do logout...
    expect((await getJson('/profile', bearer(accessToken))).status).toBe(200);

    // ...e o logout vai SEM o header Authorization, só com o refresh token.
    const logoutRes = await postJson('/logout', { refreshToken });
    expect(logoutRes.status).toBe(200);

    // O access token que o cliente não apresentou não sobrevive ao logout.
    const afterLogout = await getJson('/profile', bearer(accessToken));
    expect(afterLogout.status).toBe(401);

    // O refresh token também não renova mais.
    expect((await postJson('/refresh', { refreshToken })).status).toBe(401);

    // Um par emitido depois do logout volta a funcionar (login novo = sessão nova).
    const reLogin = await postJson('/login', { user: unique, password });
    expect(reLogin.status).toBe(200);
    const reLoginBody = await reLogin.json() as { data?: { accessToken?: string } };
    expect((await getJson('/profile', bearer(reLoginBody.data?.accessToken as string))).status).toBe(200);
  }, 30000);

  it('logout sem nenhum token não encerra nada', async() => {
    const res = await postJson('/logout', {});
    expect(res.status).toBe(400);
    expect((await res.json() as { code?: string }).code).toBe('REVOCATION_FAILED');
  });

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
  it('reescreve hash argon2id fraco no primeiro login, sem quebrar nada', async() => {
    const unique = `reh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const password = 'StrongPass123!';

    const registerRes = await postJson('/register', { user: unique, password });
    expect(registerRes.status).toBe(201);

    // Reproduz o estado de um hash gravado com parâmetros mais fracos que os
    // em vigor, escrevendo direto no Mongo: pela API não há como produzir
    // material fora do padrão.
    const { getUserModel } = await import('../../src/infrastructure/database/models/User.js');
    const UserModel = getUserModel();
    const { hash } = await import('@node-rs/argon2');
    const legacyHash = await hash(password, {
      algorithm: 2,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1
    });

    await UserModel.updateOne({ user: unique }, { $set: { password: legacyHash } });

    const before = await UserModel.findOne({ user: unique }).select('+passwordHistory');
    expect(before?.password).toBe(legacyHash);
    const passwordChangedAtBefore = before?.passwordChangedAt;

    // Login tem de funcionar: o hash existente ainda é verificável.
    const loginRes = await postJson('/login', { user: unique, password });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { data?: { accessToken?: string } };
    expect(loginBody.data?.accessToken).toBeTruthy();

    const after = await UserModel.findOne({ user: unique }).select('+passwordHistory');
    // O hash foi reescrito nos parâmetros em vigor, sem troca de senha. Os
    // parâmetros vêm do config e não de um literal aqui: o alvo do rehash é
    // "o que está em vigor agora", então duplicar o número neste teste faria
    // ele passar com um default errado e falhar com um default certo.
    const { securityConfig } = await import('../../src/interfaces/config/appConfig.js');
    const { memoryCost, timeCost, parallelism } = securityConfig.passwordHash.argon2;
    expect(after?.password).toMatch(
      new RegExp(`^\\$argon2id\\$v=19\\$m=${memoryCost},t=${timeCost},p=${parallelism}\\$`)
    );
    expect(after?.password).not.toBe(legacyHash);
    // Reescrever não é trocar senha: histórico e data de troca ficam como estavam.
    expect(after?.passwordHistory ?? []).toEqual(before?.passwordHistory ?? []);
    expect(after?.passwordChangedAt).toEqual(passwordChangedAtBefore);

    // E o novo hash continua sendo o hash da senha certa.
    const relogin = await postJson('/login', { user: unique, password });
    expect(relogin.status).toBe(200);
    const wrongAgain = await postJson('/login', { user: unique, password: 'WrongPass123!' });
    expect(wrongAgain.status).toBe(401);
  }, 60000);
});
