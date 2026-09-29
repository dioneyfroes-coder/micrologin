import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prova que o que a provisionação grava é o que o Redis e o Mongo entendem.
 *
 * O defeito que originou este teste foi um marcador de hash errado na ACL:
 * `>#<sha256>` é aceito sem erro pelo Redis e significa "senha em texto claro
 * igual a #...". O script se autoconferia (o arquivo tinha o formato que ele
 * mesmo esperava) e o serviço subia; a primeira operação que precisava de dado
 * morria com WRONGPASS. Aqui a conferência é externa ao script: o SHA-256 é
 * recalculado a partir da senha entregue, do lado do teste.
 *
 * `--skip-verify` porque a prova ao vivo da ACL depende de docker; ela é feita
 * pelo `scripts/infra-resilience-test.sh`, que sobe o stack inteiro.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(ROOT, 'scripts/generate-dependency-secrets.sh');

const runScript = (args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
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

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'deps-secrets-'));

const FILES = ['mongo-root-password', 'mongo-app-password', 'redis-password', 'redis-app.acl'];

describe('provisionamento dos segredos das dependências', () => {
  it('gera os quatro arquivos com senhas longas e ACL coerente', () => {
    const dir = freshDir();
    const result = runScript([dir, '--skip-verify']);

    expect(result.status).toBe(0);

    for (const file of FILES) {
      const stats = statSync(join(dir, file));
      expect(stats.mode & 0o777).toBe(0o600);
    }

    const redisPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    const mongoAppPassword = readFileSync(join(dir, 'mongo-app-password'), 'utf8');
    expect(redisPassword.length).toBeGreaterThanOrEqual(32);
    expect(mongoAppPassword.length).toBeGreaterThanOrEqual(32);
  });

  it('grava na ACL o SHA-256 da senha entregue, sem a senha em texto claro', () => {
    const dir = freshDir();
    expect(runScript([dir, '--skip-verify']).status).toBe(0);

    const redisPassword = readFileSync(join(dir, 'redis-password'), 'utf8');
    const acl = readFileSync(join(dir, 'redis-app.acl'), 'utf8');

    const expected = createHash('sha256').update(redisPassword).digest('hex');

    // `#<sha256>`: o `#` sozinho é o marcador do hash. `>#<sha256>` seria lido
    // como senha em texto claro — o bug que o script agora recusa.
    expect(acl).toContain(`user auth-service on #${expected}`);
    expect(acl).not.toContain(`>#${expected}`);
    expect(acl).not.toContain(redisPassword);
  });

  it('desliga o usuário default: conexão anônima precisa ser recusada', () => {
    const dir = freshDir();
    expect(runScript([dir, '--skip-verify']).status).toBe(0);

    const acl = readFileSync(join(dir, 'redis-app.acl'), 'utf8');

    expect(acl).toContain('user default off');
  });

  it('recusa sobrescrever material existente: rotacionar é deliberado', () => {
    const dir = freshDir();
    expect(runScript([dir, '--skip-verify']).status).toBe(0);

    const second = runScript([dir, '--skip-verify']);

    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('ja existe');
  });

  it('recusa argumento desconhecido em vez de gerar material pela metade', () => {
    const dir = freshDir();
    const result = runScript([dir, '--inventado']);

    expect(result.status).toBe(2);
    expect(() => statSync(join(dir, 'redis-password'))).toThrow();
  });

  it('o uid do app no script acompanha o nodeuser do Dockerfile', () => {
    // O `--for-container` entrega a senha para o uid que roda o app na imagem.
    // Se o Dockerfile mudar de uid e o script não acompanhar, o app deixa de
    // ler a própria senha — falha que só aparece no container.
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    const uid = /adduser\s+-S\s+\S+\s+-u\s+(\d+)/.exec(dockerfile)?.[1];

    expect(uid).toBeDefined();
    expect(readFileSync(SCRIPT, 'utf8')).toContain('DEPS_APP_UID:-' + uid);
  });
});
