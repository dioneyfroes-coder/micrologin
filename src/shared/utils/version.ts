/**
 * Versão do serviço em um lugar só.
 *
 * Até aqui a versão aparecia escrita à mão em dois lugares — o
 * `info.version` do Swagger e o `/health` — e mais um terceiro em rótulo de
 * imagem Docker. Três cópias do mesmo número é a forma mais barata de publicar
 * uma versão que não existe: o Swagger dizia 1.0.0, o health respondia 1.0.0 e
 * a imagem era `latest`, todas as três desatualizadas depois do primeiro bump.
 *
 * O número vem do `package.json`, lido em runtime. Duas consequências
 * deliberadas:
 *
 * - não é constante de compilação. `import` de JSON está fora do `rootDir` do
 *   `tsconfig.json` e faria o `tsc` colocar a saída em `dist/src/...`; a leitura
 *   em runtime funciona igual no `tsx` do desenvolvimento e no `dist` compilado,
 *   porque os dois estão três níveis abaixo da raiz do pacote;
 * - o `process.env.npm_package_version` que o `/health` usava **não existe em
 *   produção**. O npm só define essa variável dentro de scripts `npm run`; o
 *   container executa `node dist/app.js` direto, então o health respondia o
 *   fallback `'1.0.0'` hard-coded — exatamente o valor que alguém esquece de
 *   atualizar, e por isso mesmo o pior dos dois.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Profundidade máxima da busca: `src/shared/utils` → raiz são 3 níveis. */
const MAX_DEPTH = 5;

/** Lê `version` de um `package.json`, ou `null` se ele não for um deles. */
const readVersionOrNull = (path: string): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };

    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
};

/**
 * Raiz do pacote, encontrada subindo a árvore a partir deste arquivo.
 *
 * Existe porque `swagger-jsdoc` resolve `apis` por glob **relativo ao
 * `process.cwd()`**: um caminho relativo funciona quando o processo sobe da raiz
 * do repositório e devolve spec vazia — silenciosamente, sem erro — quando não.
 * Caminho absoluto derivado do próprio módulo não depende de onde o serviço foi
 * iniciado.
 */
export const packageRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const found = readVersionOrNull(join(dir, 'package.json'));
    if (found !== null) {
      return dir;
    }
    dir = dirname(dir);
  }

  // A árvore do pacote está montada de um jeito que o walking não entendeu.
  // Qualquer erro de leitura abaixo é reportado por quem chama, e não há versão
  // para inventar.
  return process.cwd();
};

let cached: string | null | undefined;

/**
 * Versão declarada no `package.json`.
 *
 * `null` quando o arquivo não pôde ser lido: quem chama decide o que fazer com
 * isso, e nenhum consumidor pode inventar um número.
 */
export const packageVersion = (): string | null => {
  if (cached !== undefined) {
    return cached;
  }

  cached = readVersionOrNull(join(packageRoot(), 'package.json'));

  return cached;
};

/**
 * Versão para exibir, com um último recurso explícito.
 *
 * Só para exibição (`info` do OpenAPI, `/health`). O fallback é `0.0.0-unknown`
 * em vez de `1.0.0` justamente para não parecer uma versão publicada: quem lê
 * `0.0.0-unknown` no health sabe que o `package.json` não foi encontrado, e quem
 * lê `1.0.0` não sabe de nada.
 */
export const displayVersion = (): string => packageVersion() ?? '0.0.0-unknown';
