import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * O cleanup do drill de deploy nunca rodou
 * =========================================
 *
 * `scripts/test-deploy.sh` termina removendo as imagens que criou, e nunca
 * removeu nenhuma. O filtro era:
 *
 *     docker image ls --filter "reference=${IMAGE_PREFIX}*" -q
 *
 * com `IMAGE_PREFIX="deploy-drill"`, ou seja `deploy-drill*`.
 *
 * O glob do filtro `reference` do Docker segue o `filepath.Match` do Go, em que
 * `*` **não** atravessa `/`. E o filtro compara contra `repo:tag`, que tem
 * barra. Então `deploy-drill*` casa `deploy-drill:v1` e nunca
 * `deploy-drill/v1-estavel:latest`, que é como o drill nomeia tudo.
 *
 * Medido na máquina, com 10 imagens do drill existindo:
 *
 *     deploy-drill*          -> 0
 *     deploy-drill/*         -> 7
 *     deploy-drill/v*        -> 3
 *
 * O pior detalhe é que o vazio parecia sucesso. O `2>/dev/null`, o `|| true` e o
 * pipeline sem `pipefail` faziam um filtro que não casa nada parecer uma
 * limpeza que não tinha trabalho a fazer. Cada execução do drill deixava ~3,4 GB
 * de imagem atrás — e o drill roda em CI.
 *
 * O conserto filtra pelo repositório com `awk`, que casa o prefixo de verdade.
 * Os testes abaixo exercitam o `awk` contra casos reais, porque o bug era
 * justamente do tipo que passa em revisão: o comando parece Obviously correto.
 */

const SCRIPT = readFileSync(resolve(process.cwd(), 'scripts/test-deploy.sh'), 'utf8');

/**
 * O `awk` exato que o `remove_drill_images` do script usa, extraído do próprio
 * script em vez de reescrito aqui. Reescrever seria copiar a lógica defeituosa
 * para o teste — e o defeito é justamente o tipo que sobrevive a uma cópia
 * fiel, porque o teste passaria com o mesmo `awk` quebrado.
 */
/**
 * O pipeline de filtro do `remove_drill_images`, extraído do script e com o
 * `docker images` trocado por `cat`.
 *
 * Testar o `awk` reescrito aqui não serviria para nada: o defeito era do tipo
 * que sobrevive a uma cópia fiel, porque o teste passaria com a mesma lógica
 * errada. Então o teste executa o comando que o script executa, e só troca a
 * fonte dos dados — de verdade para lista real de `docker images` para a
 * entrada controlada do teste.
 */
const filtroDoScript = (): string => {
  const linhas = SCRIPT.split('\n');
  // Começa no `docker images`, não no `awk`: o `awk` está na linha seguinte, e
  // o pipeline inteiro é um comando só. Procurar pelo `awk` perderia a fonte.
  const inicio = linhas.findIndex((l) => l.includes('docker images --format'));
  if (inicio === -1) {
    throw new Error('remove_drill_images não filtra mais imagens; ajuste este teste');
  }

  // Junta a continuação com `\`: o pipeline é um comando só.
  let cmd = linhas[inicio].trim();
  for (let i = inicio + 1; cmd.endsWith('\\'); i++) {
    cmd = `${cmd.trimEnd().slice(0, -1)} ${linhas[i].trim()}`;
  }

  // Troca só a FONTE dos dados: `docker images ...` vira `cat`. O `awk` e o
  // `sort` ficam exatamente como o script escreve, com as aspas que o shell
  // consome.
  //
  // O `while read ... done` sai: ele é o laço de `rmi`, e o que se quer medir aqui
  // é a LISTA que o filtro produz. A fonte e o filtro ficam; só o consumidor sai.
  const fonte = 'docker images --format \'{{.ID}} {{.Repository}}\' 2>/dev/null';
  if (!cmd.includes(fonte)) {
    throw new Error(`não reconheci a fonte de imagens: ${cmd}`);
  }

  return cmd
    .replace(fonte, 'cat')
    .replace(/\s*\|\s*while read -r id; do[\s\S]*$/, '')
    .replace('"${IMAGE_PREFIX}/"', '"deploy-drill/"')
    .trim();
};

/** Os IDs que o filtro do script devolve para uma lista de imagens. */
const repoFilter = (input: string): string[] =>
  execFileSync('bash', ['-c', filtroDoScript()], { input, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();

describe('o cleanup do drill de deploy remove as imagens que criou', () => {
  it('o script não usa mais o glob que não atravessa a barra', () => {
    // `reference=deploy-drill*` é o defeito. Se voltar, o drill volta a vazar.
    // As linhas de comentário que CITAM o glob apagado estão de fora: são o
    // registro de por que ele foi trocado, e um teste que as confundisse com o
    // código obrigaria a apagar a explicação para passar.
    const codigo = SCRIPT.split('\n')
      .filter((linha) => !linha.trimStart().startsWith('#'))
      .join('\n');

    expect(codigo).not.toMatch(/--filter\s+"reference=/);
    expect(codigo).not.toMatch(/reference=\$\{IMAGE_PREFIX\}/);
  });

  it('a remoção casa imagens com barra no repositório', () => {
    // A linha que reprova o bug: `deploy-drill` casa como repositório
    // EXATAMENTE, e o drill sempre nomeia com subcaminho.
    const input = [
      'aaa111 deploy-drill/v1-estavel',
      'aaa111 deploy-drill/v2-estavel',
      'bbb222 deploy-drill/auth-service',
      'ccc333 deploy-drill',
      'ddd444 outro-projeto/app'
    ].join('\n');

    expect(repoFilter(input)).toEqual(['aaa111', 'bbb222']);
  });

  it('não apaga imagem cujo nome só começa igual', () => {
    // `deploy-drill-experimento/app` e `deploy-drill-experiments/app` começam
    // com `deploy-drill` e NÃO são do drill. Um filtro por `startsWith` sem a
    // barra apagaria as duas.
    const input = [
      'aaa999 deploy-drill-experimento/app',
      'bbb888 deploy-drill-experiments/app',
      'ccc777 deploy-drill/app'
    ].join('\n');

    expect(repoFilter(input)).toEqual(['ccc777']);
  });

  it('não apaga a imagem `deploy-drill` sem subpasta', () => {
    // O drill nomeia com subpasta. Um repositório chamado `deploy-drill` solto,
    // de outro projeto, não é do drill.
    const input = ['aaa999 deploy-drill', 'bbb888 deploy-drill/app'].join('\n');
    expect(repoFilter(input)).toEqual(['bbb888']);
  });

  it('devolve IDs únicos, porque uma imagem pode ter várias tags', () => {
    // `deploy-drill/auth-service` aparece com tag `latest` e com tag de backup.
    // Sem `sort -u`, o `rmi` roda duas vezes na mesma imagem.
    const input = [
      'aaa111 deploy-drill/auth-service',
      'aaa111 deploy-drill/auth-service',
      'bbb222 deploy-drill/v1-estavel'
    ].join('\n');

    const withDuplicates = repoFilter(input);
    expect(withDuplicates).toEqual(['aaa111', 'bbb222']);
  });

  it('o drill nomeia as imagens com o prefixo que o cleanup filtra', () => {
    // Se alguém mudar `IMAGE_PREFIX`, tem que mudar junto o nome das imagens.
    // Este teste fixa os dois lados: o prefixo declarado e o uso.
    const prefix = SCRIPT.match(/^IMAGE_PREFIX="([^"]+)"/m)?.[1];
    expect(prefix).toBe('deploy-drill');

    // O build do drill precisa usar o mesmo prefixo.
    expect(SCRIPT).toContain('-t "${IMAGE_PREFIX}/${MARKER_V1}"');
    expect(SCRIPT).toContain('"${IMAGE_PREFIX}/${tag}"');
  });

  it('a limpeza de imagens é uma função, e o cleanup a chama', () => {
    // Se alguém voltar a colar o comando inline, o teste do glob volta a ter
    // que cobrir o caminho inteiro.
    expect(SCRIPT).toMatch(/^remove_drill_images\(\)/m);
    expect(SCRIPT).toMatch(/^ {4}remove_drill_images$/m);
  });
});
