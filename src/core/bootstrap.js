import { container } from './ServiceContainer.js';
import { AuthService } from './domain.js';
import { AdapterFactory } from '../adapters/index.js';
import { AuthWebController } from '../web/AuthController.js';
import { AuthWebMiddleware } from '../web/AuthMiddleware.js';
import {
  securityConfig,
  validateConfiguration
} from '../config/appConfig.js';

/**
 * Configuração das dependências da aplicação seguindo arquitetura hexagonal
 * Core isolado + Adapters + Web Layer
 */
export function bootstrapServices() {
  // Validar configurações primeiro
  validateConfiguration();

  // Configurar adapters de infraestrutura
  const adapterFactory = new AdapterFactory();

  // Registrar adapters com configurações explícitas
  container.register('userRepository', () => adapterFactory.createUserRepository());
  container.register('cryptoService', () => adapterFactory.createCryptoService('bcrypt', {
    saltRounds: securityConfig.bcrypt.saltRounds
  }));
  container.register('jwtService', () => adapterFactory.createJWTService('jwt', {
    secret: securityConfig.jwt.secret,
    expiresIn: securityConfig.jwt.expiresIn
  }));
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
