#!/usr/bin/env node
/**
 * Prova de sessão compartilhada entre réplicas (Fase 4.3).
 *
 * O que a Fase 4 promete é que réplicas atrás do proxy compartilham sessão:
 * o que uma revoga, a outra obedece. A prova de contrato até aqui rodava com
 * instâncias de JWT e Redis em memória — o que não diz nada sobre os
 * containers, que é onde o estado compartilhado pode divergir (Redis
 * diferente por réplica, versão de sessão lida de outro lugar, `INSTANCE_ID`
 * confundindo identidade com sessão).
 *
 * A montagem é a mesma do runner de DDoS (`ddos`), porque é a única topologia
 * do projeto com mais de uma réplica atrás do nginx: três containers
 * `auth-service` sem `container_name`, um proxy TLS com DNS dinâmico, e o
 * mesmo Redis e Mongo para as três.
 *
 * O caminho é o inverso do round-robin: em vez de contar PIDs para provar que
 * o proxy distribui, fixa **uma** réplica e pergunta a **outras** se o token
 * emitido na primeira continua válido depois de revogado na primeira. Se o
 * proxy não distribui, o teste passa por acidente — por isso ele afirma,
 * antes, que mais de uma réplica foi alcançada.
 *
 * Cada verificação fala com a réplica pelo IP interno, sem passar pelo proxy.
 * Endereçar a réplica é o que torna isto uma prova de estado compartilhado e
 * não de round-robin: o mesmo request contra a URL do proxy cairia em
 * qualquer réplica e a negativa observada não diria nada.
 *
 * Uso:
 *   node scripts/replica-session-test.mjs
 *   REPLICA_MIN_REPLICAS=3 node scripts/replica-session-test.mjs
 *   node scripts/replica-session-test.mjs --preflight-only
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveTarget, isLoopbackHost } from './ddos-survival-test.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TLS_PORT = '3213';

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

const request = (baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs = 10000, agent } = {}) =>
  new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(path, baseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method,
      headers,
      ...(agent === undefined ? {} : { agent }),
      timeout: timeoutMs,
      ...(target.protocol === 'https:' && isLoopbackHost(target.hostname) ? { rejectUnauthorized: false } : {})
    }, res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk;
      });
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms: ${target.pathname}`)));
    req.on('error', rejectRequest);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

const json = (baseUrl, path, payload, extraHeaders = {}) => request(baseUrl, path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(payload)
});

const readTokens = (body) => {
  try {
    const parsed = JSON.parse(body);
    return {
      accessToken: parsed.data?.accessToken ?? parsed.accessToken,
      refreshToken: parsed.data?.refreshToken ?? parsed.refreshToken
    };
  } catch {
    return { accessToken: undefined, refreshToken: undefined };
  }
};

export const readReplicaIdentity = (body) => {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return undefined;
  }
  const identity = parsed?.service?.instance_id;
  return typeof identity === 'string' && identity.length > 0 ? identity : undefined;
};

/**
 * Endereços internos das réplicas.
 *
 * `docker inspect` é a fonte, e não o Compose: o mapeamento precisa estar
 * correto no container de quem pergunta, e o Compose resolve `auth-service`
 * para o DNS interno — que já é a resposta que o nginx usa.
 */
const resolveReplicaAddresses = (composeArgs, env) => {
  const containers = spawnSync('docker', ['compose', ...composeArgs, 'ps', '-q', 'auth-service'], {
    cwd: ROOT,
    encoding: 'utf8',
    env
  });
  const ids = (containers.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      'nenhuma réplica auth-service encontrada ' +
      `(status ${containers.status}, stderr ${containers.stderr?.trim() || 'vazio'})`
    );
  }

  const inspected = spawnSync('docker', [
    'inspect', '--format', '{{.Name}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', ...ids
  ], { cwd: ROOT, encoding: 'utf8', env });

  return (inspected.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, ip] = line.split('\t');
    return { container: name.replace(/^\//, ''), ip };
  }).filter(entry => entry.ip);
};

const runCommand = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} falhou${result.error ? `: ${result.error.message}` : ` (código ${result.status})`}`);
  }
};

/**
 * Espera o proxy alcançar pelo menos `minimum` réplicas distintas.
 *
 * Retry porque resolver DNS no nginx é assíncrono: o `valid=10s` do
 * `resolver` significa que uma réplica que subiu depois do primeiro refresh
 * só entra no upstream algum tempo depois. Testar no primeiro instante daria
 * falso negativo.
 */
const waitForReplicas = async(baseUrl, minimum, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    for (let index = 0; index < 12; index++) {
      try {
        const response = await request(baseUrl, '/observability', {
          headers: { Connection: 'close' },
          agent: false,
          timeoutMs: 3000
        });
        if (response.status === 200) {
          const identity = readReplicaIdentity(response.body);
          if (identity !== undefined) {
            seen.add(identity);
          }
        }
      } catch {
        // Uma sondagem perdida durante a convergência é esperada; o deadline
        // é quem decide se o stack falhou.
      }
    }
    if (seen.size >= minimum) {
      return seen;
    }
    await sleep(2000);
  }
  throw new Error(`o proxy alcançou ${seen.size} réplica(s) distintas em ${timeoutMs}ms; precisávamos de ${minimum}`);
};

const waitForReadiness = async(baseUrl, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await request(baseUrl, '/readiness')).status === 200) {
        return;
      }
    } catch {
      // Idem: o container ainda está subindo.
    }
    await sleep(1000);
  }
  throw new Error(`stack não ficou pronto em ${timeoutMs}ms`);
};

/**
 * Mínimo de réplicas distintas que o proxy precisa alcançar para o teste valer.
 *
 * O piso é 2, e não 1: com uma única réplica no upstream toda a prova passa —
 * o token é aceito, revogado e aceito de novo — sem que nada seja
 * compartilhado. Um piso mal configurado por quem invoca o script transformaria
 * o teste numa tautologia em vez de em uma prova.
 */
export const resolveMinimumReplicas = (env = process.env) => {
  const raw = env.REPLICA_MIN_REPLICAS;
  if (raw === undefined || raw === '') {
    return 2;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 2) {
    throw new Error(`REPLICA_MIN_REPLICAS precisa ser um inteiro >= 2; recebido ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const main = async() => {
  const port = process.env.REPLICA_TLS_PORT || DEFAULT_TLS_PORT;
  const requestedTarget = resolveTarget(process.env.DDOS_BASE_URL || `https://127.0.0.1:${port}`);

  if (process.argv.includes('--preflight-only')) {
    console.log(`Alvo aceito: ${requestedTarget.toString().replace(/\/$/, '')}`);
    return;
  }

  if (spawnSync('docker', ['info'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker CLI/daemon indisponível; execute em host com Docker Compose v2.');
  }
  // `bash --version` sai com código 1 em algumas instalações, o que faz a
  // checagem por status confundir "presente" com "ausente". Existence é o que
  // interessa aqui: quem chama já falha na invocação se faltar.
  for (const binary of ['bash', 'openssl']) {
    if (spawnSync('sh', ['-c', `command -v ${binary}`], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
      throw new Error(`${binary} não encontrado; é necessário para provisionar o material do teste.`);
    }
  }

  const minimumReplicas = resolveMinimumReplicas(process.env);
  const replicasWanted = Number(process.env.REPLICA_COUNT || 3);
  const tempDir = mkdtempSync(join(tmpdir(), 'micrologin-replicas-'));
  const keysDir = join(tempDir, 'jwt');
  const depsDir = join(tempDir, 'deps');
  const tlsDir = join(tempDir, 'tls');
  const project = `micrologin-replicas-${process.pid}`;
  const httpPort = process.env.REPLICA_HTTP_PORT || String(Number(port) - 12);

  mkdirSync(tlsDir, { recursive: true });
  runCommand('bash', ['scripts/generate-jwt-keys.sh', keysDir, 'replica-v1', '--for-container']);
  runCommand('bash', ['scripts/generate-dependency-secrets.sh', depsDir, '--for-container', '--skip-verify']);
  runCommand('openssl', [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '2',
    '-keyout', join(tlsDir, 'privkey.pem'),
    '-out', join(tlsDir, 'fullchain.pem'),
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ]);
  chmodSync(join(tlsDir, 'privkey.pem'), 0o600);

  const env = {
    ...process.env,
    RESILIENCE_IMAGE: `micrologin-replicas:${process.pid}`,
    RESILIENCE_KEYS_DIR: keysDir,
    RESILIENCE_DEPS_DIR: depsDir,
    RESILIENCE_TLS_DIR: tlsDir,
    RESILIENCE_JWT_KID: 'replica-v1',
    RESILIENCE_MONGO_CONTAINER_NAME: `${project}-mongo`,
    RESILIENCE_REDIS_CONTAINER_NAME: `${project}-redis`,
    RESILIENCE_PROXY_CONTAINER_NAME: `${project}-proxy`,
    RESILIENCE_TRUST_PROXY: '1',
    // Limite folgado: este teste faz logins em sequência e o limite de
    // produção (5 por 15min) transformaria uma prova de sessão em um 429.
    RESILIENCE_LOGIN_POINTS: '500',
    RESILIENCE_IP_POINTS: '500',
    DDOS_PROXY_HTTP_PORT: httpPort,
    DDOS_PROXY_TLS_PORT: port
  };
  const composeArgs = ['-p', project, '--profile', 'ddos', '-f', 'docker-compose.resilience.yml'];
  let stackAttempted = false;

  try {
    stackAttempted = true;
    runCommand('docker', [
      'compose', ...composeArgs, 'up', '-d', '--build',
      '--scale', `auth-service=${replicasWanted}`
    ], env);

    const baseUrl = requestedTarget.toString().replace(/\/$/, '');
    await waitForReadiness(baseUrl);

    const identities = await waitForReplicas(baseUrl, minimumReplicas);
    console.log(`✅ ${identities.size} réplica(s) distinta(s) alcançadas pelo proxy: ${[...identities].join(', ')}`);

    const addresses = resolveReplicaAddresses(composeArgs, env);
    if (addresses.length < minimumReplicas) {
      throw new Error(`só ${addresses.length} réplica(s) com endereço interno; precisávamos de ${minimumReplicas}`);
    }
    const directUrl = address => `http://${address.ip}:3000`;

    // --- Login pelo proxy -------------------------------------------------
    const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`;
    const username = `replica_${suffix}`;
    const password = `ReplicaSession_${suffix}!Aa9`;
    const novaSenha = `ReplicaRotated_${suffix}!Aa9`;

    const registered = await json(baseUrl, '/register', { user: username, password });
    if (registered.status !== 201) {
      throw new Error(`registro respondeu ${registered.status}: ${registered.body.slice(0, 200)}`);
    }

    const login = await json(baseUrl, '/login', { user: username, password });
    if (login.status !== 200) {
      throw new Error(`login respondeu ${login.status}: ${login.body.slice(0, 200)}`);
    }
    const { accessToken, refreshToken } = readTokens(login.body);
    if (!accessToken || !refreshToken) {
      throw new Error('login não devolveu par de tokens');
    }

    // Enquanto ninguém revoga, TODAS as réplicas aceitam o token. Sem esta
    // etapa a negativa seguinte seria por motivo errado: chave ES256
    // divergente entre réplicas também produz 401, e o teste passaria por
    // um motivo que não é revogação.
    for (const address of addresses) {
      const profile = await request(directUrl(address), '/profile', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (profile.status !== 200) {
        throw new Error(
          `réplica ${address.container} recusou o token válido com ${profile.status}; ` +
          'as chaves ou o estado não são compartilhados entre réplicas'
        );
      }
    }
    console.log(`✅ token aceito nas ${addresses.length} réplicas antes de revogar (chave ES256 compartilhada)`);

    // --- Logout pelo proxy ------------------------------------------------
    // Vai pela borda de propósito: é o caminho que o cliente usa, e prova que
    // a resposta do proxy não mascara uma revogação parcial.
    const logout = await json(baseUrl, '/logout', { refreshToken });
    if (logout.status !== 200) {
      throw new Error(`logout pelo proxy respondeu ${logout.status}: ${logout.body.slice(0, 200)}`);
    }

    for (const address of addresses) {
      const profile = await request(directUrl(address), '/profile', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (profile.status !== 401) {
        throw new Error(
          `após o logout, a réplica ${address.container} respondeu ${profile.status} para token revogado; ` +
          'a revogação não atravessou as réplicas'
        );
      }
    }
    console.log(`✅ logout pelo proxy invalidou o access token em todas as ${addresses.length} réplicas`);

    const replay = await json(baseUrl, '/refresh', { refreshToken });
    if (replay.status !== 401) {
      throw new Error(`refresh roubado após logout respondeu ${replay.status}; esperado 401`);
    }
    console.log('✅ refresh token roubado após logout continua recusado (401)');

    // --- Troca de senha: revogação por identidade, outra rota -------------
    // Passa por um caminho diferente do logout (versão de sessão em vez de
    // blacklist do `jti`). As duas formas de revogar compartilham o Redis e
    // quebram em lugares diferentes; testar só uma deixaria a outra sem
    // prova.
    const relogin = await json(baseUrl, '/login', { user: username, password });
    const { accessToken: accessAntigo, refreshToken: refreshAntigo } = readTokens(relogin.body);
    if (!accessAntigo) {
      throw new Error(`relogin respondeu ${relogin.status}: ${relogin.body.slice(0, 200)}`);
    }

    const changed = await request(baseUrl, '/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessAntigo}` },
      body: JSON.stringify({ currentPassword: password, newPassword: novaSenha })
    });
    if (changed.status !== 200) {
      throw new Error(`troca de senha respondeu ${changed.status}: ${changed.body.slice(0, 200)}`);
    }

    for (const address of addresses) {
      const profile = await request(directUrl(address), '/profile', {
        headers: { Authorization: `Bearer ${accessAntigo}` }
      });
      if (profile.status !== 401) {
        throw new Error(
          `após a troca de senha, a réplica ${address.container} respondeu ${profile.status}; ` +
          'a invalidação por versão de sessão não atravessou as réplicas'
        );
      }
    }
    console.log(`✅ troca de senha invalidou o access token antigo nas ${addresses.length} réplicas`);

    // A sessão nova funciona, e o refresh antigo também não. Sem isso a
    // revogação anterior seria indistinguível de um no-op, e "todas recusaram"
    // passaria mesmo com a revogação desligada.
    const novoLogin = await json(baseUrl, '/login', { user: username, password: novaSenha });
    if (novoLogin.status !== 200) {
      throw new Error(`login com a senha nova respondeu ${novoLogin.status}`);
    }
    const { accessToken: vivoAccess } = readTokens(novoLogin.body);
    if (!vivoAccess) {
      throw new Error('login com a senha nova não devolveu access token');
    }
    for (const address of addresses) {
      const profile = await request(directUrl(address), '/profile', {
        headers: { Authorization: `Bearer ${vivoAccess}` }
      });
      if (profile.status !== 200) {
        throw new Error(`a sessão nova foi recusada pela réplica ${address.container} com ${profile.status}`);
      }
    }
    console.log(`✅ a sessão pós-troca funciona nas ${addresses.length} réplicas (a revogação não é um no-op)`);

    await json(baseUrl, '/logout', { refreshToken: refreshAntigo });

    console.log(JSON.stringify({
      result: 'passed',
      replicasStarted: replicasWanted,
      replicasObservedThroughProxy: identities.size,
      replicasAddressedDirectly: addresses.length,
      sharedSigningKeyBeforeRevocation: true,
      logoutThroughProxyRevokedEverywhere: true,
      passwordChangeRevokedEverywhere: true,
      newSessionAcceptedEverywhere: true,
      stolenRefreshAfterLogout: 401
    }, null, 2));
  } finally {
    if (stackAttempted) {
      spawnSync('docker', ['compose', ...composeArgs, 'down', '-v', '--remove-orphans'], {
        cwd: ROOT,
        stdio: 'inherit',
        env
      });
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[replica-session] ${error.message}`);
    process.exitCode = 1;
  });
}