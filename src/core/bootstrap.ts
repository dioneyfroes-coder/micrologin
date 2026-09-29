import { container } from './ServiceContainer.js';
import { AuthService } from '../domain/index.js';
import type { CryptoService, Logger, TokenService, UserRepository } from '../domain/index.js';
import { AdapterFactory } from '../infrastructure/adapters/index.js';
import { AuthWebController } from '../application/controllers/AuthController.js';
import { AuthWebMiddleware } from '../application/middleware/AuthMiddleware.js';
import { JWTTokenService } from '../infrastructure/external-services/jwtTokenService.js';
import {
  securityConfig,
  pepperConfigFor,
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
  // O hasher grava no algoritmo configurado (argon2id por padrão, D16) e
  // verifica qualquer formato legado pelo prefixo do hash, então a migração
  // acontece sem interromper quem ainda não voltou a fazer login.
  container.register('cryptoService', () => adapterFactory.createCryptoService(
    securityConfig.passwordHash.algorithm,
    {
      argon2: securityConfig.passwordHash.argon2,
      bcrypt: securityConfig.bcrypt,
      pepper: pepperConfigFor(securityConfig.passwordHash.pepper),
      previousPepper: pepperConfigFor(securityConfig.passwordHash.previousPepper)
    }
  ));

  // ✅ NOVO: Usar JWTTokenService com suporte a refresh token
  // O Redis é injetado após a inicialização da conexão (app.js)
  container.register('jwtService', () => {
    const jwt = securityConfig.jwt;

    // ES256 em produção: a chave privada assina, a pública verifica. Os
    // segredos simétricos continuam sendo lidos porque a validação de
    // configuração já garantiu que, neste caminho, eles não são obrigatórios.
    const es256 = jwt.algorithm === 'ES256'
      ? {
        kid: jwt.es256.kid,
        privateKeyPem: jwt.es256.privateKey as string,
        publicKeyPem: jwt.es256.publicKey as string,
        previousKid: jwt.es256.previousKid,
        previousPublicKeyPem: jwt.es256.previousPublicKey
      }
      : null;

    return new JWTTokenService(
      jwt.secret ?? '',
      jwt.refreshSecret,
      null,
      jwt.issuer,
      jwt.audience,
      // Política de revogação: fail-closed em produção (Redis fora => nega)
      { failOpen: securityConfig.session.failOpen },
      es256
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
