import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';

/**
 * Configura a documentação Swagger
 * @param {import('express').Express} app - Instância do Express
 */
export const setupSwagger = (app) => {
  const options = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'API de Autenticação',
        version: '1.0.0',
        description: `
          ## Microserviço de Autenticação
          
          Esta API fornece endpoints para autenticação e gerenciamento de usuários usando JWT tokens.
          
          ### Funcionalidades:
          - ✅ Login e registro de usuários
          - ✅ Autenticação via JWT tokens
          - ✅ Gerenciamento de perfil de usuário
          - ✅ Health check e métricas
          - ✅ Rate limiting avançado
          
          ### Autenticação:
          Para endpoints protegidos, inclua o header:
          \`Authorization: Bearer <seu_jwt_token>\`
        `,
        contact: {
          name: 'Suporte',
          email: 'suporte@exemplo.com'
        }
      },
      servers: [
        {
          url: 'https://localhost:3000',
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
          }
        }
      }
    },
    apis: ['./src/routes/*.js'] // Busca comentários nos arquivos de rotas
  };

  const swaggerSpec = swaggerJSDoc(options);

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
