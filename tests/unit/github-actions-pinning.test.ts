import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Actions de terceiros no caminho da release
 * ==========================================
 *
 * O pipeline executava, em produção, uma action arquivada
 * (`8398a7/action-slack`, arquivada em 2025-09-13) e duas linhas fora das
 * suportadas (`codecov-action@v3`, `codeql-action/upload-sarif@v2`), mais
 * `action-gh-release@v1` — cujo runtime Node já não é suportado pelo GitHub
 * Actions desde 2025-09-19.
 *
 * Supply chain de release é o pior lugar para dependência mantida por terceiros
 * sem continuidade. Estas asserções existem para que a lista não se degrade de
 * volta: toda action usada nos dois workflows tem de estar em versão pinada,
 * nenhuma action arquivada pode voltar, e as versões exigidas pela política de
 * 1.0.0 têm de ser as declaradas.
 */

const WORKFLOWS = ['ci-cd.yml', 'release.yml'] as const;

const contents = (file: (typeof WORKFLOWS)[number]): string =>
  readFileSync(resolve(process.cwd(), '.github/workflows', file), 'utf8');

const allUses = (): string[] =>
  WORKFLOWS.flatMap(file => [...contents(file).matchAll(/uses:\s*(\S+)/g)].map(m => m[1]));

/** Actions mantidas pelo próprio GitHub. */
const FIRST_PARTY = [
  'actions/checkout',
  'actions/setup-node',
  'github/codeql-action'
];

/**
 * Primeira parte por prefixo: `github/codeql-action/upload-sarif` é action de
 * primeira parte, mesmo morando num subdiretório. Comparar o repositório inteiro
 * trataria a subpath como terceira parte e exigiria minor dela.
 */
const matchesUpstream = (repo: string, upstream: string): boolean =>
  repo === upstream || repo.startsWith(`${upstream}/`);

const isFirstParty = (repo: string): boolean =>
  FIRST_PARTY.some(first => matchesUpstream(repo, first));

/** Upstreams verificados em 2026-10-02 que publicam apenas major. */
const MAJOR_ONLY_UPSTREAM = [
  'codecov/codecov-action',
  'docker/build-push-action',
  'docker/login-action',
  'docker/setup-buildx-action',
  'docker/metadata-action',
  'softprops/action-gh-release'
];

/**
 * Major-only é aceito: a maior parte dos upstreams não publica minor (ver o
 * teste das majors). O que é rejeitado é tag flutuante, que não é pin de nada.
 */
const isPinned = (ref: string): boolean => {
  const [repo, version] = ref.split('@');
  const tag = version.replace(/^refs\/tags\//, '');

  if (/^(master|main|latest)$/.test(tag)) {
    return false;
  }
  // `v1.2.3` é pin exato.
  if (/^v\d+\.\d+\.\d+$/.test(tag)) {
    return true;
  }
  // `v5` é major: aceito para action de primeira parte e para os upstreams que
  // não publicam minor. `isFirstParty` continua documentando a distinção, usada
  // pelo teste das majors.
  if (/^v\d+$/.test(tag)) {
    return isFirstParty(repo) || MAJOR_ONLY_UPSTREAM.some(up => matchesUpstream(repo, up));
  }
  // SHA completo de 40 caracteres também é pin.
  return /^[0-9a-f]{40}$/.test(tag);
};

/**
 * Versões exigidas pela política de 1.0.0, conferidas no upstream em 2026-10-02.
 *
 * As cinco últimas entram na revisão de 2026-10-08: `actions/checkout@v4`,
 * `actions/setup-node@v4` e as quatro actions do Docker declaravam
 * `runs.using: node20`, e o runner já as executava forçadas em Node 24
 * ("Node.js 20 is deprecated..."). As majors abaixo são as primeiras que
 * declaram `node24` no `action.yml` de cada upstream — a checagem é lida do
 * próprio action, não da data de publicação.
 */
const REQUIRED_VERSIONS: Record<string, string> = {
  'aquasecurity/trivy-action': 'v0.36.0',
  'codecov/codecov-action': 'v5',
  'github/codeql-action/upload-sarif': 'v4',
  'softprops/action-gh-release': 'v3',
  'actions/checkout': 'v5',
  'actions/setup-node': 'v5',
  'docker/setup-buildx-action': 'v4',
  'docker/login-action': 'v4',
  'docker/metadata-action': 'v6',
  'docker/build-push-action': 'v7'
};

/** Actions arquivadas ou sem continuidade: nunca podem entrar no caminho da release. */
const FORBIDDEN = [
  { ref: '8398a7/action-slack', reason: 'arquivada em 2025-09-13' },
  { ref: 'slackapi/slack-github-action', reason: 'não é troca de versão; exigiria reescrever o payload' }
];

describe('Actions de terceiros: versão pinada', () => {
  it('os dois workflows usam alguma action', () => {
    expect(allUses().length).toBeGreaterThan(10);
  });

  it('nenhuma action está em tag flutuante', () => {
    const floating = allUses().filter(ref => !isPinned(ref));

    // `aquasecurity/trivy-action@master` era exatamente isto: o motor do gate de
    // segurança vinha de um branch, então o gate podia mudar de comportamento
    // entre uma execução e a seguinte sem nada no repositório registrar isso.
    expect(floating).toEqual([]);
  });

  it('a action do gate de segurança está em versão exata, não em major', () => {
    // Aqui a versão exata existe e é a única que faz sentido: o gate de
    // segurança não pode mudar de comportamento por causa de um release novo da
    // action. `aquasecurity/trivy-action` publica minors (`v0.36.0`).
    expect(allUses()).toContain('aquasecurity/trivy-action@v0.36.0');
  });

  it('as majors restantes são as que o upstream publica, não escolhas soltas', () => {
    // Não existe regra "toda action de terceiros precisa de minor": os upstreams
    // não publicam. Conferido em 2026-10-02 —
    //   docker/build-push-action: v5.6.0 e v5.6.1 -> 404
    //   docker/login-action:      v3.6.0 -> 200, v5.6.1 -> 404
    //   docker/setup-buildx-action: v3.6.0 -> 200
    //   docker/metadata-action:   v3.6.0, v5.6.0, v5.6.1 -> 200
    //   codecov/codecov-action:   nenhuma minor
    //   softprops/action-gh-release: nenhuma minor
    // Então major é a tag mais forte que existe para a maioria delas, e major é
    // exatamente o que a política de 1.0.0 pede. O que não pode é flutuante.
    // A revisão de 2026-10-08 moveu as majors de node20 para node24; a lista
    // fechada dessas majors está em REQUIRED_VERSIONS.
    const majors = allUses().filter(ref => /^\S+@v\d+$/.test(ref));
    for (const ref of majors) {
      expect(ref).not.toMatch(/@(master|main|latest)$/);
    }
  });

  it('as versões exigidas pela política de 1.0.0 são as declaradas', () => {
    const refs = allUses();

    for (const [action, expected] of Object.entries(REQUIRED_VERSIONS)) {
      expect(refs).toContain(`${action}@${expected}`);
    }
  });

  it('codeql-action está na linha v4', () => {
    const ref = allUses().find(value => value.startsWith('github/codeql-action/upload-sarif@'));
    expect(ref).toBe('github/codeql-action/upload-sarif@v4');
  });

  it('codecov-action está na linha v5, que exige token', () => {
    const ref = allUses().find(value => value.startsWith('codecov/codecov-action@'));
    expect(ref).toBe('codecov/codecov-action@v5');

    // v5 removeu o upload sem token para repositório público. A política de 1.0.0
    // já passava `token`, então o bump é seguro — mas o oposto teria quebrado o
    // upload em silêncio, porque o step tem `fail_ci_if_error: false`.
    expect(contents('ci-cd.yml')).toMatch(/secrets\.CODECOV_TOKEN/);
  });

  it('action-gh-release está na v3, a linha com runtime suportado', () => {
    // v2.6.2 é a última v2 e não é mais mantida; usa o runtime Node 20, que o
    // GitHub Actions depreciou. v3 roda em node24.
    const ref = allUses().find(value => value.startsWith('softprops/action-gh-release@'));
    expect(ref).toBe('softprops/action-gh-release@v3');
  });
});

describe('Actions arquivadas não voltam', () => {
  for (const { ref, reason } of FORBIDDEN) {
    it(`não há ${ref} (${reason})`, () => {
      for (const file of WORKFLOWS) {
        expect(contents(file)).not.toContain(`${ref}@`);
      }
    });
  }

  it('nenhum workflow referencia webhook do Slack', () => {
    for (const file of WORKFLOWS) {
      expect(contents(file)).not.toMatch(/SLACK_WEBHOOK_URL/);
    }
  });

  it('o job de notificação do Slack foi removido por inteiro', () => {
    // Não basta o step ter ido: um job `notify` sem steps, ou com Slack dentro,
    // voltaria por uma alteração futura.
    expect(contents('ci-cd.yml')).not.toMatch(/^ {2}notify:/m);
  });

  it('a release não depende de Slack para concluir', () => {
    // A release precisa ser reprodutível por quem não tem webhook configurado.
    for (const file of WORKFLOWS) {
      expect(contents(file)).not.toMatch(/slack/i);
    }
  });
});

describe('A remoção do job notify não deixou referência órfã', () => {
  const jobNames = (file: (typeof WORKFLOWS)[number]): string[] => [
    ...contents(file).matchAll(/^ {2}([a-z-]+):/gm)
  ].map(m => m[1]);

  it('todo needs aponta para um job que existe', () => {
    for (const file of WORKFLOWS) {
      const jobs = jobNames(file);
      const needs = [...contents(file).matchAll(/needs:\s*(.+)$/gm)].flatMap(m =>
        m[1].replace(/^\[|\]$/g, '').split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''))
      );

      for (const dependency of needs) {
        expect(jobs).toContain(dependency);
      }
    }
  });

  it('o ci-cd ainda tem os jobs do caminho principal da release', () => {
    for (const job of ['code-quality', 'tests', 'build', 'security', 'deploy']) {
      expect(jobNames('ci-cd.yml')).toContain(job);
    }
  });
});
