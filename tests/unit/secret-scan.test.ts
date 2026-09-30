import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A verificação de segredo (`npm run test:secrets`) é um portão: só vale alguma
 * coisa se fechar. Estes testes existem por causa de um defeito real dela — o
 * filtro de `.env*` usava `grep -nE '^[A-Z0-9_]*…'`, e o `-n` prefixa `148:`
 * na linha, o que quebra a âncora `^`. O resultado era uma checagem que não
 * achava nada e portanto nunca falhava, inclusive com um segredo plantado.
 *
 * Um portão que não fecha é pior que nenhum portão: dá a impressão de que
 * fecha. Então o teste aqui não é "o script roda", é "o script falha quando
 * precisa falhar" — com o segredo plantado de verdade, num repositório
 * descartável, para não depender do estado do repositório de desenvolvimento.
 *
 * `SECRET_SCAN_SKIP_GITLEAKS=1` porque a parte de conteúdo e histórico exige
 * docker e varre o histórico inteiro: ela é exercitada no CI de verdade, e aqui
 * o que precisa ser provado é o portão de arquivo e de `.env*`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN = resolve(ROOT, 'scripts/secret-scan.sh');

/**
 * Executa a CÓPIA do script dentro do repositório descartável, nunca o original.
 * O script descobre o repositório pelo próprio caminho (`dirname` do próprio
 * arquivo) e faz `cd` para lá — rodar o original apontaria a varredura para o
 * repositório de desenvolvimento, e o teste passaria olhando o lugar errado.
 */
const run = (dir: string): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('bash', [join(dir, 'scripts/secret-scan.sh')], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, SECRET_SCAN_SKIP_GITLEAKS: '1' }
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
};

/**
 * O script descobre o repositório pelo próprio caminho, então ele precisa estar
 * dentro do repositório descartável — junto do `.gitleaks.toml` e de um
 * `.env.example`, que é o arquivo sob suspeita.
 */
const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCAN, join(dir, 'scripts/secret-scan.sh'));
  chmodSync(join(dir, 'scripts/secret-scan.sh'), 0o755);
  copyFileSync(resolve(ROOT, '.gitleaks.toml'), join(dir, '.gitleaks.toml'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'teste@exemplo'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'teste'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
};

const CLEAN_ENV = [
  '# exemplo',
  'APP_PORT=3000',
  'JWT_SECRET=your-super-secret-jwt-key-with-at-least-32-chars-for-security',
  'PASSWORD_PEPPER=',
  'PASSWORD_PEPPER_VERSION=p1',
  'METRICS_TOKEN=troque-por-um-token-aleatorio',
  'JWT_ES256_PRIVATE_KEY_PATH=/run/secrets/jwt-es256-private.pem',
  ''
].join('\n');

describe('verificação de segredo versionado', () => {
  it('passa com exemplo limpo: porta, placeholder, vazio e caminho de arquivo', () => {
    const dir = repo({ '.env.example': CLEAN_ENV });

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nenhum segredo versionado');
  });

  it('reprova segredo colado no .env.example — o caso que o nome legítimo esconde', () => {
    // O arquivo é versionado e se chama `.example`, então a checagem de nome de
    // arquivo passa. Quem tem que pegar essa é a de conteúdo, e ela só pega se
    // a linha for realmente comparada com a variável.
    const dir = repo({ '.env.example': `${CLEAN_ENV}JWT_SECRET=mY9a2b7c4d1e6f3a5b8c2d9e0f4a7b3c6d\n` });

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('JWT_SECRET=mY9a2b7c4d1e6f3a5b8c2d9e0f4a7b3c6d');
  });

  it('reprova chave privada versionada, mesmo que o .gitignore peça para não versionar', () => {
    // `.gitignore` é pedido, não garantia: `git add -f` ignora. E o diretório de
    // chaves precisa existir localmente para o app rodar sem ser um problema —
    // o problema é ele estar no índice.
    const dir = repo({
      '.env.example': CLEAN_ENV,
      'keys/jwt-es256-private.pem': '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n'
    });

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('jwt-es256-private.pem');
  });

  it('reprova ACL do Redis versionada: a senha dela é o acesso inteiro ao cache', () => {
    const dir = repo({ '.env.example': CLEAN_ENV, 'redis-app.acl': 'user default off\n' });

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('redis-app.acl');
  });

  it('reprova .env versionado que não é exemplo, mesmo vazio', () => {
    // Vazio não é material secreto, mas `.env` no índice é o vetor: ele deixa de
    // ser vazio no primeiro `cp .env.example .env` com valor dentro.
    const dir = repo({ '.env.example': CLEAN_ENV, '.env': 'APP_PORT=3000\n' });

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env');
  });
});
