import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Limites operacionais documentados (Fase 6.2 / P5) não podem se destacar do
 * código que os produz.
 *
 * Uma tabela de limites é uma afirmação sobre a configuração. O modo usual de
 * ela mentir é silencioso: alguém ajusta `nofile` ou `max_fails` para resolver
 * um alerta, e a documentação continua afirmando o número antigo. These
 * tests existem para que esse drift reprove em vez de ser descoberto em
 * incidente.
 *
 * Por isso as guardas não comparam a documentação com a si mesma. Cada número
 * citado em `docs/metricas.md` e em `docs/SEGURANCA.md` é conferido contra o
 * arquivo que o produz: o Compose, o conf do nginx ou o runner do k6.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

const metricas = read('docs/metricas.md');
const seguranca = read('docs/SEGURANCA.md');
const composeProd = read('docker-compose.prod.yml');
const nginxProd = read('nginx/nginx-prod.conf');
const ddosRunner = read('scripts/ddos-survival-test.mjs');

const limiteDaBorda = metricas.slice(metricas.indexOf('## 6. Contenção na borda'));

/**
 * Quebra de linha e negrito não devem decidir se uma afirmação existe. O
 * markdown do documento é reescrito à mão com frequência, e um teste que
 * quebra junto com ele vira um teste que ninguém conserta — pior do que
 * nenhum teste. Aqui a comparação é sobre o texto corrido.
 */
const flatten = (text: string) => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

describe('limites operacionais documentados', () => {
  describe('a seção de contenção existe e diz o que não mediu', () => {
    it('tem a tabela de medição da borda', () => {
      expect(limiteDaBorda).toContain('## 6. Contenção na borda');
      for (const metrica of [
        'Respostas limited-as (429)',
        'Falhas de liveness',
        'Respostas 5xx',
        'Slowloris',
        'Pico de memória por container',
        'Reinícios de container'
      ]) {
        expect(limiteDaBorda).toContain(metrica);
      }
    });

    // A ressalva é o ponto do item. Um relatório que diz "o flood foi absorvido"
    // sem dizer que SYN e amplificação não passam por rate limit de aplicação é
    // um relatório que afirma proteção onde não há.
    it('declara que SYN flood e amplificação ficam fora da medição', () => {
      const texto = flatten(limiteDaBorda);
      expect(texto).toContain('não mede');
      expect(texto).toContain('SYN flood');
      expect(texto).toContain('amplificação');
      // E que o alcance da afirmação é A5/A6, não o modelo inteiro.
      expect(texto).toMatch(/A5.*A6/);
    });

    it('nomeia o primeiro limite a ceder, e ele é o rate limit por IP', () => {
      expect(limiteDaBorda).toContain('Primeiro limite a ceder');
      expect(limiteDaBorda).toMatch(/primeiro recurso a estourar[\s\S]{0,200}por IP/i);
    });
  });

  describe('cada número quoted bate com o arquivo que o produz', () => {
    it('somaxconn 4096: o Compose de produção declara esse valor', () => {
      expect(limiteDaBorda).toContain('somaxconn=4096');
      expect(composeProd).toMatch(/net\.core\.somaxconn:\s*\$\{NET_CORE_SOMAXCONN:-4096\}/);
    });

    it('nofile 8192 na API e 4096 no nginx', () => {
      expect(limiteDaBorda).toContain('nofile` 8192 na API e 4096');
      // A API e o proxy têm limites distintos; conferir só "8192" deixaria a
      // metade do nginx sem cobertura.
      expect(composeProd).toMatch(/soft: 8192\s+hard: 8192/);
      expect(composeProd).toMatch(/soft: 4096\s+hard: 4096/);
    });

    it('max_fails=2 e fail_timeout=5s no upstream do nginx', () => {
      expect(limiteDaBorda).toContain('max_fails=2');
      expect(limiteDaBorda).toContain('fail_timeout=5s');
      expect(nginxProd).toMatch(/max_fails=2 fail_timeout=5s/);
    });

    it('backlog 1024 continua sendo o default do Node, não uma configuração', () => {
      // 1024 é o backlog de listening do Node, não algo declarado no Compose.
      // Documentá-lo como se fosse configuração seria inventar um controle; a
      // ressalva é o que mantém a afirmação honesta.
      expect(limiteDaBorda).toContain('backlog 1024');
      expect(composeProd).not.toContain('backlog');
    });

    it('as chaves citadas na tabela são as que o runner emite', () => {
      // Se o runner renomear uma chave do JSON de saída, a tabela vira
      // citação de um artefato que não existe mais.
      for (const chave of [
        'rateLimited',
        'livenessFailures',
        'serverErrors',
        'slowlorisConnectionsClosed',
        'peakContainerMemoryMiB',
        'containerRestarts',
        'apiReplicasObserved'
      ]) {
        expect(ddosRunner).toContain(chave);
      }
    });

    it('a contagem de réplicas citadas vem de instance_id, não de PID', () => {
      // A lição de P1, preservada como guarda de documentação: um relatório que
      // diz "três réplicas" sem dizer como as contou repete o bug.
      expect(seguranca).toContain('service.instance_id');
      expect(ddosRunner).toContain('readReplicaIdentity');
    });
  });

  describe('a decisão D29 existe e é coerente com a métrica', () => {
    it('está registrada em SEGURANCA.md', () => {
      expect(seguranca).toContain('### D29');
      expect(seguranca).toMatch(/D29[\s\S]{0,200}rate limit por IP/);
    });

    it('reproduz a mesma ressalva de escopo da métrica', () => {
      const d29 = flatten(seguranca.slice(seguranca.indexOf('### D29')));
      expect(d29).toContain('SYN flood');
      expect(d29).toContain('amplificação');
      expect(d29).toMatch(/não constam do modelo A1–A7/);
    });
  });

  describe('afirmações que a medição deixou de sustentar', () => {
    // Estas linhas diziam "medição pendente" / "aguarda host Docker" depois de
    // executadas. Documento que afirma medir menos do que mede é o mesmo defeito
    // de documento que afirma medir mais.
    it('nenhuma ameaça já medida continua declarada como pendente', () => {
      const tabela = seguranca.slice(seguranca.indexOf('### Cobertura do modelo de ataque'));
      for (const ameaça of ['A1/A2', 'A4', 'A5', 'A6', 'A7']) {
        const linha = tabela.split('\n').find(row => row.startsWith(`| ${ameaça}`));
        expect(linha).toBeDefined();
        expect(linha).not.toMatch(/pendente/i);
        expect(linha).not.toMatch(/aguarda host Docker/i);
      }
    });

    it('o failover ativo segue declarado como não provado', () => {
      // A única coisa que a medição de borda não cobre. Declarar como medido
      // seria trocar uma lacuna conhecida por uma afirmação falsa.
      expect(flatten(seguranca)).toMatch(/Failover ativo continua sem prova/);
    });
  });

  describe('o registro de decisões não tem buraco de numeração', () => {
    // D20 morou anos só em `docs/REDIS.md`, com referência cruzada aqui. Quem
    // abre o registro procurando "por que a revogação aceita fail-open quando
    // o volume do Redis some" não achava nada — e a ausência parecia "não há
    // questão aberta", que é a leitura mais perigosa possível de um índice.
    const numeros = [...seguranca.matchAll(/^### D(\d+) — /gm)].map((m) =>
      Number(m[1])
    );

    it('tem D20 e a sequência não pula número entre D1 e o fim', () => {
      expect(numeros).toContain(20);
      const ordenados = [...new Set(numeros)].sort((a, b) => a - b);
      for (let i = 1; i < ordenados.length; i++) {
        // Só a partir de D1: o registro começa em D1 e a ausência de D0 não é
        // buraco, é o começo.
        if (ordenados[i - 1] >= 1) {
          expect(ordenados[i]).toBe(ordenados[i - 1] + 1);
        }
      }
    });

    // Duas visões do mesmo trecho: a achatada para comparar prosa, e a crua
    // para os nomes de variável. O flatten remove `_` junto com o negrito do
    // markdown, e `JWT_EXPIRES` sobrevive à achatagem só por acidente — não é por ele
    // que se casa um nome de environment.
    const d20Bruto = () =>
      seguranca.slice(
        seguranca.indexOf('### D20 —'),
        seguranca.indexOf('### D21 —')
      );
    const d20 = () => flatten(d20Bruto());

    it('D20 registra a decisão tomada, e ela é "limite aceito", não "resolvido"', () => {
      // A P11 decidiu aceitar o limite. A linha que mais importa aqui é a que
      // impede a leitura preguiçosa: "está no registro" não é o mesmo que "está
      // resolvido", e um registro que deixa isso ambíguo serve para encobrir.
      const d = d20();
      expect(d).toMatch(/Status: aceito como limite/);
      expect(d).not.toMatch(/Status: em aberto/);
      // Um título de seção que ainda diz "continua em aberto" contradiz o status
      // novo, e é a leitura que o leitor faz primeiro — a do subtítulo.
      expect(d).not.toMatch(/Por que continua em aberto/);
      // Aceitar o limite e parar de descrevê-lo não é a mesma coisa.
      expect(d).toMatch(/fail-open de fato/);
      expect(d).toMatch(/7 dias/);
      // E as duas saídas continuam documentadas como não escolhidas: um risco
      // aceito hoje é uma dívida, e dívida precisa ter endereço.
      expect(d).toMatch(/promote manual/);
      expect(d).toMatch(/também no Mongo|tambem no Mongo/);
    });

    it('a janela de exposição citada bate com os TTL que o código usa', () => {
      // "15 min" e "7 dias" não são arredondamento de texto: são a janela real
      // que o limite aceita. Se alguém mudar JWT_REFRESH_EXPIRES, o número do
      // registro passa a mentir em silêncio — que é como documento de risco
      // deixa de ser consultável.
      const appConfig = read('src/interfaces/config/appConfig.ts');
      const envExample = read('.env.example');
      for (const [variavel, valor] of [
        ['JWT_EXPIRES', '15m'],
        ['JWT_REFRESH_EXPIRES', '7d']
      ] as const) {
        expect(appConfig).toContain(`${variavel} || '${valor}'`);
        expect(envExample).toContain(`${variavel}=${valor}`);
      }
      expect(d20Bruto()).toMatch(/JWT_EXPIRES=15m/);
      expect(d20Bruto()).toMatch(/JWT_REFRESH_EXPIRES=7d/);
    });

    it('o custo aceito tem drill que o mede, e não só prosa', () => {
      // Risco aceito sem forma de reconferir deixa de ser aceito e vira
      // esquecido. O drill existe para isso — e o teste exige que o registro
      // aponte para ele, senão ninguém descobre que parou de rodar.
      const pkg = JSON.parse(read('package.json')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['test:redis:volume-loss']).toContain('--volume-loss');
      expect(d20()).toMatch(/test:redis:volume-loss/);
      // E o drill declara o sinal que o serviço dá: nenhum. É o que torna o
      // risco silencioso, e o registro não pode suavizar isso.
      expect(d20()).toMatch(/0 erros no log|nenhum erro no log/);
    });

    it('as três entradas que descrevem a lacuna não se contradizem', () => {
      // D20 (registro), REDIS.md (discussão) e ARQUITETURA.md (topologia)
      // descrevem o mesmo buraco. Se uma mudar de juízo, o leitor lê as outras
      // duas e conclui que a decisão não existe.
      const redis = flatten(read('docs/REDIS.md'));
      const arq = flatten(read('docs/ARQUITETURA.md'));
      for (const doc of [redis, arq]) {
        expect(doc).toMatch(/fail-open de fato|D20/);
        expect(doc).toMatch(/aceito|em aberto/);
      }
      // A topologia é onde o risco vive: se o registro aponta para a
      // ARQUITETURA e ela não tem a seção, o aceite é promessa sem lugar.
      expect(arq).toMatch(/Limite aceito: a revogação em nó único \(D20\)/);
      expect(arq).toMatch(/SPOF/);
    });
  });
});
