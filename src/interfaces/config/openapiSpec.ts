/**
 * Documento OpenAPI da API, em um lugar só.
 *
 * Este módulo existe porque a configuração do Swagger tinha **duas** entradas
 * que se anulavam:
 *
 * ```ts
 * apis: ['./src/routes/*.ts']
 * ```
 *
 * `./src/routes` não existe — as rotas estão em `src/application/routes`. O glob
 * não casa com nada, e o `swagger-jsdoc` devolve um documento com
 * `paths: {}` e **sem erro nenhum**: a UI abria, o título aparecia, a lista de
 * endpoints ficava vazia. É a falha que não se nota sozinha.
 *
 * A correção tem uma parte que o item original do checklist não menciona e que
 * é a difícil: a imagem de produção **não tem os arquivos `.ts`** (o `Dockerfile`
 * copia só `dist/`), então apontar para o glob das rotas em TypeScript deixa o
 * documento vazio em produção — trocaria um bug por outro, e os dois pareciam
 * corretos na máquina de desenvolvimento.
 *
 * A saída é ler os comentários de onde o código realmente saiu. O `tsconfig`
 * está com `removeComments: false`, então o `dist/application/routes/*.js`
 * preserva os blocos `@swagger`; e `import.meta.url` termina em `.ts` quando o
 * processo roda pelo `tsx` e em `.js` quando roda o compilado. Um glob só, e ele
 * acompanha o código em execução: um `dist` velho não diverge de si mesmo.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJSDoc from 'swagger-jsdoc';
import { displayVersion, packageRoot } from '../../shared/utils/version.js';

/** Documento OpenAPI mínimo para tipar o retorno sem trazer o pacote inteiro. */
export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: { name?: string; email?: string };
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

/**
 * Glob das rotas, absoluto, em função de **como** o código está rodando.
 *
 * `runningCompiled` é uma entrada e não um `import.meta.url` lido aqui porque é
 * isso que torna o comportamento verificável: o teste exercita os dois lados
 * da decisão no mesmo processo, em vez de depender de existir um `dist` na
 * máquina. Sem isso, "em produção lê `dist`" só se prova rodando a build — e o
 * gate que falharia é justamente o que ninguém executa no caminho errado.
 */
export const routeGlobFor = (runningCompiled: boolean, root: string): string => join(
  root,
  runningCompiled ? 'dist' : 'src',
  'application',
  'routes',
  runningCompiled ? '*.js' : '*.ts'
);

/**
 * Glob das rotas para o processo atual.
 *
 * `import.meta.url` termina em `.ts` quando o processo roda pelo `tsx` e em
 * `.js` quando roda o compilado — os dois layouts deixam a raiz do pacote três
 * níveis acima, então `packageRoot()` funciona nos dois.
 */
export const routeGlob = (): string => routeGlobFor(
  fileURLToPath(import.meta.url).endsWith('.js'),
  packageRoot()
);

/**
 * O glob casa com alguma coisa?
 *
 * Distingue "documento vazio" de "documento pequeno" em tempo de execução. Sem
 * isto, um glob errado em produção continuaria sendo um `/api-docs` bonito e
 * vazio, e o único sinal seria alguém reclamando que não achou `/login` na doc.
 */
export const routeGlobMatches = (): boolean => {
  const glob = routeGlob();
  const extension = glob.slice(glob.lastIndexOf('.') + 1);
  const base = glob.slice(0, glob.lastIndexOf('*'));
  const files = ['authRoutes', 'observabilityRoutes', 'securityRoutes']
    .map((name) => `${base}${name}.${extension}`);

  return files.some((file) => existsSync(file));
};

/**
 * Definição que **não** vem dos comentários das rotas.
 *
 * Tudo que os comentários `@swagger` já descrevem fica de fora de propósito:
 * duplicar aqui é garantir que existem dois lugares para atualizar quando
 * alguém acrescentar um endpoint.
 */
export const staticDefinition = (): Record<string, unknown> => ({
  openapi: '3.0.0',
  info: {
    // Derivada do `package.json`: a versão exibida na documentação e a do
    // pacote não podem divergir, e dois lugares manuais divergem.
    version: displayVersion(),
    title: 'API de Autenticação',
    description: `
      ## Microserviço de Autenticação

      Esta API fornece endpoints para autenticação e gerenciamento de usuários usando JWT tokens.

      ### Funcionalidades:
      - Login e registro de usuários
      - Autenticação via JWT tokens
      - Gerenciamento de perfil de usuário
      - Health check e manifesto de observabilidade
      - Rate limiting avançado

      ### Autenticação:
      Para endpoints protegidos, inclua o header:
      \`Authorization: Bearer <seu_jwt_token>\`

      ### Rotas
      As rotas são montadas na raiz do serviço (\`/\`), não sob um prefixo
      \`/auth\`. \`PUT /update\` é a atualização de perfil e \`DELETE /delete\` a
      exclusão de conta.
    `,
    contact: {
      name: 'Suporte',
      email: 'suporte@exemplo.com'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Servidor de desenvolvimento'
    }
  ],
  tags: [
    {
      name: 'Autenticação',
      description: 'Endpoints para login e registro de usuários'
    },
    {
      name: 'Perfil',
      description: 'Operações de gerenciamento de perfil do usuário'
    },
    {
      name: 'Sistema',
      description: 'Endpoints de monitoramento e saúde do sistema'
    },
    {
      name: 'Debug',
      description: 'Ferramentas de debug (apenas em desenvolvimento)'
    }
  ],
  components: {
    schemas: {
      TokenPair: {
        type: 'object',
        required: ['accessToken', 'refreshToken', 'tokenType', 'expiresIn'],
        properties: {
          accessToken: {
            type: 'string',
            description: 'Token de curta duração usado no header Authorization'
          },
          refreshToken: {
            type: 'string',
            description: 'Token de longa duração usado para renovar o access token'
          },
          tokenType: {
            type: 'string',
            example: 'Bearer'
          },
          expiresIn: {
            type: 'integer',
            format: 'int64',
            description: 'Tempo de validade do access token em milissegundos'
          }
        }
      }
    },
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token JWT obtido no endpoint de login'
      },
      // `x-metrics-token` e `x-security-token`: os dois middlewares aceitam a
      // ausência do token fora de produção, e o OpenAPI não tem como expressar
      // "condicional" — declarar o esquema e escrever na descrição qual é a
      // condição deixa isso explícito em vez de implícito.
      metricToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-metrics-token',
        description: 'Exigido quando METRICS_TOKEN está configurado'
      },
      securityToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-security-token',
        description: 'Exigido quando SECURITY_TOKEN está configurado'
      }
    }
  }
});
/**
 * Documento final: definição estática + comentários `@swagger` das rotas.
 *
 * Uma função só, chamada pelo mesmo código que roda em desenvolvimento e em
 * produção. A alternativa — gerar um `openapi.json` no build e ler o arquivo em
 * runtime — foi descartada: seria o segundo caminho, e um artefato desatualizado
 * documentando uma versão que já não está no ar é pior que gerar na hora.
 *
 * `failOnErrors: true` é o ponto mais importante desta função. Sem ele, um bloco
 * `@swagger` com YAML inválido é **descartado em silêncio**: a biblioteca
 * imprime `Not all input has been taken into account` no console e segue
 * montando o documento sem aquele trecho. Foi exatamente o que aconteceu com os
 * schemas deste serviço — uma descrição com `exigida: step-up` sem aspas
 * derrubou o bloco `components` inteiro do `authRoutes.ts`, e cada `$ref` de
 * `#/components/schemas/LoginRequest` passou a apontar para o nada, com a UI
 * abrindo sem erro nenhum. Com a flag, o mesmo YAML vira uma exceção.
 */
export const buildOpenApiSpec = (apis: string = routeGlob()): OpenApiDocument => swaggerJSDoc({
  definition: staticDefinition(),
  apis: [apis],
  failOnErrors: true
}) as OpenApiDocument;
