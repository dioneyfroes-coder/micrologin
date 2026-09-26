/**
 * ARQUITETURA HEXAGONAL - NÚCLEO DA APLICAÇÃO
 *
 * Este é o coração do microserviço de autenticação.
 * Contém apenas lógica de negócio pura, sem dependências externas.
 * Comunica-se com o mundo exterior através de PORTS (interfaces).
 */

import { PASSWORD_MIN_LENGTH } from '../shared/utils/passwordValidator.js';
import { hasAllowedUsernameChars, isUsernameValid, normalizeUsername, USERNAME_MIN_LENGTH } from '../shared/utils/usernamePolicy.js';

export type DomainErrorCode = 'INVALID_USERNAME' | 'INVALID_PASSWORD' | 'USER_ALREADY_EXISTS' | string;

export class DomainError extends Error {
  name: string;
  code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const domainFailureMessage = (error: unknown, fallback: string): string => (
  error instanceof DomainError ? error.message : fallback
);

/**
 * Dados seguros do usuário (sem senha)
 */
export interface SafeUser {
  id: string | null;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Par de tokens gerado na autenticação
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  type: string;
}

/**
 * Porta de persistência de usuários (UserRepositoryPort)
 */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  save(user: User): Promise<User>;
  delete(id: string): Promise<void>;
  exists(username: string): Promise<boolean>;
}

/**
 * Porta de criptografia (CryptoPort)
 */
export interface CryptoService {
  hash(plainText: string): Promise<string>;
  compare(plainText: string, hash: string): Promise<boolean>;
}

/**
 * Porta de geração/verificação de tokens (TokenPort)
 */
export interface TokenService {
  generateTokenPair(payload: { id: string; username: string }, options?: TokenGenerationOptions): Promise<TokenPair>;
  generateAccessToken?(payload: { id: string; username: string }, expiresIn?: string): Promise<string>;
  verifyAccessToken?(token: string): Promise<unknown>;
  verifyRefreshToken?(token: string): Promise<unknown>;
  refreshTokens?(refreshToken: string, options?: TokenGenerationOptions): Promise<TokenPair>;
  revokeToken(token: string, expiresIn?: number): Promise<boolean>;
  revokeUserTokens(userId: string, expiresIn?: number): Promise<boolean>;
}

/**
 * Porta de logging (LoggerPort)
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface TokenGenerationOptions {
  issuer?: string;
  audience?: string;
  accessExpiresIn?: string;
  refreshExpiresIn?: string;
}

/**
 * Entidade User - Núcleo do negócio
 */
export class User {
  id: string | null;
  username: string;
  hashedPassword: string;
  createdAt: Date;
  updatedAt: Date;

  constructor(id: string | null, username: string, hashedPassword: string, createdAt: Date = new Date(), updatedAt: Date = new Date()) {
    this.id = id;
    this.username = normalizeUsername(username);
    this.hashedPassword = hashedPassword;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  /**
   * Regras de negócio para validação do usuário
   */
  isValid(): boolean {
    return !!(this.username &&
             this.username.length >= 3 &&
             this.hashedPassword);
  }

  /**
   * Regra de negócio para username válido
   */
  isUsernameValid(): boolean {
    return isUsernameValid(this.username);
  }

  /**
   * Atualiza dados do usuário seguindo regras de negócio
   */
  updateData(newUsername?: string, newHashedPassword?: string): void {
    if (newUsername) {
      const normalizedUsername = normalizeUsername(newUsername);
      if (!this.isValidUsername(normalizedUsername)) {
        throw new DomainError('INVALID_USERNAME', 'Username inválido');
      }
      if (normalizedUsername !== this.username) {
        this.username = normalizedUsername;
      }
    }

    if (newHashedPassword) {
      this.hashedPassword = newHashedPassword;
    }

    this.updatedAt = new Date();
  }

  isValidUsername(username: string): boolean {
    return isUsernameValid(username);
  }

  /**
   * Retorna dados seguros (sem senha)
   */
  toSafeObject(): SafeUser {
    return {
      id: this.id,
      username: this.username,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

/**
 * Value Object para credenciais de login
 */
export class LoginCredentials {
  username: string;
  plainPassword: string;

  constructor(username: string, plainPassword: string) {
    this.username = normalizeUsername(username);
    this.plainPassword = plainPassword;
    this.validate();
  }

  validate(): void {
    if (!this.username || this.username.length < USERNAME_MIN_LENGTH) {
      throw new DomainError('INVALID_USERNAME', 'Username deve ter pelo menos 3 caracteres');
    }
    if (!hasAllowedUsernameChars(this.username)) {
      throw new DomainError('INVALID_USERNAME', 'Username deve conter apenas letras, números, underscores e hífens');
    }
    if (!this.plainPassword || this.plainPassword.length < PASSWORD_MIN_LENGTH) {
      throw new DomainError('INVALID_PASSWORD', `Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
    }
  }
}

/**
 * Value Object para resultado de autenticação
 */
export class AuthResult {
  user: SafeUser | null;
  token: TokenPair | null;
  success: boolean;
  error: string | null;
  timestamp: Date;

  constructor(user: SafeUser | null, token: TokenPair | null, success = true, error: string | null = null) {
    this.user = user;
    this.token = token;
    this.success = success;
    this.error = error;
    this.timestamp = new Date();
  }

  static success(user: SafeUser, token: TokenPair): AuthResult {
    return new AuthResult(user, token, true, null);
  }

  static failure(error: string): AuthResult {
    return new AuthResult(null, null, false, error);
  }
}

/**
 * Resultados padrão de operações do AuthService
 */
export interface ServiceResult {
  success: boolean;
  error?: string;
  code?: string;
  user?: SafeUser;
  token?: TokenPair;
}

/**
 * SERVIÇOS DO NÚCLEO - Lógica de negócio pura
 */

/**
 * Serviço de autenticação - CORE BUSINESS LOGIC
 */
export class AuthService {
  private userRepository: UserRepository;
  private crypto: CryptoService;
  private tokenGenerator: TokenService;
  private logger: Logger;

  constructor(userRepository: UserRepository, crypto: CryptoService, tokenGenerator: TokenService, logger: Logger) {
    // Injeção de dependência através dos PORTS
    this.userRepository = userRepository;
    this.crypto = crypto;
    this.tokenGenerator = tokenGenerator;
    this.logger = logger;
  }

  /**
   * Caso de uso: Registrar usuário
   */
  async registerUser(username: string, plainPassword: string): Promise<ServiceResult> {
    try {
      // Validar entrada
      const credentials = new LoginCredentials(username, plainPassword);

      // Regra de negócio: usuário não pode já existir
      const userExists = await this.userRepository.exists(credentials.username);
      if (userExists) {
        this.logger.warn('Falha ao registrar usuário', {
          username: credentials.username,
          reason: 'USER_ALREADY_EXISTS'
        });
        return { success: false, error: 'Usuário já existe' };
      }

      // Criptografar senha
      const hashedPassword = await this.crypto.hash(credentials.plainPassword);

      // Criar entidade do usuário
      const user = new User(null, credentials.username, hashedPassword);

      // Validar regras de negócio
      if (!user.isValid()) {
        return { success: false, error: 'Dados do usuário inválidos' };
      }

      // Persistir
      const savedUser = await this.userRepository.save(user);

      this.logger.info('Usuário registrado', { username: savedUser.username });

      return {
        success: true,
        user: savedUser.toSafeObject()
      };

    } catch (error) {
      this.logger.error('Erro no registro', error);
      return { success: false, error: domainFailureMessage(error, 'Não foi possível registrar o usuário') };
    }
  }

  /**
   * Caso de uso: Autenticar usuário
   */
  async authenticateUser(username: string, plainPassword: string): Promise<AuthResult> {
    try {
      // Validar entrada
      const credentials = new LoginCredentials(username, plainPassword);

      // Buscar usuário
      const user = await this.userRepository.findByUsername(credentials.username);
      if (!user) {
        return AuthResult.failure('Usuário não encontrado');
      }

      // Verificar senha
      const isValidPassword = await this.crypto.compare(
        credentials.plainPassword,
        user.hashedPassword
      );

      if (!isValidPassword) {
        return AuthResult.failure('Senha incorreta');
      }

      // Gerar token
      const tokens = await this.tokenGenerator.generateTokenPair({
        id: user.id as string,
        username: user.username
      });

      this.logger.info('Usuário autenticado', { username: user.username });

      return AuthResult.success(user.toSafeObject(), tokens);

    } catch (error) {
      this.logger.error('Erro na autenticação', error);
      return AuthResult.failure(domainFailureMessage(error, 'Não foi possível autenticar o usuário'));
    }
  }

  /**
   * Caso de uso: Obter perfil do usuário
   */
  async getUserProfile(userId: string): Promise<ServiceResult> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        return { success: false, error: 'Usuário não encontrado' };
      }

      return {
        success: true,
        user: user.toSafeObject()
      };

    } catch (error) {
      this.logger.error('Erro ao obter perfil', error);
      return { success: false, error: domainFailureMessage(error, 'Não foi possível obter o perfil') };
    }
  }

  /**
   * Caso de uso: Atualizar perfil do usuário
   */
  async updateUserProfile(userId: string, newUsername?: string, newPassword?: string): Promise<ServiceResult> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        return { success: false, error: 'Usuário não encontrado' };
      }

      // Verificar se novo username já existe
      if (newUsername) {
        const normalizedUsername = normalizeUsername(newUsername);
        if (normalizedUsername !== user.username) {
          const exists = await this.userRepository.exists(normalizedUsername);
          if (exists) {
            return { success: false, error: 'Username já existe' };
          }
        }
      }

      // Hash da nova senha se fornecida
      let newHashedPassword: string | null = null;
      if (newPassword) {
        if (newPassword.length < PASSWORD_MIN_LENGTH) {
          return { success: false, error: `Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres` };
        }
        newHashedPassword = await this.crypto.hash(newPassword);
      }

      // Aplicar regras de negócio através da entidade
      user.updateData(newUsername, newHashedPassword || undefined);

      // Persistir
      const updatedUser = await this.userRepository.save(user);

      this.logger.info('Perfil atualizado', { userId: user.id });

      return {
        success: true,
        user: updatedUser.toSafeObject()
      };

    } catch (error) {
      this.logger.error('Erro ao atualizar perfil', error);
      return { success: false, error: domainFailureMessage(error, 'Não foi possível atualizar o perfil') };
    }
  }

  /**
   * Caso de uso: Deletar usuário
   */
  async deleteUser(userId: string): Promise<ServiceResult> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        return { success: false, error: 'Usuário não encontrado' };
      }

      await this.userRepository.delete(userId);

      this.logger.info('Usuário deletado', { userId });

      return { success: true };

    } catch (error) {
      this.logger.error('Erro ao deletar usuário', error);
      return { success: false, error: domainFailureMessage(error, 'Não foi possível deletar o usuário') };
    }
  }

  /**
   * Caso de uso: Renovar par de tokens usando refresh token (com rotação)
   */
  async refreshUserTokens(refreshToken: string): Promise<ServiceResult> {
    try {
      if (!this.tokenGenerator.refreshTokens) {
        throw new Error('TokenService não implementa refreshTokens');
      }

      const tokens = await this.tokenGenerator.refreshTokens(refreshToken);

      return { success: true, token: tokens };

    } catch (error) {
      this.logger.error('Erro ao renovar tokens', error);
      return {
        success: false,
        error: domainFailureMessage(error, 'Não foi possível renovar os tokens'),
        code: (error as { code?: string }).code || 'REFRESH_TOKEN_INVALID'
      };
    }
  }

  /**
   * Caso de uso: Revogar um token específico (blacklist)
   */
  async revokeToken(token: string, expiresIn = 3600000): Promise<ServiceResult> {
    try {
      const revoked = await this.tokenGenerator.revokeToken(token, expiresIn);
      return { success: revoked };
    } catch (error) {
      this.logger.error('Erro ao revogar token', error);
      return {
        success: false,
        error: domainFailureMessage(error, 'Não foi possível revogar o token'),
        code: (error as { code?: string }).code
      };
    }
  }

  /**
   * Caso de uso: Revogar todos os tokens de um usuário
   */
  async revokeUserTokens(userId: string): Promise<ServiceResult> {
    try {
      const revoked = await this.tokenGenerator.revokeUserTokens(userId);
      return { success: revoked };
    } catch (error) {
      this.logger.error('Erro ao revogar tokens do usuário', error);
      return {
        success: false,
        error: domainFailureMessage(error, 'Não foi possível revogar os tokens do usuário'),
        code: (error as { code?: string }).code
      };
    }
  }
}
