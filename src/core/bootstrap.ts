import { container } from './ServiceContainer.js';
import { AuthService } from '../domain/index.js';
import type { CryptoService, Logger, TokenService, UserRepository } from '../domain/index.js';
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
  // O Redis é injetado após a inicialização da conexão (app.js)
  container.register('jwtService', () => {
    return new JWTTokenService(
      securityConfig.jwt.secret as string,
      securityConfig.jwt.refreshSecret,
      null,
      securityConfig.jwt.issuer,
      securityConfig.jwt.audience,
      // Política de revogação: fail-closed em produção (Redis fora => nega)
      { failOpen: securityConfig.session.failOpen }
    );
  });

  container.register('logger', () => adapterFactory.createLogger());

  // Registrar serviço de autenticação do core (isolado)
  container.register('authService', () => {
    const userRepository = container.resolve<UserRepository>('userRepository');
    const cryptoService = container.resolve<CryptoService>('cryptoService');
    const jwtService = container.resolve<TokenService>('jwtService');
    const logger = container.resolve<Logger>('logger');

    return new AuthService(userRepository, cryptoService, jwtService, logger);
  });

  // Registrar controllers/middleware web
  container.register('authController', () => {
    const authService = container.resolve<AuthService>('authService');
    return new AuthWebController(authService);
  });

  container.register('authMiddleware', () => {
    const jwtService = container.resolve<TokenService>('jwtService');
    const userRepository = container.resolve<UserRepository>('userRepository');
    const logger = container.resolve<Logger>('logger');
    return new AuthWebMiddleware(jwtService, userRepository, logger);
  });
}

/**
 * Função helper para resolver dependências
 */
export function resolve<T = unknown>(serviceName: string): T {
  return container.resolve<T>(serviceName);
}

/**
 * Função helper para registrar novos serviços
 */
export function register<T>(name: string, factory: () => T, singleton = true): void {
  container.register(name, factory, singleton);
}
