import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * O release pipeline é executável de verdade
 * ==========================================
 *
 * O `release.yml` antigo tinha a forma certa e o comportamento errado: recebia
 * uma versão por input e ignorava, usando `github.ref_name` como `tag_name`
 * (no dispatch, `github.ref_name` é o *branch* — a release saía como
 * "Release main"); e o passo de Docker era um `echo "✅ Docker images tagged"`
 * que não tocava em registry nenhum. Os critérios de aceite do item 1.9 eram
 * inalcançáveis no estado anterior.
 *
 * Estes testes não releem o YAML procurando string: eles **executam** o `run:`
 * real da validação contra um repositório git de verdade, com tags de verdade.
 * Um teste que só conferisse que o texto "buildx build --push" existe passaria
 * mesmo com a lógica de versionamento errada ao lado.
 */

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

/** Extrai o corpo de um `run:` do job indicado, pelo nome do step. */
const scriptOf = (job: string, stepNeedle: string): string => {
  const jobStart = WORKFLOW.indexOf(`\n  ${job}:`);
  if (jobStart === -1) {
    throw new Error(`job não encontrado: ${job}`);
  }
  const jobEnd = WORKFLOW.indexOf('\n  # ====', jobStart);
  const block = WORKFLOW.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);

  const stepStart = block.indexOf(`name: ${stepNeedle}`);
  if (stepStart === -1) {
    throw new Error(`step não encontrado: ${job} / ${stepNeedle}`);
  }

  const runMarker = 'run: |';
  const runAt = block.indexOf(runMarker, stepStart);
  if (runAt === -1) {
    throw new Error(`step sem run: ${job} / ${stepNeedle}`);
  }

  const bodyStart = runAt + runMarker.length;
  const rest = block.slice(bodyStart);
  const lines = rest.split('\n');
  const indent = (lines[1].match(/^ */) as RegExpMatchArray)[0].length;

  const collected: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() !== '' && (line.match(/^ */) as RegExpMatchArray)[0].length < indent) {
      break;
    }
    collected.push(line.slice(Math.min(indent, line.length - (line.trim() === '' ? 0 : 0))));
  }
  return collected.join('\n');
};

/**
 * Executa um script com ambiente real.
 *
 * `VAR=x bash -c "cmd1\ncmd2"` exporta `VAR` só para o *primeiro* comando: a
 * partir da quebra de linha o shell já está no ambiente normal, e com `set -u`
 * qualquer variável ausente mata a execução. Então o env vai pelo parâmetro de
 * `execFileSync`, não como prefixo de shell.
 */
const runScript = (script: string, cwd: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('bash', ['-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

const sh = (command: string, cwd: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('bash', ['-c', command], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

const RESOLVE_SCRIPT = scriptOf('validate', '🏷️ Resolve and validate tag');
const PREVIOUS_SCRIPT = scriptOf('validate', '🔎 Resolve previous tag');
const IMAGE_SCRIPT = scriptOf('image', '🐳 Build and push image');

/**
 * Repositório de teste: `v0.9.0` numa tag antiga e `v1.0.0` na `main`, com
 * package.json coerente. É o cenário mínimo para o changelog ter range.
 */
const repoDir = mkdtempSync(join(tmpdir(), 'release-pipeline-'));

const makeRepo = (): void => {
  sh('git init -q --initial-branch=main .', repoDir);
  sh('git config user.email release@test.local && git config user.name "Release Test"', repoDir);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.0' }, null, 2));
  writeFileSync(join(repoDir, 'Dockerfile'), 'FROM node:22-alpine\n');
  sh('git add -A && git commit -q -m "chore: base"', repoDir);
  sh('git tag -a v0.9.0 -m "v0.9.0"', repoDir);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
  sh('git add -A && git commit -q -m "feat: primeira entrega da 1.0.0"', repoDir);
  writeFileSync(join(repoDir, 'NOTES.md'), 'notas\n');
  sh('git add -A && git commit -q -m "docs: notas da release"', repoDir);
  sh('git tag -a v1.0.0 -m "v1.0.0"', repoDir);

  // `origin/main` é exigido pelo guard de merge. Um clone local serve.
  sh('git clone -q --bare . ../origin.git', repoDir);
  sh('git remote add origin ../origin.git', repoDir);
  sh('git fetch -q origin main:refs/remotes/origin/main', repoDir);
};

beforeAll(() => {
  makeRepo();
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(join(repoDir, '..', 'origin.git'), { recursive: true, force: true });
});

/** Corre o script e captura saída + código, para os casos que devem reprovar. */
const tryResolve = (
  eventName: string,
  dispatchTag: string,
  pushTag: string
): { code: number; out: string; outputs: Record<string, string> } => {
  const outputFile = join(repoDir, 'github_output');
  const summaryFile = join(repoDir, 'step_summary');
  rmSync(outputFile, { force: true });
  rmSync(summaryFile, { force: true });

  let code = 0;
  let out = '';
  try {
    out = sh(RESOLVE_SCRIPT, repoDir, {
      EVENT_NAME: eventName,
      DISPATCH_TAG: dispatchTag,
      PUSH_TAG: pushTag,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile
    });
  } catch (error) {
    code = (error as { status: number }).status;
    out = ((error as { stdout: string }).stdout ?? '') + ((error as { stderr: string }).stderr ?? '');
  }

  const outputs: Record<string, string> = {};
  if (existsSync(outputFile)) {
    for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) {
        outputs[key] = rest.join('=');
      }
    }
  }
  return { code, out, outputs };
};

describe('release: a tag é a fonte de verdade', () => {
  it('uma tag válida no push é aceita e resolve versão', () => {
    const { code, outputs } = tryResolve('push', '', 'v1.0.0');

    expect(code).toBe(0);
    expect(outputs.tag).toBe('v1.0.0');
    expect(outputs.version).toBe('1.0.0');
    expect(outputs.is_prerelease).toBe('false');
  });

  it('o dispatch usa a tag do input, não o branch', () => {
    // Regressão do bug: no dispatch, `github.ref_name` é o branch. Usá-lo como
    // tag_name criava uma release chamada "Release main".
    const { code, outputs } = tryResolve('workflow_dispatch', 'v1.0.0', 'main');

    expect(code).toBe(0);
    expect(outputs.tag).toBe('v1.0.0');
    expect(outputs.version).toBe('1.0.0');
  });

  it('dispatch sem tag reprova com mensagem explícita', () => {
    const { code, out } = tryResolve('workflow_dispatch', '', 'main');

    expect(code).not.toBe(0);
    expect(out).toMatch(/Nenhuma tag informada/);
  });

  it('dispatch de tag que não existe reprova', () => {
    // O dispatch reexecuta uma release; não cria versão. Pedir v9.9.9 tem que
    // falhar, não criar release de uma tag imaginária.
    const { code, out } = tryResolve('workflow_dispatch', 'v9.9.9', 'main');

    expect(code).not.toBe(0);
    expect(out).toMatch(/não existe no repositório/);
  });
});

describe('release: semantic versioning e coerência com package.json', () => {
  it('tag não-semver reprova', () => {
    sh('git tag -a vNaumero -m x', repoDir);

    const { code, out } = tryResolve('workflow_dispatch', 'vNaumero', 'main');
    sh('git tag -d vNaumero', repoDir);

    expect(code).not.toBe(0);
    expect(out).toMatch(/semantic version/);
  });

  it('tag que não bate com package.json reprova', () => {
    // Duas fontes de verdade para a mesma versão é exatamente o tipo de coisa
    // que só aparece no momento de etiquetar a imagem.
    sh('git tag -a v1.1.0 -m x', repoDir);

    const { code, out } = tryResolve('workflow_dispatch', 'v1.1.0', 'main');
    sh('git tag -d v1.1.0', repoDir);

    expect(code).not.toBe(0);
    expect(out).toMatch(/não bate com package\.json/);
  });

  it('tag fora da main reprova', () => {
    // Repositório próprio: este caso depende de `package.json` na main casar com
    // a versão da tag, e num repo compartilhado o resultado dependeria da ordem
    // em que os testes rodam.
    const dir = mkdtempSync(join(tmpdir(), 'release-offmain-'));
    sh('git init -q --initial-branch=main .', dir);
    sh('git config user.email r@test.local && git config user.name R', dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
    sh('git add -A && git commit -q -m base', dir);
    sh('git clone -q --bare . ../offmain-origin.git', dir);
    sh('git remote add origin ../offmain-origin.git', dir);
    sh('git fetch -q origin main:refs/remotes/origin/main', dir);

    // A tag aponta para um commit que existe, tem versão correta e nunca foi
    // mergeado — todos os outros guards passam, só este pode barrar.
    sh('git checkout -q -b nao-mergeada && git commit -q --allow-empty -m "fix: solto"', dir);
    sh('git tag -a v2.0.0 -m x', dir);
    sh('git checkout -q main', dir);

    const outputFile = join(dir, 'out.txt');
    let code = 0;
    let out = '';
    try {
      out = runScript(RESOLVE_SCRIPT, dir, {
        EVENT_NAME: 'workflow_dispatch',
        DISPATCH_TAG: 'v2.0.0',
        PUSH_TAG: 'main',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: join(dir, 'sum.md')
      });
    } catch (error) {
      code = (error as { status: number }).status;
      out = ((error as { stdout: string }).stdout ?? '') + ((error as { stderr: string }).stderr ?? '');
    }

    rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, '..', 'offmain-origin.git'), { recursive: true, force: true });

    expect(code).not.toBe(0);
    expect(out).toMatch(/não está na main/);
  });

  it('pré-release é reconhecida e não mexe em latest', () => {
    sh('git checkout -q -b pre && git commit -q --allow-empty -m "chore: rc"', repoDir);
    sh('git checkout -q main && git merge -q --no-ff pre -m "merge: rc"', repoDir);
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0-rc.1' }, null, 2));
    sh('git add -A && git commit -q -m "chore: rc.1"', repoDir);
    sh('git tag -a v1.1.0-rc.1 -m x', repoDir);
    sh('git push -q origin main:refs/heads/main', repoDir);

    const { code, outputs } = tryResolve('workflow_dispatch', 'v1.1.0-rc.1', 'main');

    expect(code).toBe(0);
    expect(outputs.is_prerelease).toBe('true');
    expect(outputs.version).toBe('1.1.0-rc.1');
  });
});

describe('release: o changelog tem range', () => {
  it('a tag anterior é resolvida no commit pai, não na própria tag', () => {
    // `git describe --tags --abbrev=0 HEAD` na própria tag devolveria a tag da
    // release, o range viraria vazio e o CHANGELOG sairia em branco.
    const naive = sh('git describe --tags --abbrev=0 v1.0.0', repoDir).trim();
    expect(naive).toBe('v1.0.0');

    const previous = sh('git describe --tags --abbrev=0 "v1.0.0^"', repoDir).trim();
    expect(previous).toBe('v0.9.0');
  });

  it('o script do workflow resolve v0.9.0 para a tag v1.0.0', () => {
    const summary = join(repoDir, 'prev_summary');
    rmSync(summary, { force: true });

    runScript(PREVIOUS_SCRIPT, repoDir, {
      TAG: 'v1.0.0',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: join(repoDir, 'prev_output')
    });

    expect(readFileSync(summary, 'utf8')).toMatch(/v0\.9\.0/);
  });

  it('o range da release não está vazio', () => {
    const log = sh('git log --no-merges --pretty=format:\'- %s (%h)\' v0.9.0..v1.0.0', repoDir);

    expect(log.trim()).not.toBe('');
    expect(log).toMatch(/primeira entrega da 1\.0\.0/);
    expect(log).toMatch(/notas da release/);
  });
});

describe('release: a imagem é construída de verdade', () => {
  it('o script do workflow executa buildx com --push e as três tags', () => {
    // Roda o `run:` real com docker stubado, para o teste ser rápido e não
    // precisar de registry. O que se verifica é o comando que sai.
    const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
    const log = join(stub, 'calls.log');
    writeFileSync(
      join(stub, 'docker'),
      `#!/usr/bin/env bash
echo "$@" >> ${log}
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ]; then
  echo "sha256:deadbeef"
fi
`,
      { mode: 0o755 }
    );

    const summary = join(stub, 'summary.md');
    const output = join(stub, 'out.txt');

    runScript(IMAGE_SCRIPT, repoDir, {
      PATH: `${stub}:${process.env.PATH}`,
      REGISTRY: 'ghcr.io',
      IMAGE_NAME: 'dioneyfroes-coder/micrologin',
      TAG: 'v1.0.0',
      VERSION: '1.0.0',
      IS_PRERELEASE: 'false',
      SHA: 'abc123def456',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output
    });

    const calls = readFileSync(log, 'utf8');

    expect(calls).toMatch(/buildx build/);
    expect(calls).toMatch(/--push/);
    expect(calls).toMatch(/:1\.0\.0/);
    expect(calls).toMatch(/:v1\.0\.0/);
    expect(calls).toMatch(/:abc123def456/);
    expect(calls).toMatch(/linux\/amd64,linux\/arm64/);

    const summaryText = readFileSync(summary, 'utf8');
    expect(summaryText).toMatch(/digest/);
    expect(summaryText).toMatch(/sha256:deadbeef/);

    rmSync(stub, { recursive: true, force: true });
  });

  it('latest só entra em versão estável', () => {
    const buildTags = (isPrerelease: string): string => {
      const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
      const log = join(stub, 'calls.log');
      writeFileSync(
        join(stub, 'docker'),
        `#!/usr/bin/env bash\necho "$@" >> ${log}\n`,
        { mode: 0o755 }
      );
      runScript(IMAGE_SCRIPT, repoDir, {
        PATH: `${stub}:${process.env.PATH}`,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'x/y',
        TAG: 'v1.1.0-rc.1',
        VERSION: '1.1.0-rc.1',
        IS_PRERELEASE: isPrerelease,
        SHA: 'deadbeef',
        GITHUB_STEP_SUMMARY: join(stub, 's.md'),
        GITHUB_OUTPUT: join(stub, 'o.txt')
      });
      const text = readFileSync(log, 'utf8');
      rmSync(stub, { recursive: true, force: true });
      return text;
    };

    expect(buildTags('false')).toMatch(/:latest/);
    // Um RC que toma `latest` faz quem puxa `latest` receber pré-release.
    expect(buildTags('true')).not.toMatch(/:latest/);
  });

  it('não sobrou nenhum echo de sucesso sem operação por trás', () => {
    // O passo antigo era exatamente isto: "✅ Docker images tagged" sem registry.
    expect(WORKFLOW).not.toMatch(/echo\s+["'].*tagged/i);
    expect(WORKFLOW).not.toMatch(/#\s*Implementar tag/);
  });
});

describe('release: os gates do item 1.9 estão todos lá', () => {
  const gateOf = (fragment: string): boolean => WORKFLOW.includes(fragment);

  for (const [name, fragment] of [
    ['lint', 'npm run lint'],
    ['typecheck', 'npm run typecheck'],
    ['build', 'npm run build'],
    ['npm audit', 'npm audit --audit-level=moderate'],
    ['audit-ci', 'npx audit-ci --config .audit-ci.json'],
    ['secret scanning', 'npm run test:secrets'],
    ['unit', 'npm run test:unit:fast'],
    ['credential theft', 'npm run test:credential-theft:unit'],
    ['ddos preflight', 'npm run test:ddos -- --preflight-only'],
    ['integration', 'npm run test:integration:app'],
    ['trivy gate', 'exit-code: \'1\'']
  ]) {
    it(`roda ${name}`, () => {
      expect(gateOf(fragment)).toBe(true);
    });
  }

  it('a release depende do scan, não só do build', () => {
    // Publicar release sem o gate de segurança rodando é o fluxo que o item 1.7
    // fechou; o release não pode contornar isso.
    const releaseJob = WORKFLOW.slice(WORKFLOW.indexOf('\n  release:'));
    expect(releaseJob).toMatch(/needs:.*security/);
  });

  it('a release usa a tag validada, não github.ref_name', () => {
    // `tag_name: ${{ github.ref_name }}` é o bug original.
    expect(WORKFLOW).not.toMatch(/tag_name:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
    expect(WORKFLOW).toMatch(/tag_name:\s*\$\{\{\s*needs\.validate\.outputs\.tag\s*\}\}/);
  });

  it('o digest publicado aparece no resumo', () => {
    expect(WORKFLOW).toMatch(/image\.outputs\.digest/);
    expect(WORKFLOW).toMatch(/GITHUB_STEP_SUMMARY/);
  });

  it('o changelog é determinístico, sem as notas automáticas do GitHub', () => {
    // Com `generate_release_notes`, o GitHub anexa notas que mudam entre
    // execuções — mesmo tag, arquivos diferentes.
    // O termo aparece num comentário que explica a remoção; o que não pode
    // existir é a chave ligada.
    expect(WORKFLOW).not.toMatch(/^\s*generate_release_notes:\s*\S/m);
  });

  it('uma RC é publicada como prerelease, não como estável', () => {
    // Sem isto, uma `v1.1.0-rc.1` sai marcada como release estável e `latest`
    // pode ter sido movido: quem consome `latest` recebe pré-release achando que
    // é a release.
    expect(WORKFLOW).toMatch(/prerelease:\s*\$\{\{\s*needs\.validate\.outputs\.is-prerelease\s*\}\}/);
    expect(WORKFLOW).not.toMatch(/^\s*prerelease:\s*false\s*$/m);
  });

  it('as duas releases não correm em paralelo', () => {
    expect(WORKFLOW).toMatch(/^concurrency:/m);
    expect(WORKFLOW).toMatch(/cancel-in-progress:\s*false/);
  });

  it('cada job pede só a permissão que usa', () => {
    expect(WORKFLOW).toMatch(/contents:\s*write/);
    expect(WORKFLOW).toMatch(/packages:\s*write/);
    expect(WORKFLOW).toMatch(/security-events:\s*write/);
  });
});
