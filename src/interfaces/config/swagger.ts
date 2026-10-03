import swaggerUi from 'swagger-ui-express';
import type { Express } from 'express';
import { logger } from '../../shared/utils/logger.js';
import {
  buildOpenApiSpec,
  routeGlob,
  routeGlobMatches,
  type OpenApiDocument
} from './openapiSpec.js';

/**
 * Documento OpenAPI montado na hora em que a documentação é montada.
 *
 * A geração é feita uma vez, no arranque, e não a cada visita ao `/api-docs`:
 * `swagger-jsdoc` faz glob e parse de YAML dos comentários das rotas, e isso a
 * cada request seria trabalho de servidor por um HTML estático.
 */
export const openApiSpec = (): OpenApiDocument | null => {
  const glob = routeGlob();

  if (!routeGlobMatches()) {
    // Não há erro visível para quem abriu a página se isto devolver um
    // documento vazio: a UI sobe, o título aparece e a lista de endpoints fica
    // em branco. Um log de erro e um `/api-docs` que responde 404 dizem o que
    // está acontecendo; um documento vazio não diz nada.
    logger.error('Documento OpenAPI não gerado: nenhum arquivo de rota encontrado', {
      glob,
      cwd: process.cwd()
    });
    return null;
  }

  let spec: OpenApiDocument;
  try {
    spec = buildOpenApiSpec();
  } catch (error) {
    // `failOnErrors` transforma bloco `@swagger` malformado em exceção. Sem o
    // `try`, um `:` a mais numa descrição derrubaria o arranque do serviço por
    // causa da documentação — e a versão publicada não teria página nenhuma,
    // que é o pior dos dois mundos. O relatório vai inteiro para o log porque
    // ele diz qual arquivo e qual linha.
    logger.error('Documento OpenAPI não gerado: erro de YAML nos comentários das rotas', {
      glob,
      report: (error as Error).message
    });
    return null;
  }

  const documented = Object.keys(spec.paths ?? {}).length;

  if (documented === 0) {
    logger.error('Documento OpenAPI gerado sem nenhum endpoint documentado', {
      glob,
      paths: documented
    });
    return null;
  }

  logger.info('Documentação OpenAPI gerada', { glob, endpoints: documented });

  return spec;
};

/**
 * Configura a documentação Swagger.
 *
 * `@param app` - Instância do Express
 */
export const setupSwagger = (app: Express): void => {
  const swaggerSpec = openApiSpec();

  if (!swaggerSpec) {
    // Sem documento não há `/api-docs`: responder 404 é um sintoma visível,
    // enquanto um documento vazio é um sintoma que só aparece quando alguém tenta
    // usar a API a partir da documentação.
    return;
  }

  // Configurações personalizadas do Swagger UI
  const swaggerUiOptions = {
    explorer: true,
    customCss: `
      .swagger-ui .topbar { display: none }
      .swagger-ui .info .title { color: #1f8c4a }
    `,
    customSiteTitle: 'API de Autenticação - Documentação',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true
    }
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
};
