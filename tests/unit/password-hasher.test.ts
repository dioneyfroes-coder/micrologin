import { describe, it, expect } from '@jest/globals';
import bcrypt from 'bcrypt';
import { PasswordHasher } from '../../src/infrastructure/adapters/index.js';
import type { PasswordHasherOptions } from '../../src/infrastructure/adapters/index.js';

/**
 * Parâmetros minúsimos de propósito nos testes: o que está em jogo aqui é a
 * lógica de formato, versão e migração, e um argon2id com 19 MiB por operação
 * transformaria a suíte em um benchmark. O custo real está medido e documentado
 * em `docs/metricas.md`.
 */
const options = (overrides: Partial<PasswordHasherOptions> = {}): PasswordHasherOptions => ({
  algorithm: 'argon2id',
  argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 },
  bcrypt: { saltRounds: 10 },
  ...overrides
});

const PASSWORD = 'Bench#2026!x';

describe('PasswordHasher - gravar e verificar', () => {
  it('grava argon2id com os parâmetros configurados', async() => {
    const hasher = new PasswordHasher(options());
    const stored = await hasher.hash(PASSWORD);

    expect(stored).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
  });

  it('verifica a senha que gravou e rejeita as outras', async() => {
    const hasher = new PasswordHasher(options());
    const stored = await hasher.hash(PASSWORD);

    await expect(hasher.compare(PASSWORD, stored)).resolves.toBe(true);
    await expect(hasher.compare(`${PASSWORD}x`, stored)).resolves.toBe(false);
  });

  it('gera hash diferente a cada chamada (sal por hash)', async() => {
    const hasher = new PasswordHasher(options());

    expect(await hasher.hash(PASSWORD)).not.toBe(await hasher.hash(PASSWORD));
  });

  it('grava bcrypt quando o algoritmo em vigor é bcrypt (rollback)', async() => {
    const hasher = new PasswordHasher(options({ algorithm: 'bcrypt' }));
    const stored = await hasher.hash(PASSWORD);

    expect(stored).toMatch(/^\$2[aby]\$/);
    await expect(hasher.compare(PASSWORD, stored)).resolves.toBe(true);
  });

  it('verifica hash bcrypt legado sem saber de onde veio', async() => {
    // O que já está no banco foi gravado pelo BcryptAdapter antigo.
    const legacy = await bcrypt.hash(PASSWORD, 10);
    const hasher = new PasswordHasher(options());

    await expect(hasher.compare(PASSWORD, legacy)).resolves.toBe(true);
    await expect(hasher.compare('outra-senha', legacy)).resolves.toBe(false);
  });

  it('nega comparação em hash de formato desconhecido, sem estourar erro', async() => {
    const hasher = new PasswordHasher(options());

    await expect(hasher.compare(PASSWORD, 'senha-em-texto-puro')).resolves.toBe(false);
    await expect(hasher.compare(PASSWORD, '')).resolves.toBe(false);
  });
});

describe('PasswordHasher - needsRehash', () => {
  it('não pede rehash do hash no padrão atual', async() => {
    const hasher = new PasswordHasher(options());
    const stored = await hasher.hash(PASSWORD);

    expect(hasher.needsRehash(stored)).toBe(false);
  });

  it('pede rehash de hash bcrypt, que é o caso da migração', async() => {
    const hasher = new PasswordHasher(options());
    const legacy = await bcrypt.hash(PASSWORD, 10);

    expect(hasher.needsRehash(legacy)).toBe(true);
  });

  it('pede rehash quando os parâmetros argon2id estão mais fracos', async() => {
    const fraco = new PasswordHasher(options({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 } }));
    const stored = await fraco.hash(PASSWORD);

    const forte = new PasswordHasher(options({ argon2: { memoryCost: 19456, timeCost: 2, parallelism: 1 } }));

    expect(forte.needsRehash(stored)).toBe(true);
  });

  it('não pede rehash quando o hash guardado é mais forte que o configurado', async() => {
    const forte = new PasswordHasher(options({ argon2: { memoryCost: 19456, timeCost: 3, parallelism: 1 } }));
    const stored = await forte.hash(PASSWORD);

    const fraco = new PasswordHasher(options({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 } }));

    // Reescrever a cada login porque alguém segurou o custo seria o opposite
    // de endurecer: o hash guardado já é melhor que o que o serviço exige.
    expect(fraco.needsRehash(stored)).toBe(false);
  });

  it('pede rehash de hash argon2id com mais threads do que o desejado', async() => {
    const paralelo = new PasswordHasher(options({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 4 } }));
    const stored = await paralelo.hash(PASSWORD);

    const serial = new PasswordHasher(options({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 } }));

    expect(serial.needsRehash(stored)).toBe(true);
  });

  it('pede rehash de hash que ninguém consegue ler', () => {
    const hasher = new PasswordHasher(options());

    expect(hasher.needsRehash('material-ilegivel')).toBe(true);
  });
});

describe('PasswordHasher - pepper versionado', () => {
  it('grava o envelope com a versão e verifica com o segredo da versão', async() => {
    const hasher = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const stored = await hasher.hash(PASSWORD);

    expect(stored.startsWith('p1:$argon2id$')).toBe(true);
    await expect(hasher.compare(PASSWORD, stored)).resolves.toBe(true);
    await expect(hasher.compare(`${PASSWORD}x`, stored)).resolves.toBe(false);
  });

  it('falha alto quando o hash é pepperado e o serviço não tem o segredo', async() => {
    const comPepper = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const stored = await comPepper.hash(PASSWORD);

    const semPepper = new PasswordHasher(options());

    // Um "senha incorreta" aqui seria mentira útil só para o atacante: o hash
    // está íntegro, o segredo é que não está no processo. Responder 401
    // empurraria o usuário para um reset que não resolve.
    await expect(semPepper.compare(PASSWORD, stored)).rejects.toThrow(/pepper/);
  });

  it('ativa pepper sem quebrar quem ainda tem hash sem pepper', async() => {
    // Momento de ativação: a base tem hash antigo, o serviço passa a pepperar.
    const antes = new PasswordHasher(options());
    const stored = await antes.hash(PASSWORD);

    const depois = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));

    await expect(depois.compare(PASSWORD, stored)).resolves.toBe(true);
    expect(depois.needsRehash(stored)).toBe(true);
  });

  it('rotaciona o pepper sem derrubar quem não voltou a fazer login', async() => {
    const antes = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const stored = await antes.hash(PASSWORD);

    const depois = new PasswordHasher(options({
      pepper: { version: 'p2', secret: 'segredo-2' },
      previousPepper: { version: 'p1', secret: 'segredo-1' }
    }));

    await expect(depois.compare(PASSWORD, stored)).resolves.toBe(true);
    // Verificar não basta: o hash precisa voltar para o pepper em vigor.
    expect(depois.needsRehash(stored)).toBe(true);
  });

  it('falha alto em versão de pepper cujo segredo não está configurado', async() => {
    const antes = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const stored = await antes.hash(PASSWORD);

    const depois = new PasswordHasher(options({ pepper: { version: 'p2', secret: 'segredo-2' } }));

    // Dizer "senha incorreta" aqui mandaria o usuário para um reset de senha
    // que não resolve nada: o hash está certo, o segredo é que sumiu.
    await expect(depois.compare(PASSWORD, stored)).rejects.toThrow(/pepper/);
  });

  it('pede rehash quando o pepper é desligado com hashes pepperados', async() => {
    const comPepper = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const stored = await comPepper.hash(PASSWORD);

    const semPepper = new PasswordHasher(options());

    expect(semPepper.needsRehash(stored)).toBe(true);
  });

  it('o pepper entra antes do hash: o mesmo hash não serve para outra senha', async() => {
    const pepperado = new PasswordHasher(options({ pepper: { version: 'p1', secret: 'segredo-1' } }));
    const comPepper = await pepperado.hash(PASSWORD);
    const semPepper = await new PasswordHasher(options()).hash(PASSWORD);

    // Material diferente: um dump do banco não pode ser reaproveitado sem o
    // segredo, e o segredo não está no banco.
    expect(comPepper).not.toBe(semPepper);
  });
});
