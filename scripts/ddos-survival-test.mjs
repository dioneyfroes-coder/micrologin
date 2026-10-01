#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = `https://127.0.0.1:${process.env.DDOS_PROXY_TLS_PORT || 3203}`;
const HEALTH_PATH = '/liveness';

export const isLoopbackHost = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
};

export const resolveTarget = (value = DEFAULT_BASE_URL) => {
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('DDOS_BASE_URL precisa usar http:// ou https://');
  }
  if (target.username || target.password) {
    throw new Error('DDOS_BASE_URL não pode incluir credenciais');
  }
  if (!isLoopbackHost(target.hostname)) {
    throw new Error('Alvo não local recusado. O runner DDoS completo aceita somente loopback.');
  }
  return target;
};

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

const percentile = (samples, percent = 0.95) => {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percent) - 1)] ?? 0;
};

const request = (baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs = 5000 } = {}) =>
  new Promise((resolveRequest, rejectRequest) => {
    const target = new URL(path, baseUrl);
    const isLocal = isLoopbackHost(target.hostname);
    const transport = target.protocol === 'https:' ? https : http;
    const startedAt = performance.now();
    const req = transport.request(target, {
      method,
      headers,
      timeout: timeoutMs,
      ...(target.protocol === 'https:' && isLocal ? { rejectUnauthorized: false } : {})
    }, response => {
      let responseBytes = 0;
      response.on('data', chunk => {
        responseBytes += chunk.length;
      });
      response.on('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        durationMs: performance.now() - startedAt,
        responseBytes
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms: ${target.pathname}`)));
    req.on('error', rejectRequest);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

const assertStatus = (response, allowed, label) => {
  if (!allowed.includes(response.status)) {
    throw new Error(`${label}: esperado ${allowed.join('/')} e recebido ${response.status}`);
  }
};

const checkLiveness = async(baseUrl, label) => {
  const response = await request(baseUrl, HEALTH_PATH);
  if (response.status !== 200) {
    throw new Error(`${label}: /liveness respondeu ${response.status}`);
  }
  return response.durationMs;
};

const checkReadiness = async(baseUrl, label) => {
  const response = await request(baseUrl, '/readiness');
  if (response.status !== 200) {
    throw new Error(`${label}: /readiness respondeu ${response.status}`);
  }
};

const measureLivenessP95 = async(baseUrl, samples = 20) => {
  const durations = [];
  for (let index = 0; index < samples; index++) {
    durations.push(await checkLiveness(baseUrl, 'liveness'));
  }
  return percentile(durations);
};

const readRestartCounts = (composeArgs) => {
  const containers = spawnSync('docker', [...composeArgs, 'ps', '-q', 'auth-service', 'auth-proxy', 'mongodb', 'redis'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (containers.status !== 0) {
    throw new Error(`docker compose ps falhou: ${containers.stderr || containers.error}`);
  }
  const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('Nenhum container auth-service/auth-proxy encontrado no Compose configurado');
  }

  const inspected = spawnSync('docker', [
    'inspect', '--format', '{{.Id}} {{.RestartCount}}', ...ids
  ], { cwd: ROOT, encoding: 'utf8' });
  if (inspected.status !== 0) {
    throw new Error(`docker inspect falhou: ${inspected.stderr || inspected.error}`);
  }

  return new Map(inspected.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [id, count] = line.trim().split(/\s+/);
    return [id, Number(count)];
  }));
};

const toMib = (value, unit) => {
  const number = Number(value);
  switch (unit.toLowerCase()) {
    case 'b': return number / (1024 * 1024);
    case 'kib':
    case 'kb': return number / 1024;
    case 'gib':
    case 'gb': return number * 1024;
    default: return number;
  }
};

export const parseDockerMemoryStats = (output) => {
  const values = output.split(/\r?\n/)
    .map(line => line.match(/^\S+\s+([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)\s*\//i))
    .filter(Boolean)
    .map(([, value, unit]) => toMib(value, unit));
  if (values.length === 0) {
    throw new Error('docker stats não forneceu amostras de memória');
  }
  return Math.max(...values);
};

const startMemorySampler = (containerIds) => {
  const child = spawn('docker', [
    'stats', '--format', '{{.Name}} {{.MemUsage}}', ...containerIds
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk.toString()));

  return {
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise(resolveClose => child.once('close', resolveClose));
      }
      const output = chunks.join('');
      return parseDockerMemoryStats(output);
    }
  };
};

const assertNoRestarts = (before, after) => {
  for (const [containerId, initialCount] of before) {
    const finalCount = after.get(containerId);
    if (finalCount === undefined || finalCount !== initialCount) {
      throw new Error(`RestartCount mudou no container ${containerId}: ${initialCount} -> ${finalCount ?? 'ausente'}`);
    }
  }
};

const waitForSocketClose = (socket, timeoutMs) => new Promise(resolveClose => {
  let connected = false;
  let finished = false;
  const complete = closed => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(deadline);
    socket.destroy();
    resolveClose(connected && closed);
  };
  const deadline = setTimeout(() => complete(false), timeoutMs);
  socket.once('connect', () => {
    connected = true;
  });
  socket.once('secureConnect', () => {
    connected = true;
  });
  socket.once('end', () => complete(true));
  socket.once('close', () => complete(true));
  socket.once('error', () => complete(connected));
});

const openPartialRequest = (target) => {
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const socket = target.protocol === 'https:'
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: false })
    : net.connect({ host: target.hostname, port });
  const readyEvent = target.protocol === 'https:' ? 'secureConnect' : 'connect';
  socket.once(readyEvent, () => {
    socket.write(`GET /liveness HTTP/1.1\r\nHost: ${target.host}\r\nX-Stalled: partial`);
  });
  return socket;
};

const exerciseSlowHeaders = async(target) => {
  const count = Number(process.env.DDOS_SLOWLORIS_CONNECTIONS || 20);
  const timeoutMs = Number(process.env.DDOS_SLOWLORIS_TIMEOUT_MS || 20000);
  const pending = Array.from({ length: count }, () => waitForSocketClose(openPartialRequest(target), timeoutMs));
  await sleep(150);
  await checkLiveness(target, 'liveness durante Slowloris');
  const closed = await Promise.all(pending);
  const closedCount = closed.filter(Boolean).length;
  if (closedCount !== count) {
    throw new Error(`Slowloris: ${closedCount}/${count} conexões foram fechadas no prazo de ${timeoutMs}ms`);
  }
  return closedCount;
};

const runK6Flood = ({ baseUrl, username, password, summaryPath }) => {
  const duration = process.env.DDOS_DURATION || '20s';
  const vus = process.env.DDOS_VUS || '10';
  const maxP95 = process.env.DDOS_MAX_P95_MS || '5000';
  const result = spawnSync('k6', [
    'run',
    '--summary-export', summaryPath,
    'k6/ddos-survival.js'
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      LOGIN_USER: username,
      LOGIN_PASS: password,
      DURATION: duration,
      VUS: vus,
      MAX_P95_MS: maxP95,
      INSECURE_TLS: isLoopbackHost(new URL(baseUrl).hostname) ? 'true' : 'false'
    }
  });

  if (result.error || result.status !== 0) {
    throw new Error(`k6 encerrou com código ${result.status ?? 'desconhecido'}${result.error ? `: ${result.error.message}` : ''}`);
  }
};

const assertK6Summary = (summaryPath) => {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const rateLimited = summary.metrics?.ddos_rate_limited?.values?.count ?? 0;
  const livenessFailures = summary.metrics?.ddos_liveness_failures?.values?.count ?? 0;
  const serverErrors = summary.metrics?.ddos_server_errors?.values?.count ?? 0;
  if (rateLimited < 1) {
    throw new Error('k6 não observou 429; os limites de borda/rate limit não engajaram');
  }
  if (livenessFailures !== 0) {
    throw new Error(`k6 observou ${livenessFailures} falha(s) de liveness durante o flood`);
  }
  if (serverErrors >= 5) {
    throw new Error(`k6 observou ${serverErrors} respostas 5xx durante o flood`);
  }
  return { rateLimited, livenessFailures, serverErrors };
};

const runPayloadProbes = async(baseUrl) => {
  const malformed = await request(baseUrl, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"user":'
  });
  assertStatus(malformed, [400], 'JSON malformado');

  const oversizedBody = JSON.stringify({
    user: `oversized_${Date.now()}`,
    password: `Oversized_${'x'.repeat(10 * 1024 * 1024)}!Aa9`
  });
  const oversized = await request(baseUrl, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversizedBody,
    timeoutMs: 15000
  });
  assertStatus(oversized, [413], 'payload de 10MB');
  return { malformed: malformed.status, oversized: oversized.status };
};

const ensureK6User = async(baseUrl) => {
  const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const username = `ddos_${suffix}`;
  const password = `DdosSurvival_${suffix}!Aa9`;
  const response = await request(baseUrl, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: username, password })
  });
  assertStatus(response, [201], 'registro da conta descartável da execução');
  return { username, password };
};

const dockerAvailable = () => {
  const result = spawnSync('docker', ['info'], { cwd: ROOT, stdio: 'ignore' });
  return !result.error && result.status === 0;
};

const runCommand = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} falhou${result.error ? `: ${result.error.message}` : ` (código ${result.status})`}`);
  }
};

const createTemporaryStack = (tempDir) => {
  const keysDir = join(tempDir, 'jwt');
  const depsDir = join(tempDir, 'deps');
  const tlsDir = join(tempDir, 'tls');
  const appPort = process.env.DDOS_APP_PORT || '3202';
  const httpPort = process.env.DDOS_PROXY_HTTP_PORT || '3201';
  const requestedTarget = new URL(process.env.DDOS_BASE_URL || DEFAULT_BASE_URL);
  const tlsPort = process.env.DDOS_PROXY_TLS_PORT || requestedTarget.port || '3203';
  const project = `micrologin-ddos-${process.pid}`;
  const suffix = `${process.pid}`;

  mkdirSync(tlsDir, { recursive: true });
  runCommand('bash', ['scripts/generate-jwt-keys.sh', keysDir, 'ddos-v1', '--for-container']);
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
    RESILIENCE_IMAGE: `micrologin-ddos:${suffix}`,
    RESILIENCE_KEYS_DIR: keysDir,
    RESILIENCE_DEPS_DIR: depsDir,
    RESILIENCE_TLS_DIR: tlsDir,
    RESILIENCE_JWT_KID: 'ddos-v1',
    RESILIENCE_APP_CONTAINER_NAME: `${project}-app`,
    RESILIENCE_MONGO_CONTAINER_NAME: `${project}-mongo`,
    RESILIENCE_REDIS_CONTAINER_NAME: `${project}-redis`,
    RESILIENCE_PROXY_CONTAINER_NAME: `${project}-proxy`,
    RESILIENCE_TRUST_PROXY: '1',
    RESILIENCE_LOGIN_POINTS: process.env.DDOS_LOGIN_POINTS || '50',
    RESILIENCE_IP_POINTS: process.env.DDOS_IP_POINTS || '100',
    RESILIENCE_PORT: appPort,
    DDOS_PROXY_HTTP_PORT: httpPort,
    DDOS_PROXY_TLS_PORT: tlsPort
  };
  const composeArgs = ['-p', project, '--profile', 'ddos', '-f', 'docker-compose.resilience.yml'];
  return { env, composeArgs, baseUrl: process.env.DDOS_BASE_URL || `https://127.0.0.1:${tlsPort}` };
};

const waitForStack = async(baseUrl, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await checkLiveness(baseUrl, 'readiness da borda');
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Stack DDoS não ficou pronto em ${timeoutMs}ms: ${lastError?.message || 'sem resposta'}`);
};

const main = async() => {
  const requestedTarget = resolveTarget(process.env.DDOS_BASE_URL || DEFAULT_BASE_URL);

  if (process.argv.includes('--preflight-only')) {
    const baseUrl = requestedTarget.toString().replace(/\/$/, '');
    console.log(`Alvo aceito: ${baseUrl}`);
    return;
  }

  if (!dockerAvailable()) {
    throw new Error('Docker CLI/daemon indisponível; execute em host com Docker Compose v2.');
  }
  if (spawnSync('k6', ['version'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
    throw new Error('k6 não encontrado; instale k6 no host antes de executar a suíte.');
  }
  if (spawnSync('bash', ['--version'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
    throw new Error('bash não encontrado; é necessário para os scripts de provisão efêmera.');
  }
  if (spawnSync('openssl', ['version'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
    throw new Error('openssl não encontrado; é necessário para o certificado efêmero do proxy.');
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'micrologin-ddos-'));
  const summaryPath = resolve(tempDir, 'k6-summary.json');
  let stack;
  let stackAttempted = false;
  let memorySampler;

  try {
    stack = createTemporaryStack(tempDir);
    stackAttempted = true;
    runCommand('docker', ['compose', ...stack.composeArgs, 'up', '-d', '--build'], stack.env);
    const target = resolveTarget(stack.baseUrl);
    const baseUrl = target.toString().replace(/\/$/, '');
    await waitForStack(baseUrl);
    await checkReadiness(baseUrl, 'stack antes dos ataques');
    const restartsBefore = readRestartCounts(['compose', ...stack.composeArgs]);
    memorySampler = startMemorySampler([...restartsBefore.keys()]);
    const baselineP95 = await measureLivenessP95(baseUrl);
    const account = await ensureK6User(baseUrl);
    const payloadResults = await runPayloadProbes(baseUrl);

    runK6Flood({ baseUrl, ...account, summaryPath });
    const k6Metrics = assertK6Summary(summaryPath);
    const slowlorisConnectionsClosed = await exerciseSlowHeaders(target);
    const recoveryP95 = await measureLivenessP95(baseUrl);
    await checkReadiness(baseUrl, 'stack após os ataques');
    const absoluteRecoveryLimit = Number(process.env.DDOS_RECOVERY_P95_MS || 1000);
    const baselineRecoveryLimit = Math.max(baselineP95 * 2, baselineP95 + 100);
    const recoveryLimit = Math.min(absoluteRecoveryLimit, baselineRecoveryLimit);
    if (recoveryP95 > recoveryLimit) {
      throw new Error(
        `Recuperação p95 ${recoveryP95.toFixed(1)}ms excede limite ${recoveryLimit.toFixed(1)}ms ` +
        `(baseline ${baselineP95.toFixed(1)}ms, teto absoluto ${absoluteRecoveryLimit}ms)`
      );
    }

    const peakContainerMemoryMiB = await memorySampler.stop();
    memorySampler = undefined;
    const maxMemoryMiB = Number(process.env.DDOS_MAX_CONTAINER_MEMORY_MIB || 950);
    if (peakContainerMemoryMiB > maxMemoryMiB) {
      throw new Error(`Pico de memória ${peakContainerMemoryMiB.toFixed(1)}MiB excede limite ${maxMemoryMiB}MiB`);
    }

    const restartsAfter = readRestartCounts(['compose', ...stack.composeArgs]);
    assertNoRestarts(restartsBefore, restartsAfter);

    console.log(JSON.stringify({
      result: 'passed',
      baseUrl,
      baselineLivenessP95Ms: Number(baselineP95.toFixed(1)),
      recoveryLivenessP95Ms: Number(recoveryP95.toFixed(1)),
      rateLimited: k6Metrics.rateLimited,
      livenessFailures: k6Metrics.livenessFailures,
      serverErrors: k6Metrics.serverErrors,
      payloadResults,
      slowlorisConnectionsClosed,
      peakContainerMemoryMiB: Number(peakContainerMemoryMiB.toFixed(1)),
      containerRestarts: 0
    }, null, 2));
  } finally {
    if (memorySampler) {
      await memorySampler.stop().catch(() => {});
    }
    if (stackAttempted && stack) {
      spawnSync('docker', ['compose', ...stack.composeArgs, 'down', '-v', '--remove-orphans'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: stack.env
      });
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[ddos-survival] ${error.message}`);
    process.exitCode = 1;
  });
}