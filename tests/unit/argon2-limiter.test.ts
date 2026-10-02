import { describe, it, expect } from '@jest/globals';
import {
  Argon2Limiter,
  Argon2OverloadedError,
  DEFAULT_ARGON2_CONCURRENCY
} from '../../src/shared/utils/argon2Limiter.js';

/**
 * O semáforo de argon2id só serve para uma coisa: nunca existir mais de `limit`
 * operações ao mesmo tempo. Tudo aqui existe para travar essa invariante, e
 * três das propriedades são justamente as que quebram quando alguém "simplifica"
 * o limiter:
 *
 *  1. teto respeitado sob concorrência real;
 *  2. fila que esvazia — um semáforo que vaza vagas deixa de limitar depois do
 *     primeiro pico, e o sintoma (memória subindo) só aparece em produção;
 *  3. fila cheia RECUSA, em vez de acumular sem limite.
 */

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('Argon2Limiter - teto de simultaneidade', () => {
  it('nunca executa mais que o limite ao mesmo tempo', async() => {
    const limiter = new Argon2Limiter({ limit: 3, maxQueue: 100 });

    let inFlight = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 40 }, async() => {
      await limiter.run(async() => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight--;
      });
    }));

    expect(peak).toBe(3);
    expect(limiter.getSnapshot().high_water_mark).toBe(3);
  });

  it('o limite 1 serializa tudo', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 100 });

    let concurrent = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 10 }, async() => {
      await limiter.run(async() => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await tick(1);
        concurrent--;
      });
    }));

    expect(peak).toBe(1);
  });

  it('devolve o valor da operação', async() => {
    const limiter = new Argon2Limiter({ limit: 2 });
    await expect(limiter.run(async() => 'hash-ok')).resolves.toBe('hash-ok');
  });

  it('libera a vaga mesmo quando a operação rejeita', async() => {
    const limiter = new Argon2Limiter({ limit: 1 });

    await expect(limiter.run(async() => {
      throw new Error('argon2 explodiu');
    })).rejects.toThrow('argon2 explodiu');

    // Uma vaga presa transformaria todo login seguinte em 503, para sempre.
    await expect(limiter.run(async() => 'recuperado')).resolves.toBe('recuperado');
    expect(limiter.getSnapshot().current).toBe(0);
  });

  it('libera a vaga quando a operação rejeita dentro de uma fila', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 10 });

    const failing = limiter.run(async() => {
      await tick(1);
      throw new Error('falha');
    });
    const following = limiter.run(async() => 'ok');

    await expect(failing).rejects.toThrow('falha');
    await expect(following).resolves.toBe('ok');
    expect(limiter.getSnapshot().current).toBe(0);
    expect(limiter.getSnapshot().queued).toBe(0);
  });

  it('default é 8, o valor que a conta de memória orça', () => {
    expect(DEFAULT_ARGON2_CONCURRENCY).toBe(8);
  });
});

describe('Argon2Limiter - fila', () => {
  it('a fila de espera absorve o excedente sem recusar', async() => {
    const limiter = new Argon2Limiter({ limit: 2, maxQueue: 50 });

    const results = await Promise.all(Array.from({ length: 20 }, async(_, index) => (
      limiter.run(async() => {
        await tick(1);
        return index;
      })
    )));

    expect(results).toHaveLength(20);
    expect(limiter.getSnapshot().rejected).toBe(0);
    expect(limiter.getSnapshot().waited).toBeGreaterThan(0);
  });

  it('recusa com ARGON2_OVERLOADED quando a fila enche', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 2 });

    const accepted = [
      limiter.run(() => tick(10).then(() => 'a')),
      limiter.run(() => tick(10).then(() => 'b')),
      limiter.run(() => tick(10).then(() => 'c'))
    ];
    const refused = limiter.run(() => tick(10).then(() => 'd'));

    await expect(refused).rejects.toBeInstanceOf(Argon2OverloadedError);
    await expect(Promise.all(accepted)).resolves.toEqual(['a', 'b', 'c']);
    expect(limiter.getSnapshot().rejected).toBe(1);
  });

  it('o erro de saturação carrega o código que a fronteira HTTP usa', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 0 });

    // Precisa ser concorrente: awaited em sequência, a segunda operação já
    // encontraria a vaga livre e o teto nunca seria encostado. O `catch` é
    // imediato de propósito — sem ele, a rejeição fica órfã entre a criação e o
    // `await`, e o processo a reporta como unhandled em vez de falha de teste.
    const running = limiter.run(() => tick(5));
    const refused = limiter.run(() => tick(5)).then(
      () => null,
      (error: unknown) => error
    );

    await expect(running).resolves.toBeUndefined();
    expect(await refused).toMatchObject({ code: 'ARGON2_OVERLOADED' });
  });

  it('a fila esvazia por completo depois do pico', async() => {
    const limiter = new Argon2Limiter({ limit: 2, maxQueue: 50 });

    await Promise.all(Array.from({ length: 30 }, () => limiter.run(() => tick(1))));

    const snapshot = limiter.getSnapshot();
    expect(snapshot.queued).toBe(0);
    expect(snapshot.current).toBe(0);
    expect(snapshot.max_queued_observed).toBeGreaterThan(0);
  });

  it('a fila é FIFO: ninguém espera mais do que o trabalho que já está na frente', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 50 });
    const order: number[] = [];

    await Promise.all(Array.from({ length: 8 }, async(_, index) => {
      await limiter.run(async() => {
        order.push(index);
        await tick(2);
      });
    }));

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('Argon2Limiter - contabilidade', () => {
  it('contabiliza admitidas, esperas e recusas', async() => {
    const limiter = new Argon2Limiter({ limit: 1, maxQueue: 2 });

    await Promise.all([
      limiter.run(() => tick(5)),
      limiter.run(() => tick(5)),
      limiter.run(() => tick(5))
    ]);

    const snapshot = limiter.getSnapshot();
    expect(snapshot.admitted).toBe(3);
    expect(snapshot.waited).toBe(2);
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.limit).toBe(1);
  });

  it('resetMetrics zera a contagem sem liberar quem está em andamento', async() => {
    const limiter = new Argon2Limiter({ limit: 2 });

    await Promise.all(Array.from({ length: 5 }, () => limiter.run(() => tick(1))));
    limiter.resetMetrics();

    const snapshot = limiter.getSnapshot();
    expect(snapshot.admitted).toBe(0);
    expect(snapshot.waited).toBe(0);
    expect(snapshot.high_water_mark).toBe(0);
  });

  it('resetMetrics preserva quem ainda está em andamento', async() => {
    const limiter = new Argon2Limiter({ limit: 4 });
    const running = limiter.run(() => tick(10));
    limiter.resetMetrics();

    expect(limiter.getSnapshot().current).toBe(1);
    await running;
  });

  it('limit 0 não limita (desligamento explícito)', async() => {
    const limiter = new Argon2Limiter({ limit: 0, maxQueue: 0 });

    let concurrent = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 12 }, async() => {
      await limiter.run(async() => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await tick(2);
        concurrent--;
      });
    }));

    expect(peak).toBeGreaterThan(1);
  });
});
