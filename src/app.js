import cluster from 'cluster';
import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import compression from 'compression';

// Configurações centralizadas (carrega .env automaticamente)
import {
  serverConfig,
  securityConfig,
  validateConfiguration,
  getConfigSummary
} from './config/appConfig.js';

// Utilitários e middlewares
import { metricsMiddleware } from './utils/metrics.js';
import { initRedis } from './config/cache.js';
import { requestLogger } from './middleware/requestLogger.js';
import { connectDatabase } from './config/database.js';
import { configurePassport } from './config/passport.js';
import { setupSwagger } from './config/swagger.js';
import { setupErrorHandlers } from './utils/errorHandler.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { bootstrapServices } from './core/bootstrap.js';

import setupSecurity from './config/helmet.js';
import { sanitizeInput } from './middleware/sanitization.js';
import { securityMonitor } from './middleware/securityMonitoring.js';
import { advancedRateLimit } from './middleware/advancetRateLimit.js';

/**
 * Classe principal da aplicação
 */
class AuthService {
  constructor() {
    this.validateEnvironment();
    this.app = express();
    this.setupSecurity();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSwagger();
  }

  /**
   * Valida configurações usando sistema centralizado
   */
  validateEnvironment() {
    try {
      validateConfiguration();
      console.log('✅ Configurações validadas com sucesso');

      // Log da configuração (sem dados sensíveis)
      const configSummary = getConfigSummary();
      console.log('🔧 Configuração da aplicação:', JSON.stringify(configSummary, null, 2));

    } catch (error) {
      console.error('❌ Erro na configuração:', error.message);
      console.error('💡 Verifique seu arquivo .env');
      throw error;
    }
  }

  /**
   * Configura segurança usando configurações centralizadas
   */
  setupSecurity() {
    console.log('🔒 Configurando segurança avançada...');

    setupSecurity(this.app);

    this.app.use(cors({
      origin: securityConfig.cors.origins,
      credentials: securityConfig.cors.credentials,
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
    // Bootstrap dos serviços antes de criar as rotas
    bootstrapServices();

    // Criar rotas com dependências injetadas
    const authRoutes = createAuthRoutes();
    this.app.use('/', authRoutes);
  }

  /**
     * Configura documentação Swagger
     */
  setupSwagger() {
    setupSwagger(this.app);
  }

  /**
   * Inicia o servidor usando configurações centralizadas
   */
  async start(port = serverConfig.port) {
    try {
      // Conecta ao banco de dados
      await connectDatabase();

      // Inicializa Redis se habilitado
      await initRedis();

      // Configuração SSL
      if (serverConfig.ssl.enabled) {
        const options = {
          key: fs.readFileSync(serverConfig.ssl.keyPath),
          cert: fs.readFileSync(serverConfig.ssl.certPath)
        };

        const server = https.createServer(options, this.app);
        setupErrorHandlers(server);

        server.timeout = serverConfig.timeout.server;

        server.listen(port, () => {
          console.log(`🚀 Servidor HTTPS rodando em https://${serverConfig.host}:${port}`);
          console.log(`📚 Documentação: https://${serverConfig.host}:${port}/api-docs`);
          console.log(`📊 Métricas: https://${serverConfig.host}:${port}/metrics`);
          console.log(`🏥 Health Check: https://${serverConfig.host}:${port}/health`);
          console.log(`🖥️ Worker PID: ${process.pid} | Cluster: ${serverConfig.cluster.enabled}`);
          console.log('🔒 Segurança avançada: ativada');
          console.log('✅ Serviços inicializados com sucesso!');
        });
      } else {
        // Servidor HTTP para desenvolvimento
        this.app.listen(port, () => {
          console.log(`🚀 Servidor HTTP rodando em http://${serverConfig.host}:${port}`);
          console.log(`📚 Documentação: http://${serverConfig.host}:${port}/api-docs`);
          console.log(`📊 Métricas: http://${serverConfig.host}:${port}/metrics`);
          console.log(`🏥 Health Check: http://${serverConfig.host}:${port}/health`);
          console.log(`🖥️ Worker PID: ${process.pid} | Cluster: ${serverConfig.cluster.enabled}`);
          console.log('⚠️ Modo HTTP (desenvolvimento)');
          console.log('✅ Serviços inicializados com sucesso!');
        });
      }

    } catch (error) {
      console.error('❌ Erro ao iniciar servidor:', error);
      process.exit(1);
    }
  }
}

// Configuração de clustering inteligente
if (cluster.isPrimary && serverConfig.cluster.enabled) {
  console.log(`🔧 Master ${process.pid} iniciando cluster...`);
  console.log(`👥 Configuração: ${serverConfig.cluster.workers} workers (máx: ${serverConfig.cluster.maxWorkers})`);

  // Fork workers conforme configuração
  for (let i = 0; i < serverConfig.cluster.workers; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️ Worker ${worker.process.pid} morreu (código: ${code}, sinal: ${signal})`);

    // Aguarda antes de recriar o worker para evitar loop infinito
    setTimeout(() => {
      const newWorker = cluster.fork();
      console.log(`🔄 Novo worker ${newWorker.process.pid} criado`);
    }, serverConfig.cluster.respawnDelay);
  });

  // Graceful shutdown do cluster
  process.on('SIGTERM', () => {
    console.log('🛑 Recebido SIGTERM, fechando cluster...');
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
  });

} else {
  // Workers ou modo single-process
  const authService = new AuthService();
  authService.start(serverConfig.port);

  if (serverConfig.cluster.enabled) {
    console.log(`👷 Worker ${process.pid} iniciado`);
  } else {
    console.log(`📱 Modo single-process - PID: ${process.pid}`);
  }
}

export default AuthService;
