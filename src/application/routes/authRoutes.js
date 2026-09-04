import { Router } from 'express';
import { resolve, bootstrapServices } from '../../core/bootstrap.js';
import { validateLogin, validateRegister, validateUpdate, validateRefresh } from '../middleware/validation.js';
import { prometheus } from '../../shared/utils/metrics.js';
import { performHealthCheck } from '../../shared/utils/healthCheck.js';
import { advancedRateLimit } from '../middleware/advancedRateLimit.js';
import securityRoutes from './securityRoutes.js';
import { HttpError } from '../../shared/utils/errorHandler.js';

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
 *           maxLength: 30
 *           pattern: "^[A-Za-z0-9_-]+$"
 *           description: Nome de usuário (letras, números, underscore e hífen)
 *         password:
 *           type: string
 *           minLength: 12
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
 *             accessToken:
 *               type: string
 *               description: Access token JWT para chamadas autenticadas
 *             refreshToken:
 *               type: string
 *               description: Refresh token JWT para renovação
 *             tokenType:
 *               type: string
 *               example: Bearer
 *             expiresIn:
 *               type: integer
 *               format: int64
 *               description: Validade do access token em milissegundos
 *     RegisterRequest:
 *       type: object
 *       required:
 *         - user
 *         - password
 *       properties:
 *         user:
 *           type: string
 *           minLength: 3
 *           maxLength: 30
 *           pattern: "^[A-Za-z0-9_-]+$"
 *           description: Nome de usuário (letras, números, underscore e hífen)
 *         password:
 *           type: string
 *           minLength: 12
 *           description: Senha do usuário
 *     UpdateRequest:
 *       type: object
 *       properties:
 *         user:
 *           type: string
 *           minLength: 3
 *           maxLength: 30
 *           pattern: "^[A-Za-z0-9_-]+$"
 *           description: Novo nome de usuário (opcional)
 *         password:
 *           type: string
 *           minLength: 12
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
   * /refresh:
   *   post:
   *     summary: Renovar tokens de acesso
   *     description: Usa um refresh token válido para emitir um novo par (access + refresh) e revoga o refresh antigo
   *     tags: [Autenticação]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - refreshToken
   *             properties:
   *               refreshToken:
   *                 type: string
   *                 description: Refresh token válido (emitido no login ou no refresh anterior)
   *     responses:
   *       200:
   *         description: Tokens renovados com sucesso
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
   *         description: Refresh token inválido, revogado ou expirado
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post('/refresh', validateRefresh, authController.refresh);

  /**
   * @swagger
   * /logout:
   *   post:
   *     summary: Encerrar sessão e revogar tokens
   *     description: Revoga o access token (Authorization) e o refresh token informado no corpo
   *     tags: [Autenticação]
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               refreshToken:
   *                 type: string
   *                 description: Refresh token a revogar (opcional)
   *     responses:
   *       200:
   *         description: Logout realizado com sucesso
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/StandardResponse'
   *       400:
   *         description: Nenhum token pôde ser revogado
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post('/logout', authMiddleware.optionalAuth, authController.logout);

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
  router.get('/health', async(req, res, next) => {
    try {
      const result = await performHealthCheck();
      const statusCode = result.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(result);
    } catch {
      next(new HttpError(500, 'HEALTH_CHECK_FAILED', 'Erro ao executar health check'));
    }
  });

  const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
  const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
  const metricsEndpoint = process.env.METRICS_ENDPOINT || '/metrics';

  if (METRICS_ENABLED) {
    if (process.env.NODE_ENV === 'production' && !METRICS_TOKEN) {
      console.warn(`⚠️ ${metricsEndpoint} exposto SEM token de autenticação em produção. Configure METRICS_TOKEN.`);
    }

    const requireMetricsToken = (req, res, next) => {
      if (!METRICS_TOKEN) {
        return next();
      }
      if (req.get('x-metrics-token') !== METRICS_TOKEN) {
        return next(new HttpError(401, 'METRICS_FORBIDDEN', 'Acesso não autorizado às métricas'));
      }
      return next();
    };

    /**
     * @swagger
     * /metrics:
     *   get:
     *     summary: Métricas Prometheus
     *     description: Retorna métricas da aplicação no formato Prometheus (protegido por METRICS_TOKEN quando configurado)
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
     *       401:
     *         description: Token de métricas ausente ou inválido
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ErrorResponse'
     *       500:
     *         description: Erro ao gerar métricas
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ErrorResponse'
     */
    router.get(metricsEndpoint, requireMetricsToken, async(req, res, next) => {
      try {
        res.set('Content-Type', prometheus.register.contentType);
        const metrics = await prometheus.register.metrics();
        res.end(metrics);
      } catch {
        next(new HttpError(500, 'METRICS_FAILED', 'Erro ao gerar métricas'));
      }
    });
  }

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
      advancedRateLimit.reset();
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
