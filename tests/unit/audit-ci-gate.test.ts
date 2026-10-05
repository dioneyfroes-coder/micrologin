import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * O gate de dependências, e por que ele precisa de um threshold só
 * ==============================================================
 *
 * A configuração anterior trazia `low`, `moderate`, `high` e `critical` todos
 * em `true`, achando que cada chave era um interruptor independente. Não é.
 * `mapVulnerabilityLevelInput` (audit-ci 7.1.0) devolve no **primeiro** `true`,
 * na ordem `low > moderate > high > critical`:
 *
 *     if (low || l)      return { low: true,  moderate: true,  high: true,  critical: true }
 *     if (moderate || m) return { low: false, moderate: true,  high: true,  critical: true }
 *     if (high || h)     return { low: false, moderate: false, high: true,  critical: true }
 *     if (critical || c) return { low: false, moderate: false, high: false, critical: true }
 *
 * As quatro chaves são um seletor com prioridade, não quatro flags. Com as quatro
 * em `true`, o que valia era `low` — isto é, reprovar por qualquer advisory de
 * qualquer severidade — e as outras três eram configuração morta.
 *
 * A política de 1.0.0 é `moderate`: reprova em moderate ou superior. `low` fica
 * de fora de propósito, e a razão é o que os advisories de severidade baixa
 * realmente são neste ecossistema: `low` quase sempre descreve um pacote que só é
 * alcançável por caminho não usado, ou um DoS sem impacto em serviço que não
 * expõe aquela superfície. Bloquear por `low` com a allowlist vazia transforma o
 * gate em ruído, e um gate que se acostuma a ser ignorado não é um gate.
 *
 * `high` continuaria sendo mais permissivo, mas o projeto tem argon2id, pepper e
 * sessão revogável: não é a base de código para aceitar advisory transitivo de
 * severidade média sem decisão explícita.
 */

const CONFIG_PATH = resolve(process.cwd(), '.audit-ci.json');

type AuditConfig = Record<string, unknown>;

const config = (): AuditConfig =>
  JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AuditConfig;

/**
 * Formato da allowlist, conforme `https://github.com/IBM/audit-ci/raw/main/docs/schema.json`:
 * os itens são `string` ou `NSPRecord`, e `NSPRecord` é um objeto cujas chaves
 * são livres (o advisory) e cujos valores são
 * `{ active: boolean, expiry: string|number, notes?: string }`
 * (`additionalProperties: false` dentro de `NSPContent`).
 */
type NspContent = {
  active: boolean;
  expiry: string | number;
  notes?: string;
};

const allowlist = (): Record<string, NspContent>[] =>
  config().allowlist as Record<string, NspContent>[];

/**
 * Propriedades aceitas pelo schema oficial do audit-ci, conferidas em 2026-10-02
 * contra `https://github.com/IBM/audit-ci/raw/main/docs/schema.json`.
 *
 * O schema declara `additionalProperties: false`, então uma chave fora desta
 * lista é um erro de configuração — o `audit-ci` não falha por isso (o yargs
 * ignora o que não conhece), o que torna a divergência silenciosa. A versão
 * anterior carregava duas: `skipDev` e `summary`. `skipDev` nunca foi a chave
 * (`skip-dev` é), e `summary` não está no schema.
 *
 * A lista é copiada aqui em vez de baixada para manter a suíte unitária offline.
 * Ao atualizar o audit-ci, recheckar esta lista.
 */
const SCHEMA_PROPERTIES = [
  '$schema',
  'allowlist',
  'critical',
  'directory',
  'extra-args',
  'high',
  'low',
  'moderate',
  'output-format',
  'package-manager',
  'pass-enoaudit',
  'registry',
  'report-type',
  'retry-count',
  'show-found',
  'show-not-found',
  'skip-dev'
];

const SEVERITY_KEYS = ['low', 'moderate', 'high', 'critical'] as const;

describe('audit-ci - a configuração declara uma política', () => {
  it('aponta para o schema oficial', () => {
    expect(config()['$schema']).toBe('https://github.com/IBM/audit-ci/raw/main/docs/schema.json');
  });

  it('não usa nenhuma chave fora do schema', () => {
    const unknown = Object.keys(config()).filter(key => !SCHEMA_PROPERTIES.includes(key));

    // Regressão direta: `skipDev` e `summary` eram exatamente isto. Aceitas
    // sem erro pelo audit-ci e sem efeito, o que é pior do que serem rejeitadas.
    expect(unknown).toEqual([]);
  });

  it('escreve skip-dev com hífen, que é a chave que o audit-ci lê', () => {
    const cfg = config();

    expect(cfg['skip-dev']).toBe(false);
    // A grafia antiga não era lida: `skipDev` no arquivo não desligava nada.
    expect(cfg).not.toHaveProperty('skipDev');
  });

  it('escolhe exatamente um threshold de severidade', () => {
    const cfg = config();
    const enabled = SEVERITY_KEYS.filter(key => cfg[key] === true);

    // Um só. As quatro em `true` não davam "o gate mais estrito possível": davam
    // `low`, porque o seletor devolve no primeiro `true`.
    expect(enabled).toEqual(['moderate']);
  });

  it('a documentação do runbook registra o mesmo threshold que a config aplica', () => {
    // A política mora em `docs/OPERACOES.md`, ao lado dos gates que a executam —
    // não no README, que é leitura de 60 segundos e não um manual de pipeline.
    const runbook = readFileSync(
      resolve(process.cwd(), 'docs/OPERACOES.md'),
      'utf8'
    );

    // Extrai o threshold documentado e compara com o que está ligado no arquivo.
    // Um teste que só procurasse a palavra "moderate" num raio de 400 caracteres
    // aceitaria um runbook que descreve a política antiga e erra em cima.
    const documented = runbook.match(
      /threshold \*\*(low|moderate|high|critical)\*\*/
    );
    expect(documented).not.toBeNull();

    const cfg = config();
    const enabled = SEVERITY_KEYS.filter(key => cfg[key] === true);
    expect(documented?.[1]).toBe(enabled[0]);
  });

  it('a allowlist usa a forma que o audit-ci de fato honra', () => {
    // A forma dos exemplos do audit-ci — `{ "ghsa": [...], "justification": "...",
    // "expiry": "..." }` — é *ignorar tudo sem erro*. Conferido em 2026-10-03: com
    // o advisory na lista nesse formato o gate continuou reprovando, e a única
    // pista era o mesmo advisory na saída. Só o formato NSPRecord suprime.
    //
    // É a mesma classe de defeito que `skipDev`/`summary` representavam: não
    // falha, não avisa, e o diff parece innocuous. Por isso o teste existe.
    for (const entry of allowlist()) {
      expect(Object.keys(entry)).not.toContain('ghsa');
      expect(Object.keys(entry)).not.toContain('justification');
    }
  });

  it('toda exceção é um advisory GHSA com justificativa e validade', () => {
    for (const entry of allowlist()) {
      for (const [advisory, content] of Object.entries(entry)) {
        expect(advisory).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
        expect(content.active).toBe(true);
        // Exceção sem validade declarada é como advisory esquecido: ninguém
        // reavisa quando o pacote ganha correção, e a lista vira permanente.
        expect(content.expiry).toBeTruthy();
        expect(new Date(String(content.expiry)).getTime()).toBeGreaterThan(Date.now());
        // Justificativa mínima: sem texto, a exceção não é uma decisão
        // registrada, é um número de advisory com-calma.
        expect(String(content.notes ?? '').trim().length).toBeGreaterThanOrEqual(80);
      }
    }
  });

  it('a lista é curta e específica: nenhuma exceção em pacote inteiro', () => {
    // Allowlist por nome de pacote ("braces") esconderia advisory nova do mesmo
    // pacote, inclusive uma que já tivesse correção. A exceção é por advisory.
    expect(allowlist().length).toBeLessThanOrEqual(3);
    for (const entry of allowlist()) {
      for (const advisory of Object.keys(entry)) {
        expect(advisory.startsWith('GHSA-')).toBe(true);
      }
    }
  });

  it('mantém a varredura em devDependencies', () => {
    // `pm2` e a cadeia `proxy-agent` vivem em devDependencies. Pular dev
    // deixaria de fora justamente o que roda no deploy.
    expect(config()['skip-dev']).toBe(false);
  });
});

describe('audit-ci - o threshold é real, não decorativo', () => {
  /**
   * Fixture com uma dependência direta e vulnerável, para provar que o threshold
   * separa os casos. Um config que reprova sempre também "passaria" num teste
   * que só exige reprovação; o que prova o gate é ver os dois lados.
   *
   * `basic-ftp@5.3.1` cai em `GHSA-c475-qrg2-pj4r`, advisory `high` que segue
   * aberto (afeta `<= 6.2.0`). Dependência direta, então a fixture não depende
   * de a cadeia `pm2` mudar de forma.
   */
  const FIXTURE: Record<string, unknown> = {
    name: 'audit-ci-gate-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'basic-ftp': '5.3.1' }
  };

  let fixtureDir = '';
  let registryReachable = false;

  const runAuditCi = (auditConfig: AuditConfig): number => {
    const configPath = join(fixtureDir, 'audit-ci.json');
    writeFileSync(configPath, JSON.stringify(auditConfig), 'utf8');
    try {
      execFileSync(
        'npx',
        ['--prefix', process.cwd(), 'audit-ci', '--config', configPath],
        { cwd: fixtureDir, stdio: 'pipe', encoding: 'utf8' }
      );
      return 0;
    } catch (error) {
      return (error as { status: number | null }).status ?? 1;
    }
  };

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'audit-ci-gate-'));
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify(FIXTURE), 'utf8');

    // Só o lockfile: a fixture não precisa dos pacotes baixados para a auditoria.
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--silent'], {
        cwd: fixtureDir,
        stdio: 'pipe',
        encoding: 'utf8'
      });
      registryReachable = true;
    } catch {
      registryReachable = false;
    }
  });

  it('um advisory high reprova com o threshold moderate', () => {
    if (!registryReachable) {
      console.warn('[gate] registry npm inacessível: prova de reprovação pulada');
      return;
    }

    expect(runAuditCi({ moderate: true })).not.toBe(0);
  });

  it('o mesmo advisory passa com o threshold critical', () => {
    if (!registryReachable) {
      return;
    }

    // O contrapeso do teste anterior: `moderate` é mais estrito que `critical`
    // para este advisory. Sem este caso, um gate que reprova sempre passaria.
    expect(runAuditCi({ critical: true })).toBe(0);
  });

  it('a allowlist vazia não mascara o advisory', () => {
    if (!registryReachable) {
      return;
    }

    expect(runAuditCi({ moderate: true, allowlist: [] })).not.toBe(0);
  });

  it('a política do projeto reprova o advisory high', () => {
    if (!registryReachable) {
      return;
    }

    // A política real do arquivo, não uma reescrita para o teste. A allowlist
    // com GHSA de `braces` não podecribeduzir a reprovação de `basic-ftp`:
    // exceção por advisory, não por severidade nem por 'é transitivo'.
    expect(runAuditCi(config())).not.toBe(0);
  });
});

/**
 * A suíte acima prova que o gate reprova. Esta prova que ele *fecha*: que a
 * allowlist cobre exatamente o que existe hoje, nem mais (advisory esquecida
 *continua reprovando) nem menos (exceção que já não é mais necessária).
 *
 * Ambos os lados são rede. Sem registry, pulam com aviso — igual à fixture.
 */
describe('audit-ci - a allowlist cobre exatamente o que existe', () => {
  let auditReachable = false;
  let moderatePlus: string[] = [];
  let realAuditCiExit: number | null = null;

  beforeAll(() => {
    // `npm audit` sai com código 1 exatamente quando acha advisory — ou seja,
    // quando está funcionando. Ler só o caminho de sucesso descartava a prova
    // toda vez que ela valia, e o teste "passava" sem verificar nada.
    const capture = (): string => {
      try {
        return execFileSync('npm', ['--prefix', process.cwd(), 'audit', '--json'], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8'
        });
      } catch (error) {
        const stdout = (error as { stdout?: string }).stdout;
        if (!stdout) {
          throw error;
        }
        return stdout;
      }
    };

    try {
      const parsed = JSON.parse(capture()) as {
        vulnerabilities: Record<string, { via: ({ url?: string; severity?: string } | string)[] }>;
      };
      const blocked = new Set(['moderate', 'high', 'critical']);
      const found = new Set<string>();
      for (const pkg of Object.values(parsed.vulnerabilities)) {
        for (const via of pkg.via) {
          if (typeof via === 'string' || !via.url || !via.severity || !blocked.has(via.severity)) {
            continue;
          }
          found.add(via.url.split('/').pop() ?? via.url);
        }
      }
      moderatePlus = [...found].sort();
      auditReachable = true;
    } catch {
      auditReachable = false;
      return;
    }

    try {
      execFileSync('npx', ['audit-ci', '--config', CONFIG_PATH], {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8'
      });
      realAuditCiExit = 0;
    } catch (error) {
      realAuditCiExit = (error as { status: number | null }).status ?? 1;
    }
  }, 300_000);

  it('o conjunto moderate+ da árvore é o conjunto allowlisted', () => {
    if (!auditReachable) {
      console.warn('[gate] registry npm inacessível: prova de cobertura da allowlist pulada');
      return;
    }

    const allowlisted = allowlist()
      .flatMap(entry => Object.keys(entry))
      .sort();

    // Não "está na allowlist" — é exatamente igual. Um advisory moderate+ novo
    // reprova (a lista não é um wildcard), e uma exceção que o tempo já
    // consertou aparece como sobra, para ser removida em vez de acumular.
    expect(moderatePlus).toEqual(allowlisted);
  });

  it('a política real do repositório passa o audit-ci', () => {
    if (!auditReachable) {
      return;
    }

    expect(realAuditCiExit).toBe(0);
  });
});
