import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rotação das senhas das dependências (Fase 1.4).
 *
 * O defeito que justifica estes testes não é um erro de digitação: é a janela
 * de rotação. Sem os dois hashes na ACL, trocar a senha do Redis exige parar o
 * Redis e o app na ordem certa, e qualquer erro de ordem abre um intervalo em
 * que nenhuma credencial vale. A janela fecha esse intervalo, e o teste prova
 * que ela abre e fecha de verdade — não que o arquivo "parece" certo.
 *
 * `--skip-verify` porque a prova ao vivo depende de docker; ela é feita pelo
 * `scripts/infra-resilience-test.sh`, que roda contra o stack inteiro.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATE = resolve(ROOT, 'scripts/generate-dependency-secrets.sh');
const ROTATE = resolve(ROOT, 'scripts/rotate-dependency-secrets.sh');

const run = (script: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('bash', [script, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
};

const provisioned = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-rotate-'));
  const result = run(GENERATE, [dir, '--skip-verify']);
  if (result.status !== 0) {
    throw new Error(`generate falhou: ${result.stderr}`);
  }
  return dir;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('rotação dos segredos das dependências', () => {
  it('troca a senha do Redis e mantém a anterior na janela', () => {
    const dir = provisioned();
    const oldPassword = readFileSync(join(dir, 'redis-password'), 'utf8');

    const result = run(ROTATE, [dir, '--skip-verify']);
    expect(result.status).toBe(0);

    const newPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    expect(newPassword).not.toBe(oldPassword);
    expect(existsSync(join(dir, 'redis-previous-password'))).toBe(true);
    expect(readFileSync(join(dir, 'redis-previous-password'), 'utf8')).toBe(oldPassword);

    const acl = readFileSync(join(dir, 'redis-app.acl'), 'utf8');
    // A janela existe para as duas credenciais valerem ao mesmo tempo.
    expect(acl).toContain(`#${sha256(newPassword)}`);
    expect(acl).toContain(`#${sha256(oldPassword)}`);
    expect(acl).toContain('user default off');
  });

  it('a ACL guarda só os hashes, nunca as senhas em texto claro', () => {
    const dir = provisioned();
    const oldPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    expect(run(ROTATE, [dir, '--skip-verify']).status).toBe(0);

    const newPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    const acl = readFileSync(join(dir, 'redis-app.acl'), 'utf8');

    expect(acl).not.toContain(newPassword);
    expect(acl).not.toContain(oldPassword);
  });

  it('--close-window remove a senha anterior e encerra a janela', () => {
    const dir = provisioned();
    const oldPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    expect(run(ROTATE, [dir, '--skip-verify']).status).toBe(0);

    const result = run(ROTATE, [dir, '--close-window', '--skip-verify']);
    expect(result.status).toBe(0);

    const currentPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    const acl = readFileSync(join(dir, 'redis-app.acl'), 'utf8');

    expect(acl).toContain(`#${sha256(currentPassword)}`);
    expect(acl).not.toContain(`#${sha256(oldPassword)}`);
    expect(existsSync(join(dir, 'redis-previous-password'))).toBe(false);
  });

  it('mantém a senha do root do Mongo intocada: ela não é a credencial do app', () => {
    const dir = provisioned();
    const rootBefore = readFileSync(join(dir, 'mongo-root-password'), 'utf8');

    expect(run(ROTATE, [dir, '--skip-verify']).status).toBe(0);

    expect(readFileSync(join(dir, 'mongo-root-password'), 'utf8')).toBe(rootBefore);
  });

  it('não gira a senha do Mongo sem --mongo: a rotação sem janela é um ato separado', () => {
    // O Mongo não aceita duas senhas por usuário. Girar o arquivo sem trocar a
    // senha no servidor produziria um app que lê uma credencial que o banco
    // ainda não reconhece — a falha só apareceria no primeiro login depois.
    const dir = provisioned();
    const before = readFileSync(join(dir, 'mongo-app-password'), 'utf8');

    expect(run(ROTATE, [dir, '--skip-verify']).status).toBe(0);

    expect(readFileSync(join(dir, 'mongo-app-password'), 'utf8')).toBe(before);
  });

  it('com --mongo, rotaciona a senha do app no Mongo', () => {
    const dir = provisioned();
    const before = readFileSync(join(dir, 'mongo-app-password'), 'utf8');

    expect(run(ROTATE, [dir, '--mongo', '--skip-verify']).status).toBe(0);

    const after = readFileSync(join(dir, 'mongo-app-password'), 'utf8');
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThanOrEqual(32);
  });

  it('com --mongo-only, gira o Mongo e não toca na senha do Redis', () => {
    // São dois atos com ordens opostas: o Redis tem janela e não para ninguém,
    // o Mongo não tem janela nenhuma. Um comando que fizesse os dois daria a
    // ilusão de um procedimento só, e o operador acabaria reiniciando o app com
    // uma senha que o Mongo ainda não aceitou.
    const dir = provisioned();
    const redisBefore = readFileSync(join(dir, 'redis-password'), 'utf8');
    const mongoBefore = readFileSync(join(dir, 'mongo-app-password'), 'utf8');

    expect(run(ROTATE, [dir, '--mongo-only', '--skip-verify']).status).toBe(0);

    expect(readFileSync(join(dir, 'mongo-app-password'), 'utf8')).not.toBe(mongoBefore);
    expect(readFileSync(join(dir, 'redis-password'), 'utf8')).toBe(redisBefore);
  });

  it('recusa --close-window combinado com --mongo em vez de rotacionar pela metade', () => {
    // Fechar a janela não gera senha. Aceitar as duas flags e rodar só uma
    // seria o pior resultado possível: o operador acredita que girou as duas.
    const dir = provisioned();
    const before = readFileSync(join(dir, 'mongo-app-password'), 'utf8');

    const result = run(ROTATE, [dir, '--close-window', '--mongo-only', '--skip-verify']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('nao se combina');
    expect(readFileSync(join(dir, 'mongo-app-password'), 'utf8')).toBe(before);
  });

  it('o material rotacionado nasce em modo 600', () => {
    const dir = provisioned();
    expect(run(ROTATE, [dir, '--skip-verify']).status).toBe(0);

    for (const file of ['redis-password', 'redis-previous-password', 'redis-app.acl', 'mongo-app-password']) {
      const stats = statSync(join(dir, file));
      // Windows não tem permissões POSIX: o `stat().mode` reflete 0o666
      // independentemente do `chmod`. O guard de 0o600 é verificado no CI
      // (Linux); aqui a existência e a leitura dos artefatos seguem valendo.
      if (process.platform !== 'win32') {
        expect(stats.mode & 0o777).toBe(0o600);
      }
    }
  });

  it('recusa rotacionar sem material provisionado', () => {
    const empty = mkdtempSync(join(tmpdir(), 'deps-empty-'));

    const result = run(ROTATE, [empty, '--skip-verify']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nao existe');
  });

  it('recusa argumento desconhecido em vez de rotacionar pela metade', () => {
    const dir = provisioned();
    const before = readFileSync(join(dir, 'redis-password'), 'utf8');

    const result = run(ROTATE, [dir, '--inventado']);

    expect(result.status).toBe(2);
    expect(readFileSync(join(dir, 'redis-password'), 'utf8')).toBe(before);
  });
});
