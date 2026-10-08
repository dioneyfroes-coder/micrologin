import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * P0.2 — Pull request não publica imagem
 * =======================================
 *
 * O pipeline roda em `pull_request` e o `docker/build-push-action` estava com
 * `push: true` incondicional: todo PR publicava tags no GHCR. Em PR isso é
 * errado por três motivos que se somam — um PR de fork nem tem permissão para
 * publicar, e ainda assim o pipeline tentava; a decisão de revisão não deveria
 * ter como efeito colateral poluir o registry; e a imagem temporária ficava lá.
 *
 * A correção prende o `push` ao evento. Como o job `security` escaneava o digest
 * que o `build` publicava (inexistente em PR), o scan de PR passa a rodar dentro
 * do próprio `build`, sobre a imagem que ele carrega com `load: true`. O job
 * `security` cobre o digest publicado, em `push`/`workflow_dispatch`.
 *
 * Os testes leem o YAML com o mesmo isolamento de bloco dos outros testes de
 * workflow: `js-yaml` não é dependência do projeto, e a unidade que importa é a
 * forma do job.
 */

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github/workflows/ci-cd.yml'), 'utf8');

const jobBlock = (job: string): string => {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex(l => new RegExp(`^  ${job}:`).test(l));
  if (start === -1) {
    throw new Error(`job não encontrado: ${job}`);
  }
  const collected: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z-]+:/.test(lines[i])) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join('\n');
};

const jobCondition = (job: string): string =>
  jobBlock(job).match(/^ {4}if: (.+)$/m)?.[1] ?? '';

describe('P0.2 — PR não publica imagem', () => {
  it('o build só publica fora de pull_request', () => {
    expect(jobBlock('build')).toMatch(
      /push: \$\{\{ github\.event_name != 'pull_request' \}\}/
    );
  });

  it('em PR o build carrega a imagem local, em vez de publicar', () => {
    // `load: true` é o que faz a imagem existir na VM do runner para o scan
    // logo abaixo. Sem ele, `push: false` deixaria o scan sem alvo.
    expect(jobBlock('build')).toMatch(
      /load: \$\{\{ github\.event_name == 'pull_request' \}\}/
    );
  });

  it('o login no registry não acontece em PR', () => {
    const build = jobBlock('build');
    const loginAt = build.indexOf('🔑 Login to Container Registry');
    const loginStep = build.slice(loginAt, build.indexOf('uses: docker/login-action@v4', loginAt));

    expect(loginAt).toBeGreaterThan(-1);
    expect(loginStep).toContain('if: github.event_name != \'pull_request\'');
  });

  it('o PR ainda constrói a imagem e roda o security scan', () => {
    const build = jobBlock('build');

    expect(build).toMatch(/name: 🐳 Build and push Docker image/);
    // O scan de PR roda no build, sobre a imagem local.
    expect(build).toMatch(/name: 🔍 Run Trivy \(PR, imagem local\)/);
  });

  it('o job security não depende mais de pull_request', () => {
    // O digest que ele escaneia só existe quando o build publica — isto é, fora
    // de PR. Deixá-lo rodar em PR seria escanear uma imagem inexistente.
    const condition = jobCondition('security');

    expect(condition).toContain('github.event_name == \'push\'');
    expect(condition).not.toContain('pull_request');
  });

  it('main e workflow_dispatch continuam publicando', () => {
    // O outro lado do gate: `push: false` só para PR. Se a condição virasse
    // `false` fixo, o teste anterior passaria e ninguém publicaria nada.
    const build = jobBlock('build');

    expect(build).not.toMatch(/^ {6}push: false$/m);
    expect(build).not.toMatch(/^ {6}push: true$/m);
  });
});
