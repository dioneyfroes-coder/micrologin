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
const IMAGE_SCRIPT = scriptOf('image', '🐳 Build and push image');

/**
 * Os três defeitos abaixo eram invisíveis para os testes deste arquivo, e
 * nenhum deles apareceria em nenhum run local: os testes executam o `run:` com
 * as variáveis que precisam injetadas na mão. O que faltava era olhar a
 * *estrutura* do workflow — o que um step enxerga do step anterior.
 */

/** Nomes dos jobs que precisam da árvore da tag, e não do ref do evento. */
const TAG_DEPENDENT_JOBS = ['quality', 'tests', 'image', 'release'];

const blockOf = (job: string): string => {
  const start = WORKFLOW.indexOf(`\n  ${job}:`);
  if (start === -1) {
    throw new Error(`job não encontrado: ${job}`);
  }
  const end = WORKFLOW.indexOf('\n  # ====', start);
  return WORKFLOW.slice(start, end === -1 ? undefined : end);
};

/** Todo `run:` do job, com o `env:` que o step declara. */
const stepsOf = (block: string): { name: string; env: string; with: string; run: string }[] =>
  block
    .split('\n      - name: ')
    .slice(1)
    .map(chunk => ({
      name: chunk.slice(0, chunk.indexOf('\n')).trim(),
      // `env:` e `with:` são blocos YAML sob indentação fixa. Sem âncora de
      // linha eles casariam também com o `env:` de outro step.
      env: (chunk.match(/\n {8}env:\n((?: {10}.+\n)+)/) as RegExpMatchArray)?.[1] ?? '',
      with: (chunk.match(/\n {8}with:\n((?: {10}.+\n)+)/) as RegExpMatchArray)?.[1] ?? '',
      run: chunk.includes('run: |')
        ? chunk.slice(chunk.indexOf('run: |') + 8).replace(/^ {10}/gm, '')
        : ''
    }));

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
    // Roda o step completo, com o mesmo env que o GitHub monta, em vez de um
    // step isolado com $TAG injetado na mão. A versão anterior deste teste
    // fazia exatamente essa injeção — e por isso nunca percebeu que o step
    // seguinte não tinha como saber a tag.
    const outputFile = join(repoDir, 'prev_output');
    const summaryFile = join(repoDir, 'prev_summary');
    rmSync(outputFile, { force: true });
    rmSync(summaryFile, { force: true });

    runScript(RESOLVE_SCRIPT, repoDir, {
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_TAG: 'v1.0.0',
      PUSH_TAG: 'main',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile
    });

    expect(readFileSync(summaryFile, 'utf8')).toMatch(/v0\.9\.0/);
    expect(readFileSync(outputFile, 'utf8')).toMatch(/^previous=v0\.9\.0$/m);
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
    // Só `linux/amd64`, por decisão e não por esquecimento. O arm64 entrou no
    // caminho crítico da release sem nenhum consumidor — nenhum compose pinando
    // plataforma, nenhum alvo de deploy — e sem ter sido verificado: a máquina
    // do build não tem QEMU, então `linux/arm64` só era prova por inspeção do
    // lock. O problema é que `buildx` constrói as duas plataformas numa única
    // invocação: se o arm64 falhasse, a release inteira cairia, inclusive para
    // quem só puxa amd64. Numa release o caminho crítico deve conter só o que
    // foi verificado de fato.
    expect(calls).toMatch(/--platform linux\/amd64\b/);
    expect(calls).not.toMatch(/linux\/arm64/);

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

  it('o gate de dependências não é o `npm audit` cru, porque ele nunca passa', () => {
    // Este step existiu no `quality` e foi removido. O `npm audit` não tem
    // mecanismo de exceção, e a única advisory `moderate+` da árvore
    // (GHSA-vfj7-8cjw-p6xm, `braces`) está allowlisted até 2027-01-01. Como
    // `quality` é pré-requisito de `image` e de `release`, o step transformava
    // uma exceção documentada em uma release que nunca publica — e o operador
    // só descobria isso depois da tag reescrita, com `npm audit
    // --audit-level=moderate` medido em exit 1 nesta árvore. O `audit-ci` cobre
    // o mesmo threshold com a exceção, e é ele que decide.
    // O comentário no YAML cita o comando removido, para explicar por que ele
    // não volta. A asserção é sobre o que os steps **executam**, não sobre a
    // prosa: por isso as linhas de comentário saem antes de procurar.
    const semComentario = WORKFLOW
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n');

    expect(semComentario).not.toMatch(/npm audit --audit-level/);

    // E o gate que fica precisa ser o que tem a exceção, não o que não tem.
    expect(gateOf('npx audit-ci --config .audit-ci.json')).toBe(true);
  });

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

describe('release: o workflow sobrevive à fronteira entre steps', () => {
  // Cada `run:` é um shell novo. Variável de shell não sobrevive, e `set -u`
  // transforma a references esquecida em job vermelho.
  it('nenhum step usa uma variável que ele mesmo não define', () => {
    const offenders: string[] = [];

    for (const job of ['validate', 'quality', 'tests', 'image', 'release', 'security']) {
      for (const step of stepsOf(blockOf(job))) {
        if (!step.run.includes('set -u')) {
          continue;
        }

        // Variáveis que o próprio step precisa ter em mãos para funcionar.
        const used = [...step.run.matchAll(/\b(TAG|PREV|PREVIOUS|VERSION|IS_PRERELEASE|DIGEST|SHA)\b/g)]
          .map(m => m[1]);
        const defined = new Set(
          [...step.env.matchAll(/^\s{10}([A-Z_]+):/gm)].map(m => m[1] as string)
        );
        for (const name of new Set(used)) {
          if (defined.has(name)) {
            continue;
          }
          // A diferença é checada em outro step do mesmo job, e lá ela é
          // exportada para o GITHUB_OUTPUT.
          if (step.run.includes(`echo "${name}=`) || step.run.includes(`echo "${name}`)) {
            continue;
          }
          offenders.push(`${job} / ${step.name}: $${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('a tag anterior é resolvida dentro do step que já tem a tag', () => {
    // A versão anterior tinha um step "🔎 Resolve previous tag" que usava $TAG
    // sem declarar em env:. Nos testes passava (injetavam TAG), no GitHub real
    // era reprovação garantida.
    const validate = blockOf('validate');
    expect(validate).not.toContain('Resolve previous tag');
    expect(validate).toContain('previous=$PREV');
  });

  it('a checagem de package.json acontece depois do checkout da tag', () => {
    // Antes: o dispatch validava a versão do branch, e só depois trocava para a
    // tag. Uma tag v9.9.9 num branch com package.json 9.9.9 passaria, e a
    // release sairia com a árvore de outro commit.
    const resolve = RESOLVE_SCRIPT;
    const checkoutAt = resolve.indexOf('git checkout');
    const versionAt = resolve.indexOf('require(\'./package.json\').version');

    expect(checkoutAt).toBeGreaterThan(-1);
    expect(versionAt).toBeGreaterThan(checkoutAt);
  });
});

describe('release: os gates e o build rodam sobre a tag', () => {
  it.each(TAG_DEPENDENT_JOBS)('%s faz checkout da tag validada, não do ref do evento', job => {
    const block = blockOf(job);
    const checkout = stepsOf(block).find(s => s.name.includes('Checkout'));

    expect(checkout).toBeDefined();
    // O `ref:` é do `with:` do action, não do `env:` do run — e é ele que decide
    // de qual árvore o job roda.
    expect(checkout!.with).toContain('ref: ${{ needs.validate.outputs.tag }}');
  });

  it('nenhum gate depende do checkout padrão do action', () => {
    // Um `uses: actions/checkout@v4` sem `ref:` no push funciona por acidente
    // (o ref do evento já é a tag) e falha no dispatch.
    for (const job of TAG_DEPENDENT_JOBS) {
      const uses = [...blockOf(job).matchAll(/uses: actions\/checkout@\S+/g)];
      expect(uses.length).toBeGreaterThan(0);
      expect(blockOf(job)).not.toMatch(/actions\/checkout@\S+\n(?!\s+with:)/);
    }
  });
});

describe('release: o digest da imagem chega ao scan e ao resumo', () => {
  it('o job image declara o digest como output de job', () => {
    // Sem isto, `steps.build.outputs.digest` morre no fim do step e
    // `needs.image.outputs.digest` chega vazio: o Trivy escaneava `repo@` e o
    // resumo da release mostrava digest em branco. Nenhum teste pegou.
    const image = blockOf('image');
    const outputs = image.slice(0, image.indexOf('\n    steps:'));

    expect(outputs).toContain('outputs:');
    expect(outputs).toContain('digest: ${{ steps.build.outputs.digest }}');
  });

  it('o scan de segurança consome o digest do job image', () => {
    expect(blockOf('security')).toContain('needs.image.outputs.digest');
    expect(blockOf('security')).toMatch(/image-ref:.*@\$\{\{ needs\.image\.outputs\.digest \}\}/);
  });

  it('o resumo da release mostra o digest, não uma interpolação de template', () => {
    // Dentro de um `run:` o `${{ }}` é resolvido pelo runner, mas entre aspas
    // simples num heredoc-ish ele vira texto literal. Aqui é interpolado no
    // env, que é o que funciona.
    const release = blockOf('release');
    expect(release).toContain('DIGEST: ${{ needs.image.outputs.digest }}');
    expect(release).toMatch(/echo "- digest: \\`\$DIGEST\\`"/);
  });
});

describe('release: o preflight de DDoS é honesto sobre o que não verifica', () => {
  it('o job tests invoca o ddos em modo preflight', () => {
    // Se este step deixar de ser preflight, ele passa a exigir Docker + k6 no
    // runner do GitHub Actions. Docker existe lá; k6 não. O job inteiro passaria
    // a reprovar por causa de uma suíte que ele nunca teve como executar.
    expect(scriptOf('tests', '🧪 Run test suite'))
      .toContain('npm run test:ddos -- --preflight-only');
  });

  it('`--preflight-only` roda sem k6, sem Docker e sem provisionamento', () => {
    // Executado de verdade, e não conferido no texto: o `PATH` abaixo não tem
    // `k6`, `docker`, `bash` nem `openssl`, então qualquer checagem de
    // disponibilidade antes do retorno faria este comando falhar. Passar é a
    // prova de que o early return do script acontece antes delas.
    //
    // Isto prende os dois lados da decisão: o flag não pode sumir (a release
    // quebraria) e não pode ser lido como gate de resiliência (não é).
    const out = execFileSync(process.execPath, ['scripts/ddos-survival-test.mjs', '--preflight-only'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PATH: join(tmpdir(), 'caminho-que-nao-existe') }
    });

    expect(out).toMatch(/Alvo aceito: \S+/);
  });

  it('o comentário ao lado declara que isto não é um gate de DDoS', () => {
    // Um gate que se parece com verificação sem verificar nada é a mesma classe
    // de defeito do `npm audit` removido: aparência de proteção. A diferença é
    // que aqui a omissão é deliberada, e deliberação que não está escrita
    // vira engano na próxima leitura.
    const script = scriptOf('tests', '🧪 Run test suite');
    expect(script).toMatch(/N[ÃA]O é um gate de resili[êe]ncia a DDoS/);
  });
});
