/**
 * Sobe o Redis local quando ninguém está escutando em REDIS_HOST:REDIS_PORT.
 *
 * Sem Docker nesta máquina o Redis é um `redis-server` instalado à mão, e a
 * credencial do `.env` só existia na memória do processo (`ACL SETUSER`): cada
 * restart do servidor apagava o usuário e o arranque do app passava a logar
 * `Redis Error` à direita. O `secrets/redis-local.acl` é a fonte persistente,
 * reescrito aqui a partir do `.env` e recarregado a cada boot via `--aclfile`.
 *
 * Comportamento:
 *   - `SKIP_REDIS_START=true`, `REDIS_ENABLED=false` ou `REDIS_HOST` não-local
 *     → nada a fazer (exit 0); quem gerencia esse Redis é outra peça;
 *   - porta fechada → grava o ACL, spawna o `redis-server` e espera o PING;
 *   - porta aberta → só confere se o usuário do `.env` autentica, porque um
 *     Redis de fora respondendo sem esse usuário é o mesmo erro do arranque,
 *     só que reportado agora e com a causa dita.
 *
 * Uso: npm run redis:start
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACL_PATH = path.join(ROOT, 'secrets', 'redis-local.acl');
const LOG_PATH = path.join(ROOT, 'logs', 'redis-local.log');
const HOST = (process.env.REDIS_HOST || 'localhost').trim();
const PORT = Number(process.env.REDIS_PORT || 6379);
const START_TIMEOUT_MS = 15000;

const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

const skip = (message) => {
  console.log(`- ${message}`);
  process.exit(0);
};

const isLoopback = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

const readPassword = () => {
  const inline = process.env.REDIS_PASSWORD?.trim();
  const file = process.env.REDIS_PASSWORD_PATH?.trim();

  if (inline && file) {
    fail('REDIS_PASSWORD e REDIS_PASSWORD_PATH estão definidas ao mesmo tempo: use uma só');
  }

  if (inline) {
    return inline;
  }

  if (file) {
    try {
      const value = readFileSync(path.resolve(ROOT, file), 'utf8').trim();
      if (!value) {
        fail(`${file} está vazio: não há senha para o Redis`);
      }
      return value;
    } catch (error) {
      fail(`${file} não pôde ser lido: ${error.message}`);
    }
  }

  return undefined;
};

const portOpen = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const settle = (open) => {
    socket.destroy();
    resolve(open);
  };
  socket.once('connect', () => settle(true));
  socket.once('error', () => settle(false));
  socket.setTimeout(1500, () => settle(false));
});

const waitPortOpen = async (host, port) => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const verifyCredentials = async (username, password) => {
  const { createClient } = await import('redis');
  const client = createClient({
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    socket: {
      host: HOST,
      port: PORT,
      connectTimeout: 3000,
      reconnectStrategy: () => false
    }
  });
  client.on('error', () => {});
  await client.connect();
  await client.ping();
  await client.quit();
};

const writeAclFile = (username, password) => {
  writeFileSync(
    ACL_PATH,
    `user default off\r\nuser ${username} on >${password} ~* &* +@all\r\n`,
    { encoding: 'ascii' }
  );
};

if (process.env.SKIP_REDIS_START === 'true') {
  skip('SKIP_REDIS_START=true — bootstrap do Redis local desativado');
}

if (process.env.REDIS_ENABLED === 'false') {
  skip('REDIS_ENABLED=false — não há Redis a subir');
}

if (!isLoopback(HOST)) {
  skip(`REDIS_HOST=${HOST} não é local — esse Redis é gerenciado fora deste script`);
}

const username = process.env.REDIS_USERNAME?.trim() || undefined;
const password = readPassword();

if (Boolean(username) !== Boolean(password)) {
  fail('credencial incompleta: defina REDIS_USERNAME junto de REDIS_PASSWORD (ou REDIS_PASSWORD_PATH)');
}

const running = await portOpen(HOST, PORT);

if (!running) {
  if (username && password) {
    writeAclFile(username, password);
  }

  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const logFd = openSync(LOG_PATH, 'a');
  const args = ['--port', String(PORT), '--bind', '127.0.0.1', '::1'];
  if (username && password) {
    args.push('--aclfile', ACL_PATH);
  }

  const child = spawn('redis-server', args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });

  child.on('error', (error) => {
    if (error.code === 'ENOENT') {
      fail('redis-server não está no PATH. Instale (ex.: winget install taizod1024.Redis) ou suba o Redis de outra forma');
    }
    fail(`não foi possível executar redis-server: ${error.message}`);
  });

  child.unref();

  if (!(await waitPortOpen(HOST, PORT))) {
    fail(`redis-server não abriu ${HOST}:${PORT} em ${START_TIMEOUT_MS}ms — veja ${LOG_PATH}`);
  }
}

try {
  await verifyCredentials(username, password);
} catch (error) {
  fail(
    `Redis em ${HOST}:${PORT} respondeu, mas o usuário ${username || 'default'} não autenticou: ${error.message}\n` +
    'Confira REDIS_USERNAME/REDIS_PASSWORD(_PATH) no .env ou reinicie esse Redis com `npm run redis:start`'
  );
}

console.log(
  `✅ Redis local pronto em ${HOST}:${PORT}` +
  (username ? ` (usuário ${username}; ACL em ${path.relative(ROOT, ACL_PATH)})` : ' (sem credencial)')
);
