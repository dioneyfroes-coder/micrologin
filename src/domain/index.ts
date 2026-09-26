/**
 * ARQUITETURA HEXAGONAL - NÚCLEO DA APLICAÇÃO
 *
 * Este é o coração do microserviço de autenticação.
 * Contém apenas lógica de negócio pura, sem dependências externas.
 * Comunica-se com o mundo exterior através de PORTS (interfaces).
 */

import { PASSWORD_HISTORY_LIMIT, PASSWORD_MIN_LENGTH, isCommonPassword, validatePasswordStrength, wasPasswordUsedBefore } from '../shared/utils/passwordPolicy.js';
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
  /** Hashes das últimas senhas, do mais antigo ao mais recente (limite: PASSWORD_HISTORY_LIMIT). */
  passwordHistory: string[];
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: string | null,
    username: string,
    hashedPassword: string,
    createdAt: Date = new Date(),
    updatedAt: Date = new Date(),
    passwordHistory: string[] = [],
    passwordChangedAt: Date = createdAt
  ) {
    this.id = id;
    this.username = normalizeUsername(username);
    this.hashedPassword = hashedPassword;
    this.passwordHistory = [...passwordHistory];
    this.passwordChangedAt = passwordChangedAt;
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
   * Atualiza o username. Senha NUNCA muda por aqui: troca de senha exige a
   * senha atual (step-up) e é um caso de uso próprio, com histórico e
   * invalidação de sessões.
   */
  updateUsername(newUsername: string): void {
    const normalizedUsername = normalizeUsername(newUsername);
    if (!this.isValidUsername(normalizedUsername)) {
      throw new DomainError('INVALID_USERNAME', 'Username inválido');
    }
    if (normalizedUsername !== this.username) {
      this.username = normalizedUsername;
    }
    this.updatedAt = new Date();
  }

  /**
   * Troca a senha aplicando a política de histórico.
   *
   * O hash anterior entra no histórico (limitado a PASSWORD_HISTORY_LIMIT, FIFO:
   * o mais antigo sai) e `passwordChangedAt` passa a marcar a troca. Os hashes
   * nunca saem da entidade por `toSafeObject`.
   *
   * @param newHashedPassword - Hash da nova senha
   */
  changePassword(newHashedPassword: string): void {
    if (!newHashedPassword) {
      throw new DomainError('INVALID_PASSWORD', 'Senha é obrigatória');
    }

    this.passwordHistory = [...this.passwordHistory, this.hashedPassword].slice(-PASSWORD_HISTORY_LIMIT);
    this.hashedPassword = newHashedPassword;
    this.passwordChangedAt = new Date();
    this.updatedAt = this.passwordChangedAt;
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
   * Caso de uso: Atualizar perfil do usuário (apenas username)
   *
   * A senha NÃO é alterada aqui. Trocar senha exige a senha atual e tem
   * consequences próprias (histórico e encerramento de sessões) - ver
   * `changePassword`.
   */
  async updateUserProfile(userId: string, newUsername?: string): Promise<ServiceResult> {
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

      // Aplicar regras de negócio através da entidade
      if (newUsername) {
        user.updateUsername(newUsername);
      }

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
   * Caso de uso: Trocar a senha do usuário
   *
   * Exige a senha atual (step-up): um access token vazado não basta para
   * tomar a conta permanentemente.
   *
   * Regras aplicadas:
   * - a senha atual precisa conferir;
   * - a nova senha precisa passar na política (tamanho, bytes, composição);
   * - a nova senha não pode ser igual à atual nem a nenhuma das últimas
   *   `PASSWORD_HISTORY_LIMIT` senhas;
   * - o hash anterior entra no histórico e `passwordChangedAt` é atualizado;
   * - **todas as sessões do usuário são encerradas** (decisão de projeto,
   *   ver README): um token comprometido deixa de valer no mesmo instante.
   *
   * @param userId - Usuário autenticado
   * @param currentPassword - Senha atual
   * @param newPassword - Nova senha
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<ServiceResult> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        return { success: false, error: 'Usuário não encontrado', code: 'USER_NOT_FOUND' };
      }

      const currentMatches = await this.crypto.compare(currentPassword, user.hashedPassword);
      if (!currentMatches) {
        this.logger.warn('Troca de senha com senha atual incorreta', { userId });
        return { success: false, error: 'Senha atual incorreta', code: 'CURRENT_PASSWORD_INVALID' };
      }

      const policy = validatePasswordStrength(newPassword);
      if (!policy.isValid) {
        return { success: false, error: policy.errors.join('; '), code: 'INVALID_PASSWORD' };
      }

      if (isCommonPassword(newPassword)) {
        return { success: false, error: 'Senha é muito comum. Escolha uma senha mais complexa.', code: 'PASSWORD_TOO_COMMON' };
      }

      // Reuso da senha atual ou de qualquer senha do histórico
      const reusedCurrent = await this.crypto.compare(newPassword, user.hashedPassword);
      const reusedHistory = await wasPasswordUsedBefore(newPassword, user.passwordHistory, this.crypto.compare);
      if (reusedCurrent || reusedHistory) {
        return { success: false, error: 'A nova senha não pode ser uma senha já utilizada', code: 'PASSWORD_REUSED' };
      }

      const newHashedPassword = await this.crypto.hash(newPassword);
      user.changePassword(newHashedPassword);
      const savedUser = await this.userRepository.save(user);

      // Encerrar todas as sessões: a senha trocada invalida o que já foi emitido
      await this.tokenGenerator.revokeUserTokens(userId);

      this.logger.info('Senha alterada; sessões do usuário revogadas', { userId: savedUser.id });

      return {
        success: true,
        user: savedUser.toSafeObject()
      };

    } catch (error) {
      this.logger.error('Erro ao trocar senha', error);
      return { success: false, error: domainFailureMessage(error, 'Não foi possível alterar a senha') };
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
