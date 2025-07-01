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
        description: 'Documentação da API de autenticação com JWT'
      },
      servers: [
        { url: 'https://localhost:3000' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    },
    apis: ['./src/routes/*.js'] // Busca comentários nos arquivos de rotas
  };

  const swaggerSpec = swaggerJSDoc(options);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
};
