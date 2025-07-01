import cluster from 'cluster';
import os from 'os';
import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import compression from 'compression';
import { metricsMiddleware } from './utils/metrics.js';
import { initRedis } from './config/cache.js';
import { requestLogger } from './middleware/requestLogger.js';
import { connectDatabase } from './config/database.js';
import { configurePassport } from './config/passport.js';
import { setupSwagger } from './config/swagger.js';
import { setupErrorHandlers } from './utils/errorHandler.js';
import authRoutes from './routes/authRoutes.js';

// 🔒 NOVOS IMPORTS DE SEGURANÇA
import setupSecurity from './config/helmet.js';
import { sanitizeInput } from './middleware/sanitization.js';
import { securityMonitor } from './middleware/securityMonitoring.js';
import { advancedRateLimit } from './middleware/advancetRateLimit.js';

// Carrega variáveis de ambiente
dotenv.config();

/**
 * Classe principal da aplicação
 */
class AuthService {
  constructor() {
    this.validateEnvironment();
    this.app = express();
    this.setupSecurity(); // 🔒 NOVA CONFIGURAÇÃO DE SEGURANÇA
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSwagger();
  }

  /**
     * Valida se todas as variáveis de ambiente necessárias estão definidas
     */
  validateEnvironment() {
    const required = ['JWT_SECRET', 'JWT_EXPIRES', 'URI_MONGODB'];
    const missing = required.filter(env => !process.env[env]);

    if (missing.length > 0) {
      console.error(`❌ Variáveis obrigatórias não definidas: ${missing.join(', ')}`);
      console.error('💡 Verifique seu arquivo .env');
      throw new Error(`Configuração inválida: ${missing.join(', ')}`);
    }

    // ✅ ADICIONAR: Validar valores específicos
    if (process.env.JWT_SECRET.length < 32) {
      console.warn('⚠️ JWT_SECRET muito curto - recomendado pelo menos 32 caracteres');
    }

    console.log('✅ Variáveis de ambiente validadas');
  }

  /**
     * 🔒 NOVA: Configura segurança avançada
     */
  setupSecurity() {
    console.log('🔒 Configurando segurança avançada...');

    // 1. Headers de segurança (PRIMEIRO)
    setupSecurity(this.app);

    // 2. CORS restritivo
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:8081','http://localhost:8081/login','http://localhost:8081/profile','http://localhost:8081/update', 'http://localhost:8081/delete', 'http://localhost:8081/register'],
      credentials: true,
      optionsSuccessStatus: 200,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    console.log('✅ Segurança configurada com sucesso!');
  }

  setupMiddleware() {
    this.app.use(compression());
    this.app.use(requestLogger);
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(metricsMiddleware);
    this.app.use(sanitizeInput);
    this.app.use((req, res, next) => securityMonitor.detectThreats(req, res, next));
    this.app.use(advancedRateLimit.checkLimits);

    configurePassport();
  }

  /**
     * Configura as rotas da aplicação
     */
  setupRoutes() {
    this.app.use('/', authRoutes);
  }

  /**
     * Configura documentação Swagger
     */
  setupSwagger() {
    setupSwagger(this.app);
  }

  /**
     * Inicia o servidor
     * @param {number} port - Porta para o servidor escutar
     */
  async start(port = process.env.PORT) {
    try {
      // Conecta ao banco de dados
      await connectDatabase();

      // Inicializa Redis para cache
      await initRedis();

      // Inicia servidor HTTPS
      const options = {
        key: fs.readFileSync('server.key'),
        cert: fs.readFileSync('server.crt')
      };

      const server = https.createServer(options, this.app);

      // Passa o servidor para o errorHandler
      setupErrorHandlers(server);

      server.listen(port, () => {
        console.log(`🚀 Servidor HTTPS rodando em https://localhost:${port}`);
        console.log(`📚 Documentação: https://localhost:${port}/api-docs`);
        console.log(`📊 Métricas: https://localhost:${port}/metrics`);
        console.log(`🏥 Health Check: https://localhost:${port}/health`);
        console.log(`🖥️ Worker PID: ${process.pid} | CPUs: ${os.cpus().length}`);
        console.log('🔒 Segurança avançada: ativada');
        console.log('✅ Serviços inicializados com sucesso!');
      });

    } catch (error) {
      console.error('❌ Erro ao iniciar servidor:', error);
      process.exit(1);
    }
  }
}

if (cluster.isPrimary) {
  console.log(`Master ${process.pid} está rodando`);

  // Fork workers igual ao número de CPUs
  for (let i = 0; i < os.cpus().length; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️  Worker ${worker.process.pid} morreu (código: ${code}, sinal: ${signal})`);
    const newWorker = cluster.fork();
    console.log(`🔄 Novo worker ${newWorker.process.pid} criado`);
  });
} else {
  // Workers rodam a aplicação
  const authService = new AuthService();
  authService.start(process.env.PORT);
  console.log(`Worker ${process.pid} iniciado`);
}

export default AuthService;
