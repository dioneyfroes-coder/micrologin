import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { authenticateJWT } from '../middleware/auth.js';
import { validateLogin, validateRegister, validateUpdate } from '../middleware/validation.js';
import { prometheus } from '../utils/metrics.js';
import { performHealthCheck } from '../utils/healthCheck.js';
import { advancedRateLimit } from '../middleware/advancetRateLimit.js';

const router = Router();


/**
 * @swagger
 * /login:
 *   post:
 *     summary: Realiza login e retorna um token JWT.
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: string
 *                 example: admin
 *               password:
 *                 type: string
 *                 example: senha123
 *     responses:
 *       200:
 *         description: Token JWT retornado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *       400:
 *         description: Dados inválidos.
 *       401:
 *         description: Usuário ou senha incorretos.
 */
router.post('/login', validateLogin, AuthController.login);

/**
 * @swagger
 * /register:
 *   post:
 *     summary: Registra um novo usuário.
 *     tags: [Usuário]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: string
 *                 example: novo_usuario
 *               password:
 *                 type: string
 *                 example: senhaSegura123
 *     responses:
 *       201:
 *         description: Usuário registrado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Usuário registrado com sucesso
 *       400:
 *         description: Dados inválidos.
 *       409:
 *         description: Usuário já existe.
 *       500:
 *         description: Erro interno do servidor.
 */
router.post('/register', validateRegister, AuthController.register);

/**
 * @swagger
 * /profile:
 *   get:
 *     summary: Obtém os dados do usuário autenticado.
 *     tags: [Usuário]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dados do usuário retornados com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: string
 *       401:
 *         description: Usuário não autenticado.
 *       404:
 *         description: Usuário não encontrado.
 */
router.get('/profile', authenticateJWT, AuthController.getProfile);

/**
 * @swagger
 * /update:
 *   put:
 *     summary: Atualiza os dados do usuário autenticado.
 *     tags: [Usuário]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: string
 *                 example: novo_nome
 *               password:
 *                 type: string
 *                 example: novaSenha123
 *     responses:
 *       200:
 *         description: Usuário atualizado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Usuário atualizado com sucesso
 *       400:
 *         description: Dados inválidos.
 *       401:
 *         description: Não autenticado.
 *       404:
 *         description: Usuário não encontrado.
 */
router.put('/update', authenticateJWT, validateUpdate, AuthController.updateProfile);

/**
 * @swagger
 * /delete:
 *   delete:
 *     summary: Remove o usuário autenticado.
 *     tags: [Usuário]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Usuário removido com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Usuário removido com sucesso
 *       401:
 *         description: Não autenticado.
 *       404:
 *         description: Usuário não encontrado.
 */
router.delete('/delete', authenticateJWT, AuthController.deleteProfile);

/**
 * @swagger
 * /metrics:
 *   get:
 *     summary: Métricas Prometheus para monitoramento.
 *     tags: [Sistema]
 *     responses:
 *       200:
 *         description: Métricas em formato Prometheus.
 *       503:
 *         description: Prometheus não disponível.
 */
router.get('/metrics', async(req, res) => {
  try {
    // Desabilitar compressão para esta rota específica
    res.set('Content-Type', prometheus.register.contentType);
    res.set('Cache-Control', 'no-cache');

    // Aguardar métricas como Promise
    const metricsString = await prometheus.register.metrics();

    // Verificação de segurança
    if (!metricsString || typeof metricsString !== 'string') {
      return res.status(503).json({
        message: 'Métricas indisponíveis',
        error: 'Registry vazio ou inválido'
      });
    }

    // Usar send() em vez de end() para melhor compatibilidade
    res.send(metricsString);

  } catch (error) {
    console.error('❌ Erro ao obter métricas:', error);
    res.status(503).json({
      message: 'Métricas não disponíveis',
      error: error.message
    });
  }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check do serviço
 *     tags: [Sistema]
 *     responses:
 *       200:
 *         description: Serviço saudável
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
 *                 responseTime:
 *                   type: string
 *                 services:
 *                   type: object
 *       503:
 *         description: Serviço não saudável
 */
router.get('/health', async(req, res) => {
  try {
    const healthStatus = await performHealthCheck();

    // Status HTTP baseado na saúde
    const statusCode = healthStatus.status === 'healthy' ? 200 :
      healthStatus.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(healthStatus);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// ✅ Endpoints de debug para rate limiting (apenas em desenvolvimento)
if (process.env.NODE_ENV === 'development') {
  router.get('/debug/ratelimit/status', (req, res) => {
    res.json({
      status: advancedRateLimit.getStatus(),
      headers: {
        'x-forwarded-for': req.get('x-forwarded-for'),
        'x-real-ip': req.get('x-real-ip'),
        'ip': req.ip,
        'ips': req.ips
      }
    });
  });

  router.post('/debug/ratelimit/reset', async(req, res) => {
    await advancedRateLimit.reset();
    res.json({ message: 'Rate limits resetados' });
  });

  router.post('/debug/ratelimit/update', (req, res) => {
    const success = advancedRateLimit.updateConfig(req.body);
    res.json({
      success,
      message: success ? 'Configuração atualizada' : 'Atualização não permitida',
      newConfig: advancedRateLimit.getStatus().config
    });
  });
};

export default router;
