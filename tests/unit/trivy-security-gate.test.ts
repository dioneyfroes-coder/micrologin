import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Trivy como gate, e não como relatório
 * ======================================
 *
 * O step existia e produzia SARIF, mas `exit-code` não tem default no
 * `trivy-action`. Sem ele o passo terminava em 0, o job `security` ficava verde
 * com a SARIF cheia de achados, e o `deploy` — que depende de `security` — seguia.
 * Um relatório que ninguém lê e uma barreira que nunca barra resultam no mesmo
 * artefato: imagem vulnerável em produção.
 *
 * O que é verificado aqui:
 *   - o gate reprova quando o Trivy acha algo (`exit-code: '1'`);
 *   - a versão do action está pinada, e não em `master`;
 *   - o motor do Trivy está pinado acima do default do action (senão o gate fica
 *     silenciosamente desatualizado);
 *   - o objeto do scan é o mesmo digest que o deploy usa;
 *   - as permissões de SARIF existem, e o upload roda mesmo com o gate vermelho.
 */

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github/workflows/ci-cd.yml'), 'utf8');
const DOCKERFILE = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: string;
  with?: Record<string, string | boolean>;
};

/**
 * A análise é textual, não via parser: `js-yaml` não é dependência do projeto, e
 * o que precisa ser conferido é a estrutura exata que o GitHub Actions lê. Cada
 * busca é ancorada no nome do job e do step, então não casa por acidente com
 * outro `uses:` do arquivo.
 */

const stepNamed = (job: string, needle: string): Step => {
  const block = jobBlock(job);
  const lines = block.split('\n');
  const start = lines.findIndex(l => l.includes(`name: ${needle}`));
  if (start === -1) {
    throw new Error(`step não encontrado: ${job} / ${needle}`);
  }

  const indent = (lines[start].match(/^ */) as RegExpMatchArray)[0].length;
  const collected: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    const lineIndent = (line.match(/^ */) as RegExpMatchArray)[0].length;
    if (lineIndent <= indent && line.trim().startsWith('-')) {
      break;
    }
    collected.push(line);
  }
  const text = collected.join('\n');

  const uses = text.match(/uses:\s*(\S+)/)?.[1];
  const ifExpr = text.match(/^\s*if:\s*(.+)$/m)?.[1].trim();
  const continueOnError = text.match(/^\s*continue-on-error:\s*(.+)$/m)?.[1].trim();
  const withBlock = text.match(/with:\n((?:\s{6,}.*\n?)+)/)?.[1] ?? '';

  const withValues: Record<string, string | boolean> = {};
  for (const line of withBlock.split('\n')) {
    const match = line.match(/^\s*-?\s*([a-z-]+):\s*(.+)$/);
    if (match) {
      const raw = match[2].trim();
      withValues[match[1]] = raw === 'true' ? true : raw === 'false' ? false : raw.replace(/^'(.*)'$/, '$1');
    }
  }

  return { name: needle, uses, if: ifExpr, 'continue-on-error': continueOnError, with: withValues };
};

const jobBlock = (job: string): string => {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex(l => new RegExp(`^  ${job}:`).test(l));
  if (start === -1) {
    throw new Error(`job não encontrado: ${job}`);
  }
  const collected: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp('^ {2}[a-z-]+:').test(lines[i])) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join('\n');
};

const deployNeeds = (): string[] => {
  const match = jobBlock('deploy').match(/needs:\s*\[([^\]]+)\]/);
  if (!match) {
    throw new Error('needs do deploy não encontrado');
  }
  return match[1].split(',').map(value => value.trim().replace(/^['"]|['"]$/g, ''));
};

const trivy = () => stepNamed('security', '🔍 Run Trivy vulnerability scanner');
const sarifUpload = () => stepNamed('security', '📤 Upload Trivy scan results');

/**
 * Defaults do `aquasecurity/trivy-action@v0.36.0`, lidos do `action.yaml` da
 * tag em 2026-10-02. Se o default mudar um dia, este arquivo precisa mudar junto
 * — e o teste que compara o motor contra o default avisa.
 */
const ACTION_DEFAULTS = {
  exitCode: undefined,
  severity: 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
  trivyVersion: 'v0.70.0',
  ref: 'v0.36.0'
} as const;

const versionParts = (value: string): number[] =>
  value.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10));

describe('Trivy: o gate reprova', () => {
  it('define exit-code 1, sem o qual o passo sempre terminava em 0', () => {
    // Regressão direta do item 1.7: `exit-code` não tem default no action.
    expect(trivy().with?.['exit-code']).toBe('1');
  });

  it('o gate está no caminho do deploy', () => {
    // Um gate que reprova e um deploy que não o espera valem o mesmo: nada.
    expect(deployNeeds()).toContain('security');
  });

  it('o upload do SARIF roda mesmo quando o gate reprova', () => {
    // `if: always()` é o que preserva a evidência do gate vermelho.
    expect(sarifUpload().if).toBe('always()');
  });
});

describe('Trivy: o que é escaneado é o que é implantado', () => {
  it('o scan usa o digest da imagem construída', () => {
    // `image-ref` carrega o digest: `ghcr.io/<repo>@sha256:...`.
    expect(trivy().with?.['image-ref']).toBe('${{ needs.build.outputs.image-ref }}');
  });

  it('o deploy recebe a mesma referência do scan', () => {
    const scan = trivy().with?.['image-ref'];
    expect(WORKFLOW).toContain(`"${scan}"`);
  });

  it('a referência é um digest, não uma tag mutável', () => {
    expect(jobBlock('build')).toContain('@${{ steps.build.outputs.digest }}');
  });

  it('a imagem escaneada é a de produção, não a de desenvolvimento', () => {
    const stages = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)];
    const target = stages.find(([, , asName]) => asName === 'production');

    expect(target).toBeDefined();
    expect(target?.[1]).toBe('base');
    // A imagem publicada é a stage final, e ela nasce de `base`, que não é a
    // stage de build com toolchain nem a de development com watcher.
    expect(DOCKERFILE).toMatch(/^FROM base AS production/im);
  });
});

describe('Trivy: a versão é pinada em duas camadas', () => {
  it('o action não está em master', () => {
    const uses = trivy().uses ?? '';
    expect(uses).toBe(`aquasecurity/trivy-action@${ACTION_DEFAULTS.ref}`);
    expect(uses).not.toMatch(/@(master|main|latest|v[0-9]+(\.[0-9]+)?)$/);
  });

  it('o motor está pinado acima do default do action', () => {
    const pinned = trivy().with?.version as string | undefined;
    expect(pinned).toBeDefined();

    const [major, minor] = versionParts(pinned as string);
    const [defaultMajor, defaultMinor] = versionParts(ACTION_DEFAULTS.trivyVersion);

    // `v0.36.0` do action embute `v0.70.0`. Deixar no default significa que
    // vulnerabilidade disclosed depois do v0.70.0 não é detectada e o gate
    // passa em silêncio — o pior modo de falha possível para um gate.
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(defaultMajor * 1000 + defaultMinor);
  });

  it('o action pinado traz input de versão próprio, então não há segundo action', () => {
    // Se um dia o `version` sumir do action, a alternativa seria um passo
    // `setup-trivy` separado; o teste avisa antes de o gate ficar em default.
    expect(WORKFLOW).toContain('uses: aquasecurity/trivy-action@');
    expect(WORKFLOW).not.toContain('aquasecurity/setup-trivy@');
  });
});

describe('Trivy: a severidade é uma política, não o default', () => {
  it('não usa o default do action, que mostra tudo', () => {
    // Default `UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL` também é o que Trivy reporta
    // na SARIF, o que faz o SARIF e o gate concordarem por acidente. Aqui são
    // coisas distintas: o relatório mostra tudo, o gate julga o que bloqueia.
    expect(trivy().with?.severity).toBeDefined();
    expect(trivy().with?.severity).not.toBe(ACTION_DEFAULTS.severity);
  });

  it('bloqueia em HIGH e CRITICAL', () => {
    const severities = (trivy().with?.severity as string).split(',').sort();
    expect(severities).toEqual(['CRITICAL', 'HIGH']);
  });

  it('o SARIF continua completo, mesmo com severity restrita', () => {
    // `severity` filtra o que o gate considera, não o que o relatório mostra.
    expect(trivy().with?.format).toBe('sarif');
  });

  it('a escolha de ignore-unfixed está documentada', () => {
    // `ignore-unfixed` só é aceitável escrito: é a diferença entre "reprovar o
    // que dá para corrigir" e "reprovar para sempre".
    expect(trivy().with?.['ignore-unfixed']).toBe(true);

    const runbook = readFileSync(
      resolve(process.cwd(), 'docs/OPERACOES.md'),
      'utf8'
    );
    expect(runbook).toMatch(
      /ignore-unfixed[\s\S]{0,300}?(sem corre[cç][aã]o|sem corre[cç][aã]oes)/i
    );
  });

  it('as permissões de SARIF existem no job que publica o relatório', () => {
    const permissions = /permissions:\n((?:\s+.*\n)+)/.exec(jobBlock('security'))?.[1] ?? '';

    expect(permissions).toMatch(/security-events:\s*write/);
    // `contents: read` porque o SARIF upload do CodeQL lê o repositório.
    expect(permissions).toMatch(/contents:\s*read/);
  });

  it('a documentação do runbook declara a mesma severidade que o workflow aplica', () => {
    // O teste anterior procurava /Trivy…HIGH…CRITICAL/ em qualquer lugar do
    // documento, e a busca casava com a linha do sumário do pipeline — a duas
    // palavras de distância —, não com a seção de política. Trocar a política
    // inteira por `MEDIUM` deixava 944/944 verdes. Aqui a severidade
    // documentada é extraída e comparada com a do workflow, como o threshold do
    // audit-ci faz com o dele.
    const runbook = readFileSync(
      resolve(process.cwd(), 'docs/OPERACOES.md'),
      'utf8'
    );

    // Só a seção "Política de imagem (Trivy)" conta: o sumário do pipeline
    // menciona Trivy e HIGH/CRITICAL numa linha, e é justamente ali que a
    // busca anterior casava por engano.
    const section = runbook.split('### Política de imagem (Trivy)')[1];
    expect(section).toBeDefined();

    const documented = section?.match(/`severity: '([A-Z,]+)'`/);
    expect(documented).not.toBeNull();

    const applied = String(trivy().with?.severity ?? '')
      .split(',')
      .sort();
    const declared = documented?.[1].split(',').sort();

    expect(declared).toEqual(applied);
    // E a política continua não sendo o default da action, que reprovaria por
    // qualquer coisa — o que tornaria o gate ruído.
    expect(applied).not.toEqual(ACTION_DEFAULTS.severity.split(',').sort());
  });
});

describe('o workflow continua sendo YAML válido com o gate no lugar', () => {
  it('o arquivo tem os jobs esperados', () => {
    for (const job of ['code-quality', 'tests', 'build', 'security', 'deploy']) {
      expect(WORKFLOW).toMatch(new RegExp(`^  ${job}:`, 'm'));
    }
  });

  it('o security continua dependendo do build, para não escanear imagem inexistente', () => {
    expect(jobBlock('security')).toMatch(/needs: build/);
  });

  it('nenhum outro job continua em tag flutuante de segurança', () => {
    expect(WORKFLOW).not.toMatch(/aquasecurity\/trivy-action@(master|main|latest)/);
  });

  it('o gate roda em pull_request, não só depois do merge', () => {
    // O PR não publica imagem, então o scan de PR roda no job `build`, contra a
    // tag local que ele carrega com `load: true`. O job `security` cobre o
    // digest publicado, em `push`/dispatch.
    const prScan = stepNamed('build', '🔍 Run Trivy (PR, imagem local)');

    expect(prScan.if).toBe('github.event_name == \'pull_request\'');
    // O scan de PR julga a imagem local, não o digest — que não existe em PR.
    expect(String(prScan.with?.['image-ref'])).toContain(':pr-${{ github.event.pull_request.number }}');

    // O gate do digest continua valendo em `push`/dispatch.
    const condition = jobBlock('security').match(/^ {4}if: (.+)$/m)?.[1] ?? '';
    expect(condition).toContain('github.event_name == \'push\'');
    expect(trivy().with?.['image-ref']).toContain(
      'needs.build.outputs.image-ref'
    );
    // O build roda nos três eventos: não tem `if` de job que o confine.
    expect(jobBlock('build')).not.toMatch(/^ {4}if:.*push_request/);
  });

  it('o upload de SARIF não reprova o job em PR de fork', () => {
    // Token de fork é somente-leitura: `security-events: write` é rebaixado e o
    // upload é rejeitado. Reprovar por isso seria reprovar por um relatório que
    // o GitHub não deixa gravar — e ensinar a ignorar vermelho.
    const upload = sarifUpload();

    expect(upload.if).toBe('always()');
    expect(upload).toHaveProperty('continue-on-error');
    expect(String(upload['continue-on-error'])).toContain('github.event_name == \'pull_request\'');
    // O `continue-on-error` é do upload, não do scan: o gate não pode herdar
    // tolerância por causa de um relatório.
    expect(trivy()['continue-on-error']).toBeUndefined();
  });
});

/**
 * A imagem de runtime não carrega o npm
 * ======================================
 *
 * Terceiro defeito do Release 1.0.0, agora no gate do Trivy (run 37217066854):
 * `image` passou, e `security` reprovou com 10 HIGH.
 *
 * As 10 estavam todas em `usr/local/lib/node_modules/npm/node_modules/`: a árvore
 * que o npm da imagem base embarca, não o nosso código e não o nosso
 * package-lock.json. Nosso node_modules estava limpo — brace-expansion 1.1.21,
 * picomatch 2.3.2, ip-address 10.7.2, todos acima da versão corrigida.
 *
 * E não dava para consertar pelo caminho óbvio. As correções exigem pacote
 * >=21.5.1 e brace-expansion >=5.0.11. Trocar a base para node:24, que já traz
 * npm 11.19.0, NÃO resolve: ele embarca brace-expansion 5.0.7, e 4 dos 5 CVEs
 * daquele pacote só fecham a partir de 5.0.11.
 *
 * Então a remoção é a correção verdadeira: o código vulnerável sai da imagem em
 * vez de o scanner ser silenciado.
 */
describe('a imagem de runtime não embarca o npm', () => {
  /** O stage `production`, que é o stage final (o que a release publica). */
  const productionStage = (): string => {
    const start = DOCKERFILE.indexOf('FROM base AS production');
    if (start === -1) {
      throw new Error('stage production não encontrado no Dockerfile');
    }
    return DOCKERFILE.slice(start);
  };

  it('o stage que publica a imagem é o production, não o build', () => {
    // Sem isto, remover o npm do stage errado não mudaria nada e o teste
    // passaria de vazio. O stage final é o que a release efetivamente publica.
    const stages = [...DOCKERFILE.matchAll(/^FROM\s+\S+\s+AS\s+(\w+)/gm)].map((m) => m[1]);
    expect(stages[stages.length - 1]).toBe('production');
  });

  it('o npm é removido do stage de runtime', () => {
    const stage = productionStage();

    // O path exato onde o Trivy acha a árvore vulnerável.
    expect(stage).toMatch(/rm -rf[\s\S]*?\/usr\/local\/lib\/node_modules\/npm/);
    // Os binários: apagar o diretório sem os symlinks deixa `npm` no PATH
    // apontando para um alvo inexistente, que falha diferente e mais confusa.
    expect(stage).toMatch(/\/usr\/local\/bin\/npm/);
    expect(stage).toMatch(/\/usr\/local\/bin\/npx/);
  });

  it('a remoção vem DEPOIS do npm ci, e não antes', () => {
    // A ordem é o que torna isso possível. Se o `rm` viesse antes do
    // `npm ci --omit=dev`, a imagem final não teria dependência nenhuma e
    // quebraria em runtime — e o build ainda passaria.
    const stage = productionStage();
    expect(stage.indexOf('npm ci --omit=dev')).toBeGreaterThan(-1);
    expect(stage.indexOf('/usr/local/lib/node_modules/npm')).toBeGreaterThan(
      stage.indexOf('npm ci --omit=dev')
    );
  });

  it('o build e o desenvolvimento continuam com npm', () => {
    // `npm run build` e `npm run dev` precisam do npm. A remoção é só no stage
    // final; se vazasse para os outros, o build da imagem quebraria.
    const buildStage = DOCKERFILE.slice(
      DOCKERFILE.indexOf('FROM base AS build'),
      DOCKERFILE.indexOf('FROM base AS production')
    );
    expect(buildStage).toMatch(/npm ci --include=dev/);
    expect(buildStage).not.toMatch(/rm -rf[\s\S]*?\/usr\/local\/lib\/node_modules\/npm/);
  });

  it('o runtime não invoca npm: o CMD é o node direto', () => {
    // Se o CMD usasse npm, remover o npm quebraria a imagem em runtime.
    const stage = productionStage();
    expect(stage).toMatch(/CMD \["node", "dist\/app\.js"\]/);
    expect(stage).not.toMatch(/CMD \["npm"/);
  });
});
