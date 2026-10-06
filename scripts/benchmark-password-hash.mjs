#!/usr/bin/env node
/**
 * @fileoverview Benchmark de hash de senha: o custo real, nesta máquina
 *
 * A escolha dos parâmetros do argon2id não pode ser tomada de tabela: o que
 * importa é quanto o hash custa *aqui*, no caminho de login, e quanto custa
 * *dentro do limite do container* (2.0 CPU / 512 MB em
 * `docker-compose.prod.yml`). Um parâmetro que a OWASP recomenda e que cabe
 * folgado numa VM de 8 núcleos pode derrubar o serviço no orçamento que este
 * serviço tem.
 *
 * Por isso o script mede três coisas que tabelas não dão:
 *
 *   1. custo isolado de `hash` e `verify` por candidato (p50/p95, ops/s);
 *   2. o mesmo custo com logins concorrentes — argon2id usa várias threads por
 *      hash, então o que importa não é o tempo de um login e sim a fila que ele
 *      forma com os outros;
 *   3. a memória realmente reservada, porque `m=64MiB` × concorrência é a
 *      diferença entre caber em 512 MB e trocar o serviço por OOM.
 *
 * Uso:
 *   node scripts/benchmark-password-hash.mjs [--json] [--iterations 30]
 *                                            [--concurrency 1,2,4]
 *
 * Modo interno (não usar direto): `--child <nomedocandidato> <n>` roda um
 * único candidato `n` vezes em um processo limpo e imprime o pico de RSS do
 * processo. O pico tem de vir de um processo isolado porque `memoryUsage().rss`
 * já volta ao normal quando o argon2 devolve a memória, e a amostragem no
 * laço mede o vazio em vez do pico.
 *
 * Rodar dentro do container (é o número que vale):
 *   docker run --rm --cpus 2.0 --memory 512m -v "$PWD/scripts:/bench:ro" \
 *     node:24-alpine sh -c 'cd /tmp && npm i @node-rs/argon2 \
 *     --no-audit --no-fund --silent && node /bench/benchmark-password-hash.mjs'
 *
 * O script mede só argon2id: o bcrypt saiu do projeto depois de a decisão D16,
 * e manter a dependência viva só para reexecutar uma comparação já feita
 * custaria uma dependência que não pertence mais ao serviço. Os números do
 * bcrypt que embasaram a decisão estão preservados em `docs/metricas.md`.
 */

import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cpus } from 'node:os';
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

const argv = process.argv.slice(2);
const asFlag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const ITERATIONS = Number(asFlag('iterations', '30'));
const CONCURRENCIES = asFlag('concurrency', '1,2,4').split(',').map(Number);
const AS_JSON = argv.includes('--json');
const PASSWORD = 'R3sil-Bench-2026-Aa!';

// Mede uma função. Warm-up fora da amostra: a primeira chamada paga JIT, aloca
// e, no argon2 nativo, carrega a biblioteca — tudo que não acontece em produção
// e que inflaria o p95 com um número que ninguém vai ver.
const measure = async(fn, iterations) => {
  for (let i = 0; i < 3; i += 1) {
    await fn();
  }

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  samples.sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    min: samples[0],
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples[samples.length - 1],
    mean: sum / samples.length
  };
};

function percentile(sorted, percent) {
  if (sorted.length === 0) {
    return 0;
  }
  const position = Math.ceil((percent / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(position, 0), sorted.length - 1)];
}

const peakRssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

/**
 * Pico de RSS de um candidato, medido em processo separado.
 *
 * `process.resourceUsage().maxRSS` é a marca d'água do processo (em KB no
 * Linux), então só vale em um processo que fez só aquela operação. Além disso,
 * `m=64MiB` × N logins simultâneos é aritmética de OOM, não de latência: o que
 * decide se o serviço continua vivo é o pico somado.
 */
const probeMemoryMb = (candidateName, concurrent) => {
  const result = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, '--child', candidateName, String(concurrent)],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    return null;
  }
  return Number(result.stdout.trim());
};

// Pepper (D17): um HMAC antes do hash. Não é caro — o custo é de duas passadas
// de SHA-256 sobre uma senha de ~20 bytes. Está no benchmark para medir em vez
// de supor.
const withPepper = (password, pepper) => createHmac('sha256', pepper).update(password).digest('base64');

/**
 * Candidatos. Os nomes são os que a documentação usa, para que a tabela do
 * benchmark possa ser colada na decisão sem renomear nada.
 *
 * Os candidatos argon2id cobrem a escada da OWASP (Password Storage Cheat
 * Sheet): 46 MiB/t=1, 19 MiB/t=2, 12 MiB/t=3 — mesma defesa, memória trocada
 * por tempo. O último é o que o roadmap propôs, e está aqui para mostrar o que
 * essa proposta custa neste serviço.
 */
const candidates = [
  {
    name: 'argon2id OWASP forte',
    detail: 'm=46MiB, t=1, p=1',
    hash: () => argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 47104, timeCost: 1, parallelism: 1 }),
    verify: (stored) => argon2Verify(stored, PASSWORD, { algorithm: Algorithm.Argon2id })
  },
  {
    name: 'argon2id OWASP mínimo',
    detail: 'm=19MiB, t=2, p=1',
    hash: () => argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    verify: (stored) => argon2Verify(stored, PASSWORD, { algorithm: Algorithm.Argon2id })
  },
  {
    name: 'argon2id OWASP mínimo + pepper',
    detail: 'm=19MiB, t=2, p=1',
    hash: () => argon2Hash(withPepper(PASSWORD, 'pepper-de-benchmark'), { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    verify: (stored) => argon2Verify(stored, withPepper(PASSWORD, 'pepper-de-benchmark'), { algorithm: Algorithm.Argon2id })
  },
  {
    name: 'argon2id OWASP econômico',
    detail: 'm=12MiB, t=3, p=1',
    hash: () => argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 12288, timeCost: 3, parallelism: 1 }),
    verify: (stored) => argon2Verify(stored, PASSWORD, { algorithm: Algorithm.Argon2id })
  },
  {
    name: 'argon2id 64MiB (roadmap)',
    detail: 'm=64MiB, t=3, p=1 — p=1 separado para isolar o custo da memória',
    hash: () => argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }),
    verify: (stored) => argon2Verify(stored, PASSWORD, { algorithm: Algorithm.Argon2id })
  },
  {
    name: 'argon2id 64MiB t=3 p=4 (roadmap)',
    detail: 'm=64MiB, t=3, p=4 — usa 4 threads por hash',
    hash: () => argon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }),
    verify: (stored) => argon2Verify(stored, PASSWORD, { algorithm: Algorithm.Argon2id })
  }
];

/**
 * Um "login" é verify + (o hash de reescrita que o serviço faria ao migrar o
 * usuário para o algoritmo novo). Medir só o verify daria metade da verdade:
 * quem migra paga os dois.
 */
const simulateLogin = async(candidate, stored) => {
  const ok = await candidate.verify(stored);
  if (!ok) {
    throw new Error('verify falhou para senha correta: o candidato mediria um caminho morto');
  }
  await candidate.hash();
};

/**
 * Processo filho: um candidato, N hashes concorrentes, e só o pico de RSS.
 * Existe porque o pico precisa vir de um processo que não fez mais nada — o
 * número colado no relatório é esse, não o RSS do processo do benchmark.
 */
const runChild = async(candidateName, concurrent) => {
  const candidate = candidates.find((item) => item.name === candidateName);
  if (!candidate) {
    console.error(`candidato desconhecido: ${candidateName}`);
    process.exit(2);
  }

  const stored = await candidate.hash();
  await Promise.all(Array.from({ length: concurrent }, () => candidate.verify(stored)));
  await Promise.all(Array.from({ length: concurrent }, () => candidate.hash()));

  process.stdout.write(String(Math.round(process.resourceUsage().maxRSS / 1024)));
};

const run = async() => {
  const results = [];

  for (const candidate of candidates) {
    const stored = await candidate.hash();
    const rssBefore = peakRssMb();

    const hashStats = await measure(() => candidate.hash(), ITERATIONS);
    const verifyStats = await measure(() => candidate.verify(stored), ITERATIONS);
    const loginStats = await measure(() => simulateLogin(candidate, stored), Math.max(5, Math.floor(ITERATIONS / 3)));

    const concurrent = {};
    for (const level of CONCURRENCIES) {
      // Roda `level` logins por vez, várias rodadas, e mede o tempo de CADA
      // requisição do ponto de vista de quem a fez. É assim que a fila aparece:
      // a média isolada esconde a contenção.
      const perRequest = [];
      const rounds = Math.max(3, Math.floor(ITERATIONS / 2));
      for (let round = 0; round < rounds; round += 1) {
        const started = process.hrtime.bigint();
        await Promise.all(Array.from({ length: level }, () => simulateLogin(candidate, stored)));
        perRequest.push(Number(process.hrtime.bigint() - started) / 1e6 / level);
      }
      perRequest.sort((a, b) => a - b);
      concurrent[`p${level}`] = {
        p50: percentile(perRequest, 50),
        p95: percentile(perRequest, 95),
        throughput: Math.round((level * rounds) / (perRequest.reduce((t, v) => t + v, 0) / 1000))
      };
    }

    // Pico de RSS com 1 e com 4 logins ao mesmo tempo, cada medido em um
    // processo limpo. `m=64MiB` × 4 é a conta que decide se o container de
    // 512 MB sobrevive a um pico de logins.
    const memoryMb = {
      single: probeMemoryMb(candidate.name, 1),
      four: probeMemoryMb(candidate.name, 4)
    };

    results.push({
      name: candidate.name,
      detail: candidate.detail,
      prefix: stored.slice(0, 7),
      hashMs: hashStats,
      verifyMs: verifyStats,
      loginMs: loginStats,
      concurrent,
      memoryMb,
      rssMb: peakRssMb(),
      rssDeltaMb: peakRssMb() - rssBefore
    });
  }

  // Correção, antes de medir: um candidato que "ganha" por não comparar nada,
  // ou por devolver valor determinístico (sem sal), não é candidato.
  const [probe] = candidates;
  const stored = await probe.hash();
  if (!(await probe.verify(stored)) || (await probe.verify(`${stored}x`))) {
    throw new Error('verify do candidato de controle não distingue senha certa de errada');
  }
  if (await probe.hash() === stored) {
    throw new Error('hash devolveu valor determinístico: sem sal, a verificação não protege');
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ iterations: ITERATIONS, cpus: CONCURRENCIES, results }, null, 2));
    return;
  }

  const ms = (value) => `${value.toFixed(1)}`;
  console.log(`\nAmbiente: ${process.platform}/${process.arch}, node ${process.version}, CPUs ${cpus().length}`);
  console.log(`Iterações: ${ITERATIONS} por amostra (após 3 de warm-up)\n`);
  console.log('| candidato | hash p50 | hash p95 | verify p50 | login(verify+rehash) p95 | pico RSS x1 | pico RSS x4 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    console.log(
      `| ${result.name} | ${ms(result.hashMs.p50)} ms | ${ms(result.hashMs.p95)} ms | ` +
      `${ms(result.verifyMs.p50)} ms | ${ms(result.loginMs.p95)} ms | ` +
      `${result.memoryMb.single} MB | ${result.memoryMb.four} MB |`
    );
  }

  console.log('\nLogins concorrentes (ms por requisição, do ponto de vista de quem pediu):\n');
  for (const level of CONCURRENCIES) {
    console.log(`Concorrência ${level}:`);
    console.log('| candidato | p50 | p95 | logins/s |');
    console.log('| --- | --- | --- | --- |');
    for (const result of results) {
      const data = result.concurrent[`p${level}`];
      console.log(`| ${result.name} | ${ms(data.p50)} ms | ${ms(data.p95)} ms | ${data.throughput} |`);
    }
    console.log('');
  }
};

const childIndex = argv.indexOf('--child');
if (childIndex !== -1) {
  runChild(argv[childIndex + 1], Number(argv[childIndex + 2] || '1')).catch((error) => {
    console.error(`child falhou: ${error.message}`);
    process.exit(1);
  });
} else {
  run().catch((error) => {
    console.error(`benchmark falhou: ${error.message}`);
    process.exit(1);
  });
}
