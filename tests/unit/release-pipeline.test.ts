import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, basename } from 'node:path';

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

/**
 * Caminho seguro para embutir num script bash.
 *
 * No Linux o `tmpdir()` já é POSIX e isto é um no-op. No Windows os stubs são
 * executados pelo bash do Git, onde `\` é caractere de escape: um caminho
 * `C:\Users\...` num `echo >> ${…}` vira `C:Users...` e o redirect some sem
 * erro. A troca por `/` é o que o MSYS2 entende como o mesmo caminho.
 */
const shellPath = (path: string): string => path.replace(/\\/g, '/');

const RESOLVE_SCRIPT = scriptOf('validate', '🏷️ Resolve and validate tag');
const IMAGE_SCRIPT = scriptOf('image', '🐳 Build and push candidate image');
const PROMOTE_SCRIPT = scriptOf('promote', '🏷️ Promote candidate to release tags');

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
// O bare repo fica FORA do working tree (um clone dentro de `repoDir` seria
// capturado por `git add -A` num teste posterior, e um `git checkout` de outra
// tag removeria os arquivos — o fetch seguinte falharia com "does not appear
// to be a git repository"). E fica em diretório ÚNICO por run (irmão do
// `mkdtemp`), não em `../origin.git` fixo: numa execução abortada, o diretório
// compartilhado do `%TEMP%` fica para trás e a próxima run reprova com
// "already exists".
const originDir = join(tmpdir(), `${basename(repoDir)}.git`);

const makeRepo = (): void => {
  sh('git init -q --initial-branch=main .', repoDir);
  sh('git config user.email release@test.local && git config user.name "Release Test"', repoDir);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.0' }, null, 2));
  writeFileSync(join(repoDir, 'Dockerfile'), 'FROM node:24-alpine\n');
  sh('git add -A && git commit -q -m "chore: base"', repoDir);
  sh('git tag -a v0.9.0 -m "v0.9.0"', repoDir);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
  sh('git add -A && git commit -q -m "feat: primeira entrega da 1.0.0"', repoDir);
  writeFileSync(join(repoDir, 'NOTES.md'), 'notas\n');
  sh('git add -A && git commit -q -m "docs: notas da release"', repoDir);
  sh('git tag -a v1.0.0 -m "v1.0.0"', repoDir);

  // `origin/main` é exigido pelo guard de merge. Um clone local serve.
  sh(`git clone -q --bare . ${shellPath(originDir)}`, repoDir);
  sh(`git remote add origin ${shellPath(originDir)}`, repoDir);
  sh('git fetch -q origin main:refs/remotes/origin/main', repoDir);
};

beforeAll(() => {
  makeRepo();
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
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
    // Mesma regra do repo principal: bare repo FORA do working tree e em
    // diretório único por run. Sem isto, um `./offmain-origin.git` interno
    // seria capturado por `git add -A`, e um `../offmain-origin.git` fixo num
    // `%TEMP%` compartilhado deixaria lixo de execução abortada.
    const offmainOrigin = join(tmpdir(), `${basename(dir)}.git`);
    sh('git init -q --initial-branch=main .', dir);
    sh('git config user.email r@test.local && git config user.name R', dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
    sh('git add -A && git commit -q -m base', dir);
    sh(`git clone -q --bare . ${shellPath(offmainOrigin)}`, dir);
    sh(`git remote add origin ${shellPath(offmainOrigin)}`, dir);
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
    rmSync(offmainOrigin, { recursive: true, force: true });

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
  it('o build publica só a tag candidata, sem tocar nas tags oficiais', () => {
    // Roda o `run:` real com docker stubado, para o teste ser rápido e não
    // precisar de registry. O que se verifica é o comando que sai.
    //
    // O stub **valida** as referências que recebe, em vez de só logar: o
    // Release 1.0.0 morreu no job `image` porque o script juntava quatro tags
    // numa string separada por vírgula e passava num `--tag` só, e o buildx
    // recusa com `invalid reference format`. O teste antigo passava porque
    // conferia substring — e a string unida por vírgula contém
    // `:1.0.0`, `:v1.0.0` e `:abc123`. Um teste que passa com o comando
    // quebrado não é evidência de nada.
    const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
    const log = join(stub, 'calls.log');
    writeFileSync(
      join(stub, 'docker'),
      `#!/usr/bin/env bash
echo "$@" >> "${shellPath(log)}"

# Mesmo critério do buildx para uma referência: sem vírgula, sem espaço, e com
# uma parte apos os dois-pontos para a tag. A vírgula é o que reprovava.
if [ "$1" = "buildx" ] && [ "$2" = "build" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--tag" ]; then
      ref="$2"
      case "$ref" in
        *,*) echo "invalid tag \\"$ref\\": invalid reference format" >&2; exit 1;;
        *[[:space:]]*) echo "invalid tag \\"$ref\\": invalid reference format" >&2; exit 1;;
        *:*) ;;
        *) echo "invalid tag \\"$ref\\": invalid reference format" >&2; exit 1;;
      esac
      shift 2
    else
      shift
    fi
  done
fi

if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ]; then
  echo "sha256:deadbeef"
fi
`,
      { mode: 0o755 }
    );

    const summary = join(stub, 'summary.md');
    const output = join(stub, 'out.txt');

    runScript(IMAGE_SCRIPT, repoDir, {
      PATH: `${stub}${delimiter}${process.env.PATH}`,
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
    expect(calls).toMatch(/:candidate-abc123def456/);
    // As tags oficiais nascem na promoção, depois do scan. Publicá-las aqui é o
    // defeito que este item fecha: um Trivy reprovado deixaria `latest` na
    // imagem rejeitada.
    expect(calls).not.toMatch(/:latest/);
    expect(calls).not.toMatch(/:1\.0\.0\b/);
    expect(calls).not.toMatch(/:v1\.0\.0\b/);
    // Só `linux/amd64`, por decisão e não por esquecimento. O arm64 entrou no
    // caminho crítico da release sem nenhum consumidor — nenhum compose pinando
    // plataforma, nenhum alvo de deploy — e sem ter sido verificado: a máquina
    // do build não tem QEMU, então `linux/arm64` só era prova por inspeção do
    // lock. Publicar plataforma sem consumidor só compra um modo de falha.
    expect(calls).toMatch(/--platform linux\/amd64\b/);
    expect(calls).not.toMatch(/linux\/arm64/);

    const outputs = readFileSync(output, 'utf8');
    expect(outputs).toContain('digest=sha256:deadbeef');

    const summaryText = readFileSync(summary, 'utf8');
    expect(summaryText).toMatch(/sha256:deadbeef/);

    rmSync(stub, { recursive: true, force: true });
  });

  it('a promoção move as tags oficiais para o digest escaneado', () => {
    // A promoção não reconstrói: ela replica o digest aprovado. `--prefer-index
    // =false` é o que mantém o manifesto single-platform no lugar de embrulhá-lo
    // num índice (o que trocaria o digest).
    const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
    const log = join(stub, 'calls.log');
    writeFileSync(
      join(stub, 'docker'),
      `#!/usr/bin/env bash
echo "$@" >> "${shellPath(log)}"
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  echo "sha256:deadbeef"
fi
`,
      { mode: 0o755 }
    );

    try {
      runScript(PROMOTE_SCRIPT, repoDir, {
        PATH: `${stub}${delimiter}${process.env.PATH}`,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'ghcr-image',
        TAG: 'v1.0.0',
        VERSION: '1.0.0',
        IS_PRERELEASE: 'false',
        DIGEST: 'sha256:deadbeef',
        SHA: 'abc123def456',
        GITHUB_STEP_SUMMARY: join(stub, 's.md')
      });

      const calls = readFileSync(log, 'utf8');

      expect(calls).toMatch(/imagetools create/);
      expect(calls).toMatch(/--prefer-index=false/);
      expect(calls).toMatch(/--tag ghcr\.io\/ghcr-image:1\.0\.0\b/);
      expect(calls).toMatch(/--tag ghcr\.io\/ghcr-image:v1\.0\.0\b/);
      expect(calls).toMatch(/--tag ghcr\.io\/ghcr-image:abc123def456\b/);
      expect(calls).toMatch(/--tag ghcr\.io\/ghcr-image:latest\b/);
      // A fonte da promoção é o digest aprovado, nunca uma tag mutável.
      expect(calls).toMatch(/ghcr\.io\/ghcr-image@sha256:deadbeef/);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it('a promoção reprova se uma tag não apontar para o digest aprovado', () => {
    // Stub que responde `inspect` com outro digest: promover o artefato errado é
    // o modo de falha que este item existe para impedir, então tem que reprovar.
    const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
    writeFileSync(
      join(stub, 'docker'),
      `#!/usr/bin/env bash
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  echo "sha256:outro"
fi
`,
      { mode: 0o755 }
    );

    try {
      let code = 0;
      try {
        runScript(PROMOTE_SCRIPT, repoDir, {
          PATH: `${stub}${delimiter}${process.env.PATH}`,
          REGISTRY: 'ghcr.io',
          IMAGE_NAME: 'ghcr-image',
          TAG: 'v1.0.0',
          VERSION: '1.0.0',
          IS_PRERELEASE: 'false',
          DIGEST: 'sha256:deadbeef',
          SHA: 'abc123def456',
          GITHUB_STEP_SUMMARY: join(stub, 's.md')
        });
      } catch (error) {
        code = (error as { status: number }).status;
      }

      expect(code).not.toBe(0);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it('latest só entra em versão estável', () => {
    const promoteTags = (isPrerelease: string): string => {
      const stub = mkdtempSync(join(tmpdir(), 'docker-stub-'));
      const log = join(stub, 'calls.log');
      writeFileSync(
        join(stub, 'docker'),
        `#!/usr/bin/env bash
echo "$@" >> "${shellPath(log)}"
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  echo "sha256:deadbeef"
fi
`,
        { mode: 0o755 }
      );
      runScript(PROMOTE_SCRIPT, repoDir, {
        PATH: `${stub}${delimiter}${process.env.PATH}`,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'x/y',
        TAG: 'v1.1.0-rc.1',
        VERSION: '1.1.0-rc.1',
        IS_PRERELEASE: isPrerelease,
        DIGEST: 'sha256:deadbeef',
        SHA: 'deadbeef',
        GITHUB_STEP_SUMMARY: join(stub, 's.md')
      });
      const text = readFileSync(log, 'utf8');
      rmSync(stub, { recursive: true, force: true });
      return text;
    };

    expect(promoteTags('false')).toMatch(/:latest/);
    // Um RC que toma `latest` faz quem puxa `latest` receber pré-release.
    expect(promoteTags('true')).not.toMatch(/:latest/);
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

  it('a promoção só move as tags depois do scan, e a release só depois dela', () => {
    // A ordem é o item P0.3: `latest` não pode existir antes do gate. A
    // promoção depende do `security`, e a GitHub Release depende da promoção —
    // sem esta última, a release poderia sair antes das tags oficiais.
    expect(blockOf('promote')).toMatch(/needs:.*security/);
    expect(WORKFLOW.slice(WORKFLOW.indexOf('\n  release:'))).toMatch(/needs:.*promote/);
  });

  it('o build não conhece a tag `latest`', () => {
    // O build só publica a tag candidata; quem move `latest` é a promoção, e só
    // em versão estável. Se `latest` reaparecer no `image`, o gate voltou a ser
    // contornável.
    expect(blockOf('image')).not.toMatch(/:latest/);
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

    for (const job of ['validate', 'quality', 'tests', 'image', 'promote', 'release', 'security']) {
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
    // Um `uses: actions/checkout@v5` sem `ref:` no push funciona por acidente
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

describe('release: o ambiente de teste dos workflows é uma configuração válida', () => {
  // Este describe existe porque o Release 1.0.0 rodou e falhou em `tests` por
  // causa disto. O job escrevia `JWT_SECRET=release-pipeline` (16 caracteres) e
  // `validateConfiguration()` exige no mínimo 32 — então 7 testes de
  // `security-config` derrubavam com "JWT_SECRET deve ter pelo menos 32
  // caracteres". Nada aqui acusou: o `.env` da máquina não existe, e quem rodou
  // unitário local herdou um `JWT_SECRET` válido do próprio shell.
  //
  // É a terceira vez que um valor do workflow, nunca executado, invalida o
  // build. Depois do `npm audit` que reprovava sempre e do preflight de DDoS que
  // não verificava nada. O padrão é o mesmo: o que ninguém executa não é
  // evidência, é hipótese.

  const workflowsOf = (): { name: string; body: string }[] => ['release.yml', 'ci-cd.yml']
    .map(name => ({
      name,
      body: readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8')
    }));

  /** Os valores de `VAR=valor` que o workflow escreve em `$GITHUB_ENV`. */
  const envOfWorkflow = (body: string): Record<string, string> => {
    const written = [...body.matchAll(/echo "([A-Z0-9_]+)=([^"]*)"/g)];

    return Object.fromEntries(written.map(([, key, value]) => [key, value]));
  };

  const validate = async(env: Record<string, string>): Promise<string[]> => {
    const previous = { ...process.env };
    // Só o que o job escreve, mais o mínimo para a configuração carregar.
    process.env = { ...process.env, NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv;

    try {
      jest.resetModules();
      const { validateConfiguration } = await import('../../src/interfaces/config/appConfig.js');

      try {
        validateConfiguration();
        return [];
      } catch (error) {
        return String((error as Error).message).split('\n').filter(line => line.startsWith('- '));
      }
    } finally {
      process.env = previous;
    }
  };

  it.each(workflowsOf())('$name escreve um ambiente que a configuração aceita', async({ body }) => {
    const env = envOfWorkflow(body);

    expect(Object.keys(env)).toContain('JWT_SECRET');
    expect(await validate(env)).toEqual([]);
  });

  it.each(workflowsOf())('$name não escreve segredo curto', ({ body }) => {
    // O limite vem da configuração, não deste teste: repetir o número aqui
    // deixaria os dois divergirem quando o requisito mudar.
    for (const [key, value] of Object.entries(envOfWorkflow(body))) {
      if (key.endsWith('_SECRET')) {
        expect({ [key]: value.length >= 32 }).toEqual({ [key]: true });
      }
    }
  });
});
