import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret } from '../../src/interfaces/config/secret.js';

/**
 * `readSecret` é a única porta por onde senha de dependência entra no app.
 * Três estados precisam ser distinguíveis:
 *
 *   - não configurado (`undefined`): nada obriga, e a validação decide;
 *   - configurado e legível (`ok: true`): o valor chega ao driver;
 *   - configurado e ilegível (`ok: false`): falha de provisionamento, que
 *     precisa derrubar o arranque em vez de virar "senha não configurada".
 *
 * Confundir o terceiro com o primeiro é o defeito que estes testes travam: o
 * app subiria dizendo que falta senha quando o arquivo está ali e o que falta
 * é permissão.
 */

const originalEnv = { ...process.env };

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'secret-'));

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('readSecret', () => {
  it('lê o valor da variável de ambiente', () => {
    process.env.SEGREDO_TESTE = 'valor-da-variavel';

    expect(readSecret('SEGREDO_TESTE')).toEqual({ ok: true, value: 'valor-da-variavel' });
  });

  it('lê o valor de arquivo e remove o newline que o provisionamento deixa', () => {
    const dir = freshDir();
    const file = join(dir, 'senha');
    writeFileSync(file, 'senha-do-arquivo\n');
    process.env.SEGREDO_TESTE_PATH = file;

    expect(readSecret('SEGREDO_TESTE')).toEqual({ ok: true, value: 'senha-do-arquivo' });
  });

  it('recusa as duas fontes ao mesmo tempo em vez de escolher uma', () => {
    process.env.SEGREDO_TESTE = 'da-variavel';
    process.env.SEGREDO_TESTE_PATH = '/qualquer/caminho';

    const result = readSecret('SEGREDO_TESTE');

    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.error).toMatch(/SEGREDO_TESTE e SEGREDO_TESTE_PATH/);
  });

  it('devolve undefined quando não está configurado', () => {
    expect(readSecret('SEGREDO_TESTE')).toBeUndefined();
  });

  it('devolve undefined quando a variável está vazia', () => {
    process.env.SEGREDO_TESTE = '';

    expect(readSecret('SEGREDO_TESTE')).toBeUndefined();
  });

  it('distingue arquivo ilegível de arquivo inexistente', () => {
    process.env.SEGREDO_TESTE_PATH = '/caminho/que/nao/existe/senha';

    const result = readSecret('SEGREDO_TESTE');

    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.error).toMatch(/arquivo não encontrado/);
  });
});
