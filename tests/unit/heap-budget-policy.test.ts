import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Teto de heap por processo (Fase 3.2, P8).
 *
 * A medição de 400 VUs (docs/metricas.md, seção 7) mostrou que o processo não
 * cresce: o pico de heap antes de uma coleta fica em 66 MB e o que sobra logo
 * depois é ~30 MB, em todos os quatro endpoints. O teto de 512 MB sai daí, com
 * duas propriedades que o teste fixa:
 *
 *   1. cabe com folga: 512 MB é 7,7× o pico medido e ~17× o conjunto vivo;
 *   2. fecha o orçamento: o RSS de pico do `/login` é 377 MB, dos quais ~317 MB
 *      são memória NATIVA do argon2 (fora do heap). 512 + 317 = 829 MB fica
 *      dentro do teto de 1 GiB do container -- com teto maior, um estouro de
 *      heap bateria no OOM killer do cgroup (SIGKILL, sem log) em vez de virar
 *      `ERR_heap_out_of_memory` (que diz o que aconteceu).
 *
 * Por que um teste para isto: o número aparece em três arquivos (compose de
 * produção, override de medição e `ecosystem.config.cjs`), e cada um deles é
 * lido por um caminho diferente em runtime. Um deles divergir não quebraria
 * nada visível -- a medição passaria a rodar com teto diferente do de
 * produção, ou o PM2 passaria a usar o teto implícito do V8 -- e a Fase 3.2
 * publicaria uma memória que ninguém está usando.
 *
 * Ler YAML e o arquivo do PM2 de verdade, em vez de grep: um valor comentado
 * ou uma flag fora do bloco `env` passariam por "está no arquivo".
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

// --- O dado medido. Fonte: docs/metricas.md, seção "Heap e GC sob carga".
const PICO_HEAP_MB = 66;
const CONJUNTO_VIVO_MB = 30;
const RSS_PICO_LOGIN_MB = 377;
const LIMITE_CONTAINER_MB = 1024;

const CAP = readCapFromCompose();
const MEDICAO = readCapFromCompose('docker-compose.capacity.yml');
const ECOSYSTEM = readCapFromEcosystem();

function readCapFromCompose(file = 'docker-compose.prod.yml'): number {
  const compose = load(readFileSync(resolve(ROOT, file), 'utf-8')) as {
    services: Record<string, { environment: Record<string, string> }>;
  };
  const nodeOptions = compose.services['auth-service'].environment.NODE_OPTIONS;

  if (!nodeOptions) {
    throw new Error(`${file}: auth-service sem NODE_OPTIONS`);
  }
  const match = /--max-old-space-size=(\d+)/.exec(nodeOptions);
  if (!match) {
    throw new Error(
      `${file}: NODE_OPTIONS sem --max-old-space-size (veio "${nodeOptions}")`
    );
  }
  return Number(match[1]);
}

function readCapFromEcosystem(): number[] {
  const app = (require_(resolve(ROOT, 'ecosystem.config.cjs')) as {
    apps: { env: Record<string, string>; env_production: Record<string, string> }[];
  }).apps[0];

  return [app.env, app.env_production].map((block, i) => {
    const match = /--max-old-space-size=(\d+)/.exec(block.NODE_OPTIONS ?? '');
    if (!match) {
      throw new Error(
        `ecosystem.config.cjs: bloco ${i === 0 ? 'env' : 'env_production'} ` +
          'sem --max-old-space-size em NODE_OPTIONS'
      );
    }
    return Number(match[1]);
  });
}

describe('teto de heap por processo', () => {
  it('é o mesmo número nos três lugares que o processo lê', () => {
    expect({ prod: CAP, medicao: MEDICAO, pm2: ECOSYSTEM[0] }).toEqual({
      prod: CAP,
      medicao: CAP,
      pm2: CAP
    });
    expect(ECOSYSTEM[1]).toBe(CAP);
  });

  it('cabe com folga sobre o pico medido, para não virar esteiro de OOM', () => {
    expect(CAP).toBeGreaterThan(PICO_HEAP_MB);
    // Quatro vezes o conjunto vivo: abaixo disso o teto vira a causa da queda
    // em vez de ser a rede de proteção. Medido em 400 VUs, onde 30 MB é o que
    // sobra depois de um mark-compact.
    expect(CAP).toBeGreaterThanOrEqual(4 * CONJUNTO_VIVO_MB);
  });

  it('deixa o pior caso dentro do teto do container, contando a memória nativa', () => {
    // A memória do argon2 é `external`/nativa: `--max-old-space-size` não a
    // limita, e é a maior parte do RSS de pico. A conta que fecha o orçamento
    // é teto + nativo, não teto.
    const piorCaso = CAP + (RSS_PICO_LOGIN_MB - PICO_HEAP_MB);
    expect(piorCaso).toBeLessThanOrEqual(LIMITE_CONTAINER_MB);
    // E com folga de verdade: 10% do limite é o que sobra para stack de
    // chamadas, buffers do V8 e o RSS que a soma de topo não mede.
    expect(piorCaso).toBeLessThanOrEqual(LIMITE_CONTAINER_MB * 0.9);
  });

  it('a medição de capacidade roda com o teto de produção, e não com o do V8', () => {
    // O `environment` do override vence o `environment` do compose de produção.
    // Default vazio aqui apagaria o teto e a matriz mediria um serviço que
    // ninguém opera -- foi o que aconteceu na primeira versão deste override.
    expect(MEDICAO).toBe(CAP);
  });

  it('o número publicado em docs/metricas.md é o mesmo que o configurado', () => {
    // Documento e configuração não podem divergir: o doc é o que o leitor
    // acredita, e a config é o que roda.
    const doc = readFileSync(resolve(ROOT, 'docs/metricas.md'), 'utf-8');

    expect(doc).toContain(`--max-old-space-size=${CAP}`);
    expect(doc).toContain(`${PICO_HEAP_MB} MB`);
  });
});
