import { container } from './ServiceContainer.js';
import { AuthService } from '../domain/index.js';
import { AdapterFactory } from '../infrastructure/adapters/index.js';
import { AuthWebController } from '../application/controllers/AuthController.js';
import { AuthWebMiddleware } from '../application/middleware/AuthMiddleware.js';
import { JWTTokenService } from '../infrastructure/external-services/jwtTokenService.js';
import {
  securityConfig,
  validateConfiguration
} from '../interfaces/config/appConfig.js';

/**
 * Configuração das dependências da aplicação seguindo arquitetura hexagonal
 * Core isolado + Adapters + Web Layer
 */
export function bootstrapServices() {
  // Validar configurações primeiro
  validateConfiguration();

  // Configurar adapters de infraestrutura
  const adapterFactory = AdapterFactory;

  // Registrar adapters com configurações explícitas
  container.register('userRepository', () => adapterFactory.createUserRepository());
  container.register('cryptoService', () => adapterFactory.createCryptoService('bcrypt', {
    saltRounds: securityConfig.bcrypt.saltRounds
  }));

  // ✅ NOVO: Usar JWTTokenService com suporte a refresh token
  container.register('jwtService', () => {
    const tokenService = new JWTTokenService(
      securityConfig.jwt.secret,
      process.env.JWT_REFRESH_SECRET || securityConfig.jwt.secret
    );

    // Se Redis estiver disponível, adicionar suporte a blacklist
    if (process.env.REDIS_ENABLED !== 'false') {
      // Será conectado depois pelo cache.js
      console.log('🔧 JWT com suporte a Redis (blacklist) será configurado após inicialização do Redis');
    }

    return tokenService;
  });

  container.register('logger', () => adapterFactory.createLogger());

  // Registrar serviço de autenticação do core (isolado)
  container.register('authService', () => {
    const userRepository = container.resolve('userRepository');
    const cryptoService = container.resolve('cryptoService');
    const jwtService = container.resolve('jwtService');
    const logger = container.resolve('logger');

    return new AuthService(userRepository, cryptoService, jwtService, logger);
  });

  // Registrar controllers/middleware web
  container.register('authController', () => {
    const authService = container.resolve('authService');
    return new AuthWebController(authService);
  });

  container.register('authMiddleware', () => {
    const jwtService = container.resolve('jwtService');
    const userRepository = container.resolve('userRepository');
    const logger = container.resolve('logger');
    return new AuthWebMiddleware(jwtService, userRepository, logger);
  });

  console.log('🔧 Serviços da arquitetura hexagonal registrados no container:', container.list());
}

/**
 * Função helper para resolver dependências
 */
export function resolve(serviceName) {
  return container.resolve(serviceName);
}

/**
 * Função helper para registrar novos serviços
 */
export function register(name, factory, singleton = true) {
  return container.register(name, factory, singleton);
}
