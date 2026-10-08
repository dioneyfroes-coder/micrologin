import cluster from 'cluster';
import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import compression from 'compression';
import { createServer as createHttpServer } from 'http';
import type { Server } from 'http';
import { pathToFileURL } from 'url';

// Configurações centralizadas (carrega .env automaticamente)
import {
  serverConfig,
  validateConfiguration,
  clusterConflict
} from './interfaces/config/appConfig.js';

// Utilitários e middlewares
import { initRedis } from './infrastructure/cache/connection.js';
import { requestLogger } from './application/middleware/requestLogger.js';
import { inFlightLimit } from './application/middleware/inFlightLimit.js';
import { connectDatabase } from './infrastructure/database/connection.js';
import { setupSwagger } from './interfaces/config/swagger.js';
import { errorHandler, setupErrorHandlers } from './shared/utils/errorHandler.js';
import { createAuthRoutes } from './application/routes/authRoutes.js';
import observabilityRoutes from './application/routes/observabilityRoutes.js';
import { bootstrapServices, resolve } from './core/bootstrap.js';

import setupSecurity from './interfaces/config/helmet.js';
import { buildCorsOptions } from './interfaces/config/cors.js';
import { normalizeInput } from './application/middleware/inputNormalization.js';
import { securityMonitor } from './application/middleware/securityMonitoring.js';
import { advancedRateLimit } from './application/middleware/advancedRateLimit.js';
import { logger } from './shared/utils/logger.js';
import { configureHttpServerLimits, httpServerOptions } from './shared/utils/httpServerLimits.js';

/**
 * Classe principal da aplicação
 */
class AuthService {
  app: Express;
  server: Server | null = null;

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
      logger.error('❌ Erro na configuração', error);
      logger.error('💡 Verifique seu arquivo .env');
      throw error;
    }
  }

  /**
   * Configura segurança usando configurações centralizadas
   */
  setupSecurity() {
    // `req.ip` e `req.protocol` dependem disso. Sem Trust Proxy explícito, o
    // padrão é não confiar em X-Forwarded-For, porque o cabeçalho é do cliente.
    this.app.set('trust proxy', serverConfig.proxy.trustProxy);

    setupSecurity(this.app, serverConfig.ssl.enabled);

    this.app.use(cors(buildCorsOptions()));
  }

  setupMiddleware() {
    this.app.use(requestLogger);

    // Antes de `compression` e do parser de corpo, de propósito: recusar uma
    // requisição sobrecarregada tem de ser BARATO. Se o limite viesse depois,
    // o proprio caminho de recusa gastaria CPU de compressão e memória de
    // buffer -- o disjuntor ficaria mais caro no momento em que o recurso é o
    // mais escasso.
    this.app.use(inFlightLimit);
    this.app.use(compression());
    this.app.use(express.json({ limit: '100kb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(normalizeInput);
    this.app.use((req: Request, res: Response, next: NextFunction) => securityMonitor.detectThreats(req, res, next));
    this.app.use(advancedRateLimit.checkLimits);
  }

  /**
   * Configura as rotas da aplicação
   */
  setupRoutes() {
    // Bootstrap dos serviços antes de criar as rotas
    bootstrapServices();

    const authRoutes = createAuthRoutes();
    this.app.use('/', authRoutes);
    this.app.use('/', observabilityRoutes);
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
      await connectDatabase();

      const redisClient = await initRedis();

      // Promove rate limiters para Redis assim que a conexão estiver disponível
      await advancedRateLimit.init();

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

        const server = https.createServer({ ...options, ...httpServerOptions(serverConfig.timeout) }, this.app);
        configureHttpServerLimits(server, serverConfig.timeout);
        this.server = server;
        setupErrorHandlers(server, serverConfig.timeout.gracefulShutdown);

        server.listen({ port, backlog: serverConfig.timeout.listenBacklog }, () => {
          logger.info(`🚀 Servidor HTTPS rodando em https://${serverConfig.host}:${port}`);
          logger.info(`📚 API Docs: https://${serverConfig.host}:${port}/api-docs | 🏥 Health: https://${serverConfig.host}:${port}/health`);
        });
      } else {
        // Servidor HTTP para desenvolvimento
        const server = createHttpServer(httpServerOptions(serverConfig.timeout), this.app);
        configureHttpServerLimits(server, serverConfig.timeout);
        this.server = server;
        server.listen({ port, backlog: serverConfig.timeout.listenBacklog }, () => {
          logger.info(`🚀 Servidor HTTP rodando em http://${serverConfig.host}:${port}`);
          logger.info(`📚 API Docs: http://${serverConfig.host}:${port}/api-docs | 🏥 Health: http://${serverConfig.host}:${port}/health`);
          if (serverConfig.nodeEnv !== 'production') {
            logger.warn('⚠️ Modo HTTP (sem SSL)');
          }
        });
      }

    } catch (error) {
      logger.error('❌ Erro ao iniciar servidor', error);
      process.exit(1);
    }
  }
}

// O PM2 envolve o app num container (ProcessContainer.js / ProcessContainerFork.js)
// e nunca reescreve `argv[1]`: o processo nasce com `node <container>`, e o app é
// carregado depois por `import()`/`require()`. Só por `argv[1]` o guard ficava
// `false`, o bloco de entrada nunca executava e o processo ficava vivo porém
// ocioso - online no PM2, sem logs e sem port. `pm_exec_path` é o caminho que o
// PM2 aponta para executar, presente nos dois modos (cluster e fork); sem ele
// (testes, imports) o candidato não existe e o guard continua caindo para false.
const isDirectExecution = [process.argv[1], process.env.pm_exec_path]
  .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  .some((entry) => import.meta.url === pathToFileURL(entry).href);

if (isDirectExecution) {
  // Configuração de clustering inteligente
  if (cluster.isPrimary && serverConfig.cluster.enabled) {
    // Aqui o `validateConfiguration` NÃO roda: com o cluster ligado o primary
    // forka e nunca constrói o `AuthService`, que é quem o chama. A exclusão
    // mútua precisa ser conferida neste ponto — é o único que executa no
    // caminho do cluster. Recusar antes de forkar é o que impede a multiplicação
    // em cascata (cada instância do PM2 forkando os workers do cluster module).
    const conflict = clusterConflict();
    if (conflict) {
      logger.error(`❌ ${conflict}`);
      process.exit(1);
    }

    logger.info(`🔧 Master ${process.pid} iniciando cluster: ${serverConfig.cluster.workers} workers (máx: ${serverConfig.cluster.maxWorkers})`);

    // Fork workers conforme configuração
    for (let i = 0; i < serverConfig.cluster.workers; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.error(`⚠️ Worker ${worker.process.pid} morreu (código: ${code}, sinal: ${signal})`);

      // Aguarda antes de recriar o worker para evitar loop infinito
      setTimeout(() => {
        cluster.fork();
      }, serverConfig.cluster.respawnDelay);
    });

    // Graceful shutdown do cluster
    process.on('SIGTERM', () => {
      logger.info('🛑 Recebido SIGTERM, fechando cluster...');
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
