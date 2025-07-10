import { Router } from 'express';
import { resolve, bootstrapServices } from '../core/bootstrap.js';
import { validateLogin, validateRegister, validateUpdate } from '../middleware/validation.js';
import { prometheus } from '../utils/metrics.js';
import { performHealthCheck } from '../utils/healthCheck.js';
import { advancedRateLimit } from '../middleware/advancetRateLimit.js';
import securityRoutes from './securityRoutes.js';
import { securityAuditLogger } from '../middleware/securityAudit.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: ID único do usuário
 *         username:
 *           type: string
 *           description: Nome de usuário
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Data de criação
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Data da última atualização
 *     LoginRequest:
 *       type: object
 *       required:
 *         - user
 *         - password
 *       properties:
 *         user:
 *           type: string
 *           minLength: 3
 *           description: Nome de usuário
 *         password:
 *           type: string
 *           minLength: 6
 *           description: Senha do usuário
 *     LoginResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             user:
 *               $ref: '#/components/schemas/User'
 *             token:
 *               type: string
 *               description: JWT token
 *     RegisterRequest:
 *       type: object
 *       required:
 *         - user
 *         - password
 *       properties:
 *         user:
 *           type: string
 *           minLength: 3
 *           description: Nome de usuário
 *         password:
 *           type: string
 *           minLength: 6
 *           description: Senha do usuário
 *     UpdateRequest:
 *       type: object
 *       properties:
 *         user:
 *           type: string
 *           minLength: 3
 *           description: Novo nome de usuário (opcional)
 *         password:
 *           type: string
 *           minLength: 6
 *           description: Nova senha (opcional)
 *     StandardResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         errors:
 *           type: array
 *           items:
 *             type: object
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */

/**
 * Cria e configura as rotas de autenticação
 */
export function createAuthRoutes() {
  const router = Router();

  // Bootstrap dos serviços primeiro
  bootstrapServices();

  // Resolver dependências do container
  const authController = resolve('authController');
  const authMiddleware = resolve('authMiddleware');

  /**
   * @swagger
   * /login:
   *   post:
   *     summary: Autenticar usuário
   *     description: Realiza login do usuário e retorna JWT token
   *     tags: [Autenticação]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/LoginRequest'
   *     responses:
   *       200:
   *         description: Login realizado com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/LoginResponse'
   *       400:
   *         description: Dados inválidos
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Credenciais inválidas
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post('/login', validateLogin, authController.login);

  /**
   * @swagger
   * /register:
   *   post:
   *     summary: Registrar novo usuário
   *     description: Cria uma nova conta de usuário
   *     tags: [Autenticação]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterRequest'
   *     responses:
   *       201:
   *         description: Usuário registrado com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StandardResponse'
   *       400:
   *         description: Dados inválidos ou usuário já existe
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post('/register', validateRegister, authController.register);

  /**
   * @swagger
   * /profile:
   *   get:
   *     summary: Obter perfil do usuário
   *     description: Retorna informações do usuário autenticado
   *     tags: [Perfil]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Perfil obtido com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StandardResponse'
   *       401:
   *         description: Token inválido ou não fornecido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Usuário não encontrado
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/profile', authMiddleware.authenticate, authController.getProfile);

  /**
   * @swagger
   * /update:
   *   put:
   *     summary: Atualizar perfil do usuário
   *     description: Atualiza informações do usuário autenticado
   *     tags: [Perfil]
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/UpdateRequest'
   *     responses:
   *       200:
   *         description: Perfil atualizado com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StandardResponse'
   *       400:
   *         description: Dados inválidos
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Token inválido ou não fornecido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.put('/update', authMiddleware.authenticate, validateUpdate, authController.updateProfile);

  /**
   * @swagger
   * /delete:
   *   delete:
   *     summary: Deletar perfil do usuário
   *     description: Remove permanentemente a conta do usuário autenticado
   *     tags: [Perfil]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Perfil deletado com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StandardResponse'
   *       400:
   *         description: Erro ao deletar perfil
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Token inválido ou não fornecido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.delete('/delete', authMiddleware.authenticate, authController.deleteProfile);

  // Rotas de sistema
  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Health Check
   *     description: Verifica a saúde da aplicação e serviços conectados
   *     tags: [Sistema]
   *     responses:
   *       200:
   *         description: Sistema saudável
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [healthy, degraded, unhealthy]
   *                 timestamp:
   *                   type: string
   *                   format: date-time
   *                 responseTime:
   *                   type: string
   *                 version:
   *                   type: string
   *                 environment:
   *                   type: string
   *                 services:
   *                   type: object
   *                   properties:
   *                     mongodb:
   *                       type: object
   *                       properties:
   *                         status:
   *                           type: string
   *                         state:
   *                           type: string
   *                     redis:
   *                       type: object
   *                       properties:
   *                         status:
   *                           type: string
   *                         ping:
   *                           type: string
   *       503:
   *         description: Sistema com problemas
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                 error:
   *                   type: string
   */
  router.get('/health', async(req, res) => {
    try {
      const result = await performHealthCheck();
      const statusCode = result.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(result);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Erro ao executar health check',
        error: error.message
      });
    }
  });

  /**
   * @swagger
   * /metrics:
   *   get:
   *     summary: Métricas Prometheus
   *     description: Retorna métricas da aplicação no formato Prometheus
   *     tags: [Sistema]
   *     responses:
   *       200:
   *         description: Métricas obtidas com sucesso
   *         content:
   *           text/plain:
   *             schema:
   *               type: string
   *               example: |
   *                 # HELP http_requests_total Total number of HTTP requests
   *                 # TYPE http_requests_total counter
   *                 http_requests_total{method="GET",route="/health",status_code="200"} 5
   *       500:
   *         description: Erro ao gerar métricas
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/metrics', async(req, res) => {
    try {
      res.set('Content-Type', prometheus.register.contentType);
      const metrics = await prometheus.register.metrics();
      res.end(metrics);
    } catch (error) {
      console.error('Erro ao gerar métricas:', error);
      res.status(500).json({
        status: 'error',
        message: 'Erro ao gerar métricas',
        error: error.message
      });
    }
  });

  // Rotas de debug (apenas em desenvolvimento)
  if (process.env.NODE_ENV === 'development') {
    /**
     * @swagger
     * /debug/ratelimit:
     *   get:
     *     summary: Status do Rate Limit
     *     description: Retorna informações sobre os rate limits configurados (apenas em desenvolvimento)
     *     tags: [Debug]
     *     responses:
     *       200:
     *         description: Status dos rate limits
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 limits:
     *                   type: object
     *                 blocked:
     *                   type: array
     *                 stats:
     *                   type: object
     */
    router.get('/debug/ratelimit', (req, res) => {
      res.json(advancedRateLimit.getStatus());
    });

    /**
     * @swagger
     * /debug/ratelimit/reset:
     *   post:
     *     summary: Resetar Rate Limits
     *     description: Reseta todos os contadores de rate limit (apenas em desenvolvimento)
     *     tags: [Debug]
     *     responses:
     *       200:
     *         description: Rate limits resetados
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     */
    router.post('/debug/ratelimit/reset', (req, res) => {
      advancedRateLimit.resetLimits();
      res.json({ message: 'Rate limits resetados' });
    });

    /**
     * @swagger
     * /debug/ratelimit/update:
     *   post:
     *     summary: Atualizar Rate Limits
     *     description: Atualiza configurações de rate limit (apenas em desenvolvimento)
     *     tags: [Debug]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               ipPoints:
     *                 type: number
     *                 description: Limite de requisições por IP
     *               loginPoints:
     *                 type: number
     *                 description: Limite de tentativas de login
     *     responses:
     *       200:
     *         description: Configuração atualizada
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 message:
     *                   type: string
     *                 newConfig:
     *                   type: object
     */
    router.post('/debug/ratelimit/update', (req, res) => {
      const success = advancedRateLimit.updateConfig(req.body);
      res.json({
        success,
        message: success ? 'Configuração atualizada' : 'Atualização não permitida',
        newConfig: advancedRateLimit.getStatus().config
      });
    });
  }

  // Rotas de segurança (dashboard e monitoramento)
  router.use('/security', securityRoutes);

  return router;
}

// Export padrão para compatibilidade
export default createAuthRoutes();
