/**
 * Mede o p50/p95 de /login contra o serviço no ar, com credenciais válidas.
 *
 * Existe para ter o número de verdade da fronteira HTTP: o benchmark de hash
 * mede a operação, este mede o que o usuário espera. São coisas diferentes — há
 * Mongo, Redis, JSON, HMAC de token e I/O no meio do caminho.
 *
 * Uso:
 *   node scripts/measure-login-latency.mjs --url http://localhost:3000 \
 *     --user mede_bench --password '...' [--requests 20] [--concurrency 1,4,8]
 *
 * A senha vem por argumento e o script não a imprime. Para serviço real, use
 * variável de ambiente: LOGIN_BENCH_PASSWORD.
 */
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const BASE_URL = argValue('url', 'http://localhost:3000');
const USERNAME = argValue('user', 'mede_bench');
const PASSWORD = argValue('password', process.env.LOGIN_BENCH_PASSWORD);
const TOTAL_REQUESTS = Number(argValue('requests', '20'));
const CONCURRENCIES = argValue('concurrency', '1,4,8')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

if (!PASSWORD) {
  console.error('informe --password ou LOGIN_BENCH_PASSWORD');
  process.exit(2);
}

const ms = (value) => value.toFixed(1);
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

const loginOnce = async () => {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: USERNAME, password: PASSWORD })
  });
  const body = await response.json().catch(() => null);
  const elapsed = performance.now() - started;

  if (response.status !== 200) {
    throw new Error(`/login respondeu ${response.status}: ${JSON.stringify(body)}`);
  }

  return elapsed;
};

/**
 * Logins simultâneos de verdade: cada requisição é uma requisição, e o tempo é
 * medido do lado de quem pediu. Uma média por lote esconderia a fila que o
 * usuário sente.
 */
const measure = async (concurrency) => {
  const samples = [];
  let index = 0;
  let failures = 0;

  const worker = async () => {
    while (index < TOTAL_REQUESTS) {
      index += 1;
      try {
        samples.push(await loginOnce());
      } catch (error) {
        failures += 1;
        if (failures === 1) {
          console.error(`falha na requisição: ${error.message}`);
        }
      }
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wall = performance.now() - startedAt;

  return {
    concurrency,
    samples,
    failures,
    wall,
    throughput: samples.length / (wall / 1000)
  };
};

const run = async () => {
  // Um login só, para pagar a conexão e a primeira compilação de JIT fora da
  // amostra: a versão medida é a segunda em diante.
  await loginOnce();

  console.log(`Alvo: ${BASE_URL}/login (usuário ${USERNAME})`);
  console.log(`${TOTAL_REQUESTS} logins válidos por nível, após 1 de aquecimento`);

  for (const concurrency of CONCURRENCIES) {
    const result = await measure(concurrency);
    const { samples } = result;

    if (samples.length === 0) {
      console.error(
        `nenhuma requisição de login passou em c=${concurrency}. ` +
        'Se a resposta foi 429, o limitador de /login está no caminho: ' +
        'suba-o para a medição (RATE_LIMIT_PROD_LOGIN_POINTS) e devolva o valor depois.'
      );
      process.exit(1);
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const max = Math.max(...samples);

    console.log(
      `c=${concurrency}: p50 ${ms(p50)} ms | p95 ${ms(p95)} ms | max ${ms(max)} ms | ` +
      `${result.throughput.toFixed(1)} logins/s | falhas ${result.failures}`
    );
  }
};

run().catch((error) => {
  console.error(`medição falhou: ${error.message}`);
  process.exit(1);
});
