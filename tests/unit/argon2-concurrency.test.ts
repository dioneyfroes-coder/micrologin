import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';

/**
 * Prova de que o limite de concorrência do argon2id é REAL.
 *
 * Este arquivo mede a simultaneidade no limite de baixo para cima — na
 * chamada a `argon2Hash`/`argon2Verify` da biblioteca, por dentro do hasher — e
 * não no semáforo. A diferença é o ponto inteiro do teste:
 *
 * - medir no semáforo passa mesmo quando o hasher deixou de usá-lo, porque o
 *   semáforo continuaria reportando o próprio contador, que ninguém mais
 *   consulta;
 * - medir na chamada da biblioteca mede o que de fato ocupa memória.
 *
 * Por isso `runArgon2` não é um ponto de extensão: se alguém removê-lo do
 * `PasswordHasher` para "simplificar", este arquivo reprova.
 *
 * O envelope de instrumentação fica em volta da função real, não em volta de
 * uma substituta: se o mock devolvesse um hash falso, o hasher operaria sobre
 * uma entrada que não é argon2id e o teste passaria sem exercitar nada.
 */

type Argon2Module = typeof import('@node-rs/argon2');

let inFlight = 0;
let peak = 0;

const track = async<T>(operation: () => Promise<T>): Promise<T> => {
  inFlight++;
  if (inFlight > peak) {
    peak = inFlight;
  }
  try {
    return await operation();
  } finally {
    inFlight--;
  }
};

jest.unstable_mockModule('@node-rs/argon2', async() => {
  const actual = await jest.requireActual<Argon2Module>('@node-rs/argon2');

  return {
    ...actual,
    hash: (password: string, options?: unknown) => track(() => actual.hash(password, options as never)),
    verify: (hash: string, password: string) => track(() => actual.verify(hash, password))
  };
});

const { PasswordHasher } = await import('../../src/infrastructure/adapters/index.js');
const {
  configureArgon2Limiter,
  argon2Snapshot,
  resetArgon2Metrics
} = await import('../../src/shared/utils/argon2Limiter.js');

const LIMIT = 4;

/**
 * 8 MiB por hash: barato o bastante para 32 operações caberem no teste, e
 * caro o bastante para as operações realmente durarem tempo — sem duração real
 * a medição de pico não teria o que observar.
 */
const hasher = (): PasswordHasher => new PasswordHasher({
  algorithm: 'argon2id',
  argon2: { memoryCost: 8192, timeCost: 2, parallelism: 1 }
});

const strongPassword = (index: number): string => `SenhaForte#${index}aA1`;

beforeAll(() => {
  configureArgon2Limiter({ limit: LIMIT, maxQueue: 256 });
});

beforeEach(() => {
  inFlight = 0;
  peak = 0;
  // A contabilidade é do processo e cumulativa; sem zerar, o segundo teste
  // leria a soma do primeiro e a contagem de admitidas não diria nada.
  resetArgon2Metrics();
});

describe('Limite real de concorrência do argon2id', () => {
  it('nunca supera o limite com 48 hashes disparados em paralelo', async() => {
    const service = hasher();

    await Promise.all(
      Array.from({ length: 48 }, (_, index) => service.hash(strongPassword(index)))
    );

    expect(peak).toBeLessThanOrEqual(LIMIT);
    expect(peak).toBeGreaterThan(1);
    expect(argon2Snapshot().high_water_mark).toBeLessThanOrEqual(LIMIT);
  }, 30000);

  it('hash e verify passam pelo MESMO limite', async() => {
    const service = hasher();
    const existing = strongPassword(0);
    const stored = await service.hash(existing);

    inFlight = 0;
    peak = 0;

    // Metade grava, metade verifica: são operações de argon2id idênticas em
    // custo de memória. Se `verify` não passasse pelo mesmo mecanismo, o teto
    // seria inútil e a mistura passaria de LIMIT com folga.
    const work: Array<Promise<unknown>> = [];
    for (let index = 1; index <= 47; index++) {
      work.push(service.hash(strongPassword(index)));
      work.push(service.compare(existing, stored));
    }

    await Promise.all(work);

    expect(peak).toBeLessThanOrEqual(LIMIT);
  }, 30000);

  it('o teto NÃO é o do inFlight: o limite de hash é independente', async() => {
    const service = hasher();

    await Promise.all(
      Array.from({ length: 48 }, (_, index) => service.hash(strongPassword(index)))
    );

    const snapshot = argon2Snapshot();
    // 48 requisições em andamento com um teto de hash de 4: as duas defesas
    // coexistem e medem coisas diferentes. Se os dois números everdessem, um
    // deles teria deixado de existir.
    expect(snapshot.admitted).toBe(48);
    expect(snapshot.high_water_mark).toBe(LIMIT);
    expect(snapshot.waited).toBeGreaterThan(0);
  }, 30000);

  it('o limite aplicado é o que o orçamento de memória aprovou', async() => {
    configureArgon2Limiter({ limit: 2, maxQueue: 32 });
    const service = hasher();

    peak = 0;
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => service.hash(strongPassword(index)))
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(argon2Snapshot().limit).toBe(2);
  }, 30000);

  it('retomar o teto maior depois de um teto menor não deixa contador preso', async() => {
    configureArgon2Limiter({ limit: 2, maxQueue: 32 });
    const service = hasher();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => service.hash(strongPassword(index)))
    );
    expect(argon2Snapshot().current).toBe(0);

    configureArgon2Limiter({ limit: LIMIT, maxQueue: 256 });

    peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => service.hash(strongPassword(index)))
    );

    expect(peak).toBeLessThanOrEqual(LIMIT);
    expect(argon2Snapshot().current).toBe(0);
  }, 30000);

  it('hash continua correto depois de passar pela fila', async() => {
    configureArgon2Limiter({ limit: LIMIT, maxQueue: 256 });
    const service = hasher();

    const hashes = await Promise.all(
      Array.from({ length: 16 }, (_, index) => service.hash(strongPassword(index)))
    );

    for (let index = 0; index < hashes.length; index++) {
      expect(hashes[index]).toMatch(/^\$argon2id\$/);
      await expect(service.compare(strongPassword(index), hashes[index])).resolves.toBe(true);
      await expect(service.compare('senha-errada', hashes[index])).resolves.toBe(false);
    }
  }, 30000);
});
