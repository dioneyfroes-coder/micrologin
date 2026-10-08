import { describe, it, expect, jest, beforeAll } from '@jest/globals';

/**
 * O documento OpenAPI precisa descrever a API que existe (item 2.3).
 *
 * A configuração anterior apontava `apis: ['./src/routes/*.ts']`, um caminho que
 * não existe. O `swagger-jsdoc` devolve um documento com `paths: {}` e **sem
 * erro**: a UI subia, o título aparecia, e a lista de endpoints ficava vazia.
 * Um documento vazio não é um documento quebrado, e é por isso que isso passou.
 *
 * Os testes abaixo cobrem as quatro formas de o documento estar errado sem
 * ninguém notar:
 *
 * 1. **vazio** — o bug original, e o que a imagem de produção reproduciria se a
 *    correção apontasse para `.ts` (o runtime não tem os `.ts`);
 * 2. **com referências quebradas** — o segundo bug, descoberto aqui: uma
 *    descrição com `:` sem aspas derrubava o bloco `components` inteiro em
 *    silêncio, e todo `$ref` passava a apontar para o nada;
 * 3. **desatualizado** — endpoint novo na rota e ausente no documento;
 * 4. **com versão errada** — a versão vem do `package.json`, e não de uma
 *    segunda cópia escrita à mão.
 *
 * O caminho das rotas é validado em código-fonte e em compilado porque os dois precisam
 * funcionar: `tsx` lê os `.ts` de `src/`, e a imagem de produção só tem os `.js` de
 * `dist/`.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot, packageVersion } from '../../src/shared/utils/version.js';

type Spec = {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

const root = packageRoot();
const routeDir = join(root, 'src', 'application', 'routes');

let spec: Spec;
let specError: Error | null = null;

beforeAll(async() => {
  // Import dinâmico porque o módulo lê o próprio `import.meta.url` para decidir
  // entre os globs de `.ts` e de `.js`; importar no topo do arquivo acontece
  // antes de o jest decidir o transformador.
  const { buildOpenApiSpec } = await import('../../src/interfaces/config/openapiSpec.js');

  try {
    spec = buildOpenApiSpec() as Spec;
  } catch (error) {
    specError = error as Error;
    spec = { openapi: '', info: { version: '' }, paths: {} };
  }
});

/**
 * Coleta todo `$ref` interno do documento e devolve os que não resolvem.
 *
 * É a verificação que substitui "abrir a UI e ver se há warnings": o aviso do
 * Swagger UI **é** referência não resolvida, então resolver toda referência
 * programaticamente cobre o mesmo ground. E roda em CI.
 */
const brokenRefs = (document: Spec): string[] => {
  const broken: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
        const resolved = value
          .slice(2)
          .split('/')
          .reduce<unknown>(
            (current, segment) => (current && typeof current === 'object'
              ? (current as Record<string, unknown>)[segment]
              : undefined),
            document
          );

        if (resolved === undefined) {
          broken.push(`${path}.$ref -> ${value}`);
        }
        continue;
      }
      walk(value, `${path}.${key}`);
    }
  };

  walk(document, '$');

  return broken;
};

describe('OpenAPI - o documento descreve a API que existe', () => {
  it('gera o documento sem erro de YAML nos comentários das rotas', () => {
    // Com `failOnErrors: true`, um bloco `@swagger` com YAML inválido vira
    // exceção. Sem a flag, a biblioteca descarta o bloco e segue montando o
    // documento — foi assim que o bloco `components` inteiro desapareceu.
    expect(specError).toBeNull();
  });

  it('um bloco @swagger com YAML inválido reprova em vez de ser descartado', async() => {
    // A asserção acima passa só porque hoje não há YAML quebrado: ela prova o
    // estado, não a configuração. Este teste prova a configuração, porque
    // reconstrói o defeito original (`:` sem aspas dentro de uma descrição) num
    // arquivo temporário e exige que ele derrube a geração.
    const dir = mkdtempSync(join(tmpdir(), 'openapi-yaml-'));
    const file = join(dir, 'rotaQuebrada.ts');

    writeFileSync(file, [
      '/**',
      ' * @swagger',
      ' * /quebrado:',
      ' *   get:',
      ' *     description: Senha atual (exigida: step-up)',
      ' *     responses:',
      ' *       200:',
      ' *         description: ok',
      ' */',
      ''
    ].join('\n'));

    const { buildOpenApiSpec: build } = await import('../../src/interfaces/config/openapiSpec.js');

    // Sem `failOnErrors`, a biblioteca imprimiria um aviso no console e
    // devolveria um documento sem `/quebrado` — que é a falha silenciosa.
    expect(() => build(join(dir, '*.ts'))).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('documenta os endpoints principais da API', () => {
    // Os caminhos reais. O checklist deste projeto pede `/auth/*`, mas as
    // rotas são montadas na raiz (`app.use('/', authRoutes)`), e mudar o
    // prefixo seria uma quebra de API fora do escopo da 1.0.0. O que muda é o
    // registro: a discrepância fica escrita, e o teste passa a documentar o que
    // o serviço realmente atende.
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/register',
      '/login',
      '/refresh',
      '/logout',
      '/profile',
      '/update',
      '/password',
      '/delete',
      '/health',
      '/liveness',
      '/readiness',
      '/observability'
    ]));

    expect(spec.paths['/login']?.post).toBeDefined();
    expect(spec.paths['/register']?.post).toBeDefined();
    expect(spec.paths['/refresh']?.post).toBeDefined();
    expect(spec.paths['/logout']?.post).toBeDefined();
    expect(spec.paths['/profile']?.get).toBeDefined();
    expect(spec.paths['/update']?.put).toBeDefined();
    expect(spec.paths['/password']?.put).toBeDefined();
    expect(spec.paths['/delete']?.delete).toBeDefined();
  });

  it('não tem nenhuma referência interna quebrada', () => {
    // Este é o teste que pega o segundo bug: `description: Senha atual
    // (exigida: step-up, ...)` sem aspas derrubava o bloco `components` inteiro,
    // e os oito `$ref` de `#/components/schemas/...` ficavam pendurados sem
    // que nada aparecesse no console além de um `console.info`.
    expect(brokenRefs(spec)).toEqual([]);
  });

  it('tem os schemas usados pelas rotas documentados', () => {
    expect(Object.keys(spec.components?.schemas ?? {})).toEqual(expect.arrayContaining([
      'User',
      'LoginRequest',
      'LoginResponse',
      'RegisterRequest',
      'UpdateRequest',
      'ChangePasswordRequest',
      'StandardResponse',
      'ErrorResponse'
    ]));
  });

  it('documenta o BearerAuth usado pelas rotas protegidas', () => {
    expect(spec.components?.securitySchemes?.BearerAuth).toBeDefined();
  });

  it('toda operação documentada tem pelo menos uma resposta', () => {
    // Um `responses: {}` é o que a UI renderiza como "no response body
    // documented", e ninguém nota.
    const semResposta: string[] = [];

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (Object.keys(operation.responses ?? {}).length === 0) {
          semResposta.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(semResposta).toEqual([]);
  });

  it('a versão vem do package.json, não de uma cópia escrita à mão', () => {
    expect(packageVersion()).toBe('1.0.0');
    expect(spec.info.version).toBe(packageVersion());
  });

  it('a versão exibida acompanha o valor lido do pacote', async() => {
    // Comparar a versão do documento com a do `package.json` não prova nada
    // enquanto as duas forem `1.0.0`: a mutação "escrever 1.0.0 no lugar da
    // leitura" passa. Aqui o leitor é substituído por um valor que **não** é a
    // versão do pacote, e o documento precisa acompanhá-lo.
    jest.resetModules();
    jest.unstable_mockModule('../../src/shared/utils/version.js', () => ({
      displayVersion: () => '9.9.9-teste',
      packageVersion: () => '9.9.9-teste',
      packageRoot: () => root
    }));

    const { buildOpenApiSpec: build } = await import('../../src/interfaces/config/openapiSpec.js');

    expect((build() as Spec).info.version).toBe('9.9.9-teste');
  });
});

describe('OpenAPI - o documento não desatualiza em silêncio', () => {
  /**
   * Rotas registradas no código, lidas do fonte.
   *
   * Sem esta checagem, um endpoint novo entra no serviço e some da documentação
   * sem nada reclamar: a lista de `paths` cresce só quando alguém lembra de
   * escrever o comentário.
   *
   * O prefixo vem do `router.use('/security', securityRoutes)` que monta o
   * arquivo, e é lido do fonte em vez de escrito à mão: se o prefixo mudar, o
   * caminho esperado muda junto, e o teste continua dizendo a verdade.
   */
  const mountedPrefix = (): Map<string, string> => {
    const prefixes = new Map<string, string>();
    const files = readdirSync(routeDir).filter((name) => name.endsWith('.ts'));

    for (const file of files) {
      const source = readFileSync(join(routeDir, file), 'utf8');
      const pattern = /router\.use\(\s*'([^']*)'\s*,\s*(\w+)\s*\)/g;
      let match = pattern.exec(source);

      while (match !== null) {
        const [, prefix, moduleName] = match;
        // `securityRoutes` é o router padrão de `securityRoutes.ts`.
        const target = files.find((name) => name.replace(/\.ts$/, '') === moduleName);
        if (target) {
          prefixes.set(target, prefix);
        }
        match = pattern.exec(source);
      }
    }

    return prefixes;
  };

  const registeredRoutes = (): Array<{ method: string; path: string }> => {
    const prefixes = mountedPrefix();
    const found: Array<{ method: string; path: string }> = [];

    for (const file of readdirSync(routeDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(routeDir, file), 'utf8');
      const prefix = prefixes.get(file) ?? '';
      const pattern = /router\.(get|post|put|delete)\(\s*'([^']+)'/g;
      let match = pattern.exec(source);

      while (match !== null) {
        found.push({ method: match[1].toUpperCase(), path: `${prefix}${match[2]}` });
        match = pattern.exec(source);
      }
    }

    return found;
  };

  it('toda rota registrada aparece no documento', () => {
    const faltando = registeredRoutes()
      // Rotas de debug só existem em desenvolvimento e são documentadas junto,
      // então entram na comparação.
      .filter((route) => spec.paths[route.path]?.[route.method.toLowerCase()] === undefined)
      .map((route) => `${route.method} ${route.path}`);

    expect(faltando).toEqual([]);
  });

  it('toda exigência de segurança cita um esquema declarado', () => {
    // Um nome de esquema que não existe em `securitySchemes` é a mesma classe de
    // erro que um `$ref` quebrado: a UI não sabe como montar o cabeçalho. O
    // `metricToken` usado por `/observability` era exatamente esse caso.
    const declared = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
    const pendentes: string[] = [];

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') {
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'security' && Array.isArray(value)) {
          for (const requirement of value) {
            for (const name of Object.keys(requirement as Record<string, unknown>)) {
              if (!declared.has(name)) {
                pendentes.push(`security -> ${name}`);
              }
            }
          }
          continue;
        }
        walk(value);
      }
    };

    walk(spec);

    expect(pendentes).toEqual([]);
  });
});

describe('OpenAPI - o glob de rotas funciona em desenvolvimento e em produção', () => {
  it('acha os arquivos de rota em código-fonte', async() => {
    const { routeGlob, routeGlobMatches, routeGlobFor } = await import('../../src/interfaces/config/openapiSpec.js');

    // Em execução via `tsx`, `import.meta.url` termina em `.ts`.
    expect(routeGlob()).toBe(routeGlobFor(false, root));
    expect(routeGlob()).toMatch(/src[\\/]application[\\/]routes[\\/]\*\.ts$/);
    expect(routeGlobMatches()).toBe(true);
  });

  it('lê o dist quando o código está compilado', async() => {
    // A imagem de produção não tem os `.ts` (o Dockerfile copia só `dist/`), e
    // é o `dist` que preserva os comentários `@swagger` porque o tsconfig está
    // com `removeComments: false`. Se o glob continuasse apontando para `src`
    // em código compilado, o documento de produção seria vazio — e o mesmo
    // teste passaria na máquina de quem conserta, que roda por `tsx`.
    const { routeGlobFor } = await import('../../src/interfaces/config/openapiSpec.js');

    expect(routeGlobFor(true, root)).toMatch(/dist[\\/]application[\\/]routes[\\/]\*\.js$/);
  });

  it('os comentários @swagger sobrevivem à compilação', () => {
    // `removeComments: false` é o que permite ao runtime de produção gerar o
    // mesmo documento a partir de `dist`. Se alguém ligar essa opção, o
    // documento de produção fica vazio — e este teste é o aviso.
    const compiled = join(root, 'dist', 'application', 'routes', 'authRoutes.js');

    let source: string;
    try {
      source = readFileSync(compiled, 'utf8');
    } catch {
      // Sem `dist` local (instalação só com dependências): nada a afirmar aqui,
      // e o gate de build do CI é quem cobre esse caminho.
      return;
    }

    expect(source).toContain('@swagger');
    expect(source).toContain('/login:');
  });

  it('em execução compilada, o glob aponta para o dist', async() => {
    // Única prova do **caboamento** de `routeGlob()`: a decisão é feita lendo o
    // próprio `import.meta.url`, e o valor que ele tem só é observável fora do
    // processo que faz a leitura. Rodando por `tsx` o valor correto já é `false`,
    // então um `routeGlob()` fixo em "sou código-fonte" passa em todos os testes
    // acima e quebraria a documentação de produção.
    //
    // Limitação declarada: exige `dist/`. Sem build local, este teste não roda —
    // é a lacuna de cobertura real do item, e ela está registrada no checklist
    // em vez de ser coberta por um teste que finge cobrir.
    const compiled = join(root, 'dist', 'interfaces', 'config', 'openapiSpec.js');

    if (!existsSync(compiled)) {
      return;
    }

    const { routeGlob: compiledGlob, routeGlobMatches: compiledMatches } = await import(
      /* webpackIgnore: true */ compiled
    ) as { routeGlob: () => string; routeGlobMatches: () => boolean };

    expect(compiledGlob()).toMatch(/dist[\\/]application[\\/]routes[\\/]\*\.js$/);
    expect(compiledMatches()).toBe(true);
  });
});

describe('OpenAPI - /api-docs não sobe com documento vazio', () => {
  it('setupSwagger monta /api-docs com o documento gerado', async() => {
    jest.resetModules();

    const served: unknown[] = [];
    jest.unstable_mockModule('swagger-ui-express', () => ({
      default: {
        serve: (_req: unknown, _res: unknown, next: () => void) => next(),
        setup: (document: unknown) => {
          served.push(document);
          return (_req: unknown, _res: unknown) => undefined;
        }
      }
    }));

    const { setupSwagger } = await import('../../src/interfaces/config/swagger.js');
    const used: string[] = [];
    const app = {
      use: (path: string) => {
        used.push(path);
      }
    } as never;

    setupSwagger(app);

    expect(used).toContain('/api-docs');
    expect(served).toHaveLength(1);
    expect(Object.keys((served[0] as Spec).paths).length).toBeGreaterThan(0);
  });
});
