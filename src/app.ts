import cluster from 'cluster';
import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import compression from 'compression';
import { pathToFileURL } from 'url';

// Configurações centralizadas (carrega .env automaticamente)
import {
  serverConfig,
  securityConfig,
  validateConfiguration
} from './interfaces/config/appConfig.js';

// Utilitários e middlewares
import { metricsMiddleware } from './shared/utils/metrics.js';
import { initRedis } from './infrastructure/cache/connection.js';
import { requestLogger } from './application/middleware/requestLogger.js';
import { connectDatabase } from './infrastructure/database/connection.js';
import { setupSwagger } from './interfaces/config/swagger.js';
import { errorHandler, setupErrorHandlers } from './shared/utils/errorHandler.js';
import { createAuthRoutes } from './application/routes/authRoutes.js';
import { bootstrapServices, resolve } from './core/bootstrap.js';

import setupSecurity from './interfaces/config/helmet.js';
import { sanitizeInput } from './application/middleware/sanitization.js';
import { securityMonitor } from './application/middleware/securityMonitoring.js';
import { advancedRateLimit } from './application/middleware/advancedRateLimit.js';

/**
 * Classe principal da aplicação
 */
class AuthService {
  app: Express;

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
    } catch (error) {
      console.error('❌ Erro na configuração:', (error as Error).message);
      console.error('💡 Verifique seu arquivo .env');
      throw error;
    }
  }

  /**
   * Configura segurança usando configurações centralizadas
   */
  setupSecurity() {
    setupSecurity(this.app);

    this.app.use(cors({
      origin: securityConfig.cors.origins,
      credentials: securityConfig.cors.credentials,
      optionsSuccessStatus: 200,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));
  }

  setupMiddleware() {
    this.app.use(compression());
    this.app.use(requestLogger);
    this.app.use(express.json({ limit: '100kb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(metricsMiddleware);
    this.app.use(sanitizeInput);
    this.app.use((req: Request, res: Response, next: NextFunction) => securityMonitor.detectThreats(req, res, next));
    this.app.use(advancedRateLimit.checkLimits);
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
    this.app.use(errorHandler);
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
  async start(port = serverConfig.port): Promise<void> {
    try {
      // Conecta ao banco de dados
      await connectDatabase();

      // Inicializa Redis se habilitado
      const redisClient = await initRedis();

      // Promove rate limiters para Redis assim que a conexão estiver disponível
      await advancedRateLimit.init();

      // Conecta a blacklist de JWT ao Redis
      if (redisClient) {
        const jwtService = resolve<{ setRedisClient: (client: typeof redisClient) => void }>('jwtService');
        jwtService?.setRedisClient(redisClient);
      }

      // Configuração SSL
      if (serverConfig.ssl.enabled) {
        const options = {
          key: fs.readFileSync(serverConfig.ssl.keyPath),
          cert: fs.readFileSync(serverConfig.ssl.certPath)
        };

        const server = https.createServer(options, this.app);
        setupErrorHandlers(server, serverConfig.timeout.gracefulShutdown);

        server.timeout = serverConfig.timeout.server;

        server.listen(port, () => {
          console.log(`🚀 Servidor HTTPS rodando em https://${serverConfig.host}:${port}`);
          console.log(`📚 API Docs: https://${serverConfig.host}:${port}/api-docs | 📊 Métricas: https://${serverConfig.host}:${port}/metrics | 🏥 Health: https://${serverConfig.host}:${port}/health`);
        });
      } else {
        // Servidor HTTP para desenvolvimento
        this.app.listen(port, () => {
          console.log(`🚀 Servidor HTTP rodando em http://${serverConfig.host}:${port}`);
          console.log(`📚 API Docs: http://${serverConfig.host}:${port}/api-docs | 📊 Métricas: http://${serverConfig.host}:${port}/metrics | 🏥 Health: http://${serverConfig.host}:${port}/health`);
          if (serverConfig.nodeEnv !== 'production') {
            console.log('⚠️ Modo HTTP (sem SSL)');
          }
        });
      }

    } catch (error) {
      console.error('❌ Erro ao iniciar servidor:', error);
      process.exit(1);
    }
  }
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectExecution) {
  // Configuração de clustering inteligente
  if (cluster.isPrimary && serverConfig.cluster.enabled) {
    console.log(`🔧 Master ${process.pid} iniciando cluster: ${serverConfig.cluster.workers} workers (máx: ${serverConfig.cluster.maxWorkers})`);

    // Fork workers conforme configuração
    for (let i = 0; i < serverConfig.cluster.workers; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      console.error(`⚠️ Worker ${worker.process.pid} morreu (código: ${code}, sinal: ${signal})`);

      // Aguarda antes de recriar o worker para evitar loop infinito
      setTimeout(() => {
        cluster.fork();
      }, serverConfig.cluster.respawnDelay);
    });

    // Graceful shutdown do cluster
    process.on('SIGTERM', () => {
      console.log('🛑 Recebido SIGTERM, fechando cluster...');
      for (const id in cluster.workers) {
        cluster.workers[id]?.kill();
      }
    });

  } else {
    // Workers ou modo single-process
    const authService = new AuthService();
    authService.start(serverConfig.port);
  }
}

export default AuthService;
