import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parser do rastro de GC da medicao de capacidade (Fase 3.2, P8).
 *
 * A decisao de teto de heap da fase -- fixar `--max-old-space-size` ou registrar
 * que nao se fixa -- sai de uma unica tabela: quantas coletadas houve, quanto
 * tempo elas tiraram do event loop e qual era a heap no instante de cada uma.
 * Se o parser subcontar, a fase escreve um numero que ninguem mediu: e o caso
 * perigoso, porque a leituraerrada e sempre no sentido de "esta tudo bem".
 *
 * Por que o teste chama o `scripts/capacity-summary.py` em vez de reimplementar
 * a regex em TypeScript: a regex que decide o numero e a do Python. Um teste
 * sobre uma copia passaria verde enquanto o parser real quebrasse -- foi
 * exatamente o que aconteceu com a primeira versao, que nao casava com
 * `Mark-Compact (reduce)` e deixava 2 de 33 linhas fora da conta sem avisar.
 *
 * As linhas de fixture sao literais do stdout do Node 22 com `--trace-gc`,
 * incluindo as duas variantes que a primeira versao da regex perdia:
 * `Scavenge (interleaved)` e `Mark-Compact (reduce)`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PARSER = resolve(ROOT, 'scripts/capacity-summary.py');

const SCAVENGE =
  '[7:0x717187504000]     1236 ms: Scavenge 38.4 (44.1) -> 37.8 (45.9) MB, pooled: 0 MB, 1.71 / 0.00 ms  (average mu = 0.991, current mu = 0.992) allocation failure; ';
const SCAVENGE_INTERLEAVED =
  '[7:0x717187504000]     1258 ms: Scavenge (interleaved) 43.0 (49.4) -> 42.2 (50.9) MB, pooled: 0 MB, 1.44 / 0.00 ms  (average mu = 0.991, current mu = 0.992) task; ';
const MARK_SWEEP =
  '[7:0x717187504000]     1270 ms: Mark-sweep 44.0 (52.0) -> 31.5 (47.0) MB, pooled: 0 MB, 6.02 / 0.00 ms  (average mu = 0.991, current mu = 0.991) allocation failure; ';
const MARK_COMPACT =
  '[7:0x717187504000]     1282 ms: Mark-Compact 42.5 (51.1) -> 30.4 (47.9) MB, pooled: 3 MB, 2.48 / 0.00 ms  (+ 0.7 ms in 0 steps since start of marking, biggest step 0.0 ms, walltime since start of marking 26 ms) (average mu = 0.989, current mu = 0.982) finalize incremental marking via task; GC in old space requested';
const MARK_COMPACT_REDUCE =
  '[7:0x73e9b3629000]     9686 ms: Mark-Compact (reduce) 31.7 (47.6) -> 30.8 (33.6) MB, pooled: 0 MB, 10.07 / 0.01 ms  (+ 11.2 ms in 0 steps since start of marking, biggest step 0.0 ms, walltime since start of marking 29 ms) (average mu = 0.989, current mu = 0.989) reduce memory footprint; ';

const parseWith = (lines: string[]) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gc-parse-'));
  try {
    const log = resolve(dir, 'gc_w1_login_v400.log');
    writeFileSync(log, lines.join('\n') + '\n', 'utf-8');
    const out = execFileSync(
      'python3',
      ['-c', [
        'import importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(PARSER)})`,
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        `print(json.dumps(mod.parse_gc(${JSON.stringify(log)})))`
      ].join('\n')],
      { encoding: 'utf-8' }
    );
    return JSON.parse(out.trim()) as {
      gc: number;
      scavenge: number;
      mark: number;
      pause_ms: number;
      pause_max_ms: number;
      heap_before_max: number;
      heap_after_max: number;
      unparsed: number;
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('parser do rastro de GC da medicao de capacidade', () => {
  it('conta toda linha do rastro, inclusive as variantes com modificador', () => {
    const r = parseWith([
      SCAVENGE,
      SCAVENGE_INTERLEAVED,
      MARK_SWEEP,
      MARK_COMPACT,
      MARK_COMPACT_REDUCE
    ]);

    expect(r.gc).toBe(5);
    expect(r.unparsed).toBe(0);
  });

  it('separa scavenge de mark: o teto de old-space so responde pelo mark', () => {
    const r = parseWith([
      SCAVENGE,
      SCAVENGE_INTERLEAVED,
      MARK_SWEEP,
      MARK_COMPACT_REDUCE
    ]);

    expect(r.scavenge).toBe(2);
    expect(r.mark).toBe(2);
  });

  it('soma a pausa e guarda a maior pausa, que e o que aparece no p99', () => {
    const r = parseWith([SCAVENGE, MARK_SWEEP, MARK_COMPACT_REDUCE]);

    // 1.71 + 6.02 + 10.07
    expect(r.pause_ms).toBe(17.8);
    expect(r.pause_max_ms).toBe(10.07);
  });

  it('guarda a heap antes e depois de cada coleta, que e o dente de serra', () => {
    const r = parseWith([SCAVENGE, MARK_COMPACT]);

    // O maior `before` e o do Mark-Compact (42.5), nao o do Scavenge (38.4):
    // ordenar por tipo daria o numero errado do pico.
    expect(r.heap_before_max).toBe(42.5);
    expect(r.heap_after_max).toBe(37.8);
  });

  it('conta linha que nao casa em vez de fingir que a corrida nao coletou', () => {
    // Uma linha de GC truncada (log cortado pelo limite de rotacao do
    // docker) tem que aparecer como `unparsed`: e o que impede a tabela de
    // ler "0 coletadas" onde houve coleta.
    const r = parseWith([SCAVENGE, '[7:0x717187504000]  9999 ms: Mark-Compa']);

    expect(r.gc).toBe(1);
    expect(r.unparsed).toBe(1);
  });

  it('nao some com a contagem quando as duas metades da linha tem numeros parecidos', () => {
    // A pausa da linha completa do Mark-Compact e `2.48 / 0.00 ms`, e o
    // trecho `(+ 0.7 ms in 0 steps ...)` tambem tem "ms" perto de numero.
    // Sem ancorar no `MB,` que vem logo antes, a regex casa o trecho errado e
    // a pausa sai 0.7 em vez de 2.48 -- e pela metade errada para o lado que
    // faz a coleta parecer barata.
    // O parser arredonda a soma para 1 casa, como a tabela mostra.
    const r = parseWith([MARK_COMPACT]);

    expect(r.pause_ms).toBe(2.5);
  });

  it('separa por processo: com 2 workers as contas nao podem virar uma so', () => {
    const outroProcesso = SCAVENGE.replace('[7:0x717187504000]', '[9:0x717187504100]');
    const r = parseWith([SCAVENGE, outroProcesso, MARK_SWEEP]);

    expect(r.gc).toBe(3);
    // `pause_ms` e a soma dos processos: o event loop de cada um para na sua
    // vez, e a soma e o que consome CPU do container. 1.71 + 1.71 + 6.02.
    expect(r.pause_ms).toBe(9.4);
  });
});
