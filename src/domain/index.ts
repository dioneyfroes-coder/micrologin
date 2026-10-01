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

/**
 * Código de falha da revogação quando o armazenamento de sessão (Redis) está
 * fora do ar em modo fail-closed.
 *
 * Vive no domínio porque é o contrato entre o caso de uso (`endSession`), o
 * adapter de tokens e o error handler HTTP: quem produz o erro e quem decide o
 * status HTTP precisam falar o mesmo nome, sem depender um do outro.
 */
export const REVOCATION_UNAVAILABLE_CODE = 'REVOCATION_UNAVAILABLE';

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
 *
 * `needsRehash` é opcional de propósito: quem só sabe `hash` e `compare` (os
 * doubles de teste, o console) continua válido, e o login só reescreve o hash
 * quando o adapter sabe dizer que ele ficou atrás do padrão em vigor.
 */
export interface CryptoService {
  hash(plainText: string): Promise<string>;
  compare(plainText: string, hash: string): Promise<boolean>;
  /**
   * O hash guardado foi produzido com outro algoritmo, outros parâmetros ou
   * outra versão de pepper, e portanto deveria ser reescrito agora que a senha
   * em claro está disponível (foi provada no login).
   */
  needsRehash?(hash: string): boolean;
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
 * Entrada do encerramento de sessão (POST /logout).
 */
export interface EndSessionInput {
  accessToken?: string | null;
  refreshToken?: string | null;
  authenticatedUserId?: string | null;
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

  /**
   * Reescreve apenas o hash, sem tocar em `passwordHistory` nem em
   * `passwordChangedAt`.
   *
   * Reescrever o hash não é troca de senha: o usuário não trocou nada, e a
   * senha que ele conhece é a mesma. Serve para o hash ficar atrás do padrão em
   * vigor (parâmetros de argon2 mais fortes, pepper ativado ou rotacionado).
   *
   * Se o hash anterior fosse para o histórico, a senha antiga passaria a ser
   * aceita de novo logo depois; se `passwordChangedAt` fosse atualizado, o
   * sistema afirmaria que a senha mudou quando ela não mudou. `updatedAt` também
   * fica: o perfil do usuário não mudou.
   *
   * @param newHashedPassword - Hash no padrão atual
   */
  rehashPassword(newHashedPassword: string): void {
    if (!newHashedPassword) {
      throw new DomainError('INVALID_PASSWORD', 'Senha é obrigatória');
    }

    this.hashedPassword = newHashedPassword;
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
  /**
   * Código do motivo, quando houver um que o adaptador HTTP precise distinguir.
   *
   * Só existe para o caso em que a falha NÃO é de credencial: em fail-closed,
   * com o armazenamento de revogação fora do ar, o login recusa por
   * infraestrutura. Sem o código, esse desfecho chegava ao cliente como
   * "Credenciais inválidas" e à auditoria como falha de senha — duas mentiras.
   */
  code: string | null;
  timestamp: Date;

  constructor(
    user: SafeUser | null,
    token: TokenPair | null,
    success = true,
    error: string | null = null,
    code: string | null = null
  ) {
    this.user = user;
    this.token = token;
    this.success = success;
    this.error = error;
    this.code = code;
    this.timestamp = new Date();
  }

  static success(user: SafeUser, token: TokenPair): AuthResult {
    return new AuthResult(user, token, true, null);
  }

  static failure(error: string, code: string | null = null): AuthResult {
    return new AuthResult(null, null, false, error, code);
  }
}

/**
 * Resultados padrão de operações do AuthService
 */
export interface ServiceResult {
  success: boolean;
  error?: string;
  code?: string;
  securityEvent?: 'TOKEN_REUSE_DETECTED';
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
  private autoRevokeOnRefreshReuse: boolean;

  constructor(
    userRepository: UserRepository,
    crypto: CryptoService,
    tokenGenerator: TokenService,
    logger: Logger,
    autoRevokeOnRefreshReuse = true
  ) {
    // Injeção de dependência através dos PORTS
    this.userRepository = userRepository;
    this.crypto = crypto;
    this.tokenGenerator = tokenGenerator;
    this.logger = logger;
    this.autoRevokeOnRefreshReuse = autoRevokeOnRefreshReuse;
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
   *
   * Em fail-closed, um token que não pode ser revogado depois não é emitido:
   * o `code` `REVOCATION_UNAVAILABLE` atravessa o resultado para que a
   * fronteira HTTP responda 503 (indisponibilidade) em vez de 401
   * (credencial inválida). A resposta pública continua genérica; a distinção
   * existe para o status e para a auditoria, nunca para o cliente.
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

      // Reescrita transparente: o hash guardado pode ter sido feito com
      // parâmetros mais fracos ou com outra versão de pepper. Este é o único
      // momento em que a senha em claro está disponível de novo, então é aqui
      // que ela é reescrita — sem esperar um pedido de troca de senha.
      if (this.crypto.needsRehash?.(user.hashedPassword)) {
        await this.refreshHash(user, credentials.plainPassword);
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
      return AuthResult.failure(
        domainFailureMessage(error, 'Não foi possível autenticar o usuário'),
        (error as { code?: string }).code ?? null
      );
    }
  }

  /**
   * Reescreve o hash do usuário no padrão em vigor, best-effort.
   *
   * Falhar aqui não pode transformar um login válido em erro: o usuário provou
   * a senha, o acesso é legítimo, e o hash antigo continua verificável. A
   * reescrita volta a ser tentada no próximo login.
   */
  private async refreshHash(user: User, plainPassword: string): Promise<void> {
    try {
      const rehashed = await this.crypto.hash(plainPassword);
      user.rehashPassword(rehashed);
      await this.userRepository.save(user);

      this.logger.info('Hash de senha reescrito no padrão em vigor', {
        userId: user.id,
        username: user.username
      });
    } catch (error) {
      this.logger.warn('Não foi possível reescrever o hash de senha; login mantido', {
        userId: user.id,
        username: user.username,
        error: (error as Error).message
      });
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
      // Arrow, não o método solto: quem recebe a função precisa continuar
      // vendo o `this` do serviço de criptografia.
      let reusedHistory: boolean;
      try {
        reusedHistory = await wasPasswordUsedBefore(
          newPassword,
          user.passwordHistory,
          (plain, stored) => this.crypto.compare(plain, stored)
        );
      } catch (error) {
        // A pergunta "esta senha já foi usada?" ficou sem resposta. Deixar
        // passar é escolher fail-open numa checagem de segurança: o usuário
        // troca a senha e o histórico deixa de valer. Recusar com 503 diz a
        // verdade certa — não foi o usuário que errou, e dá para repetir.
        this.logger.error('Falha ao consultar o histórico de senha', error);
        return {
          success: false,
          error: 'Não foi possível verificar o histórico de senhas agora',
          code: 'PASSWORD_HISTORY_UNAVAILABLE'
        };
      }
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
      const tokenError = error as { code?: string; userId?: string };
      if (tokenError.code === 'REFRESH_TOKEN_REUSED' && this.autoRevokeOnRefreshReuse && tokenError.userId) {
        try {
          const revoked = await this.tokenGenerator.revokeUserTokens(tokenError.userId);
          if (!revoked) {
            throw new Error('Revogação da sessão não confirmada');
          }
        } catch (revocationError) {
          this.logger.error('Falha ao revogar sessão após reuso de refresh token', revocationError);
          return {
            success: false,
            error: 'Não foi possível revogar a sessão após reuso do refresh token',
            code: REVOCATION_UNAVAILABLE_CODE,
            securityEvent: 'TOKEN_REUSE_DETECTED'
          };
        }
      }
      return {
        success: false,
        error: domainFailureMessage(error, 'Não foi possível renovar os tokens'),
        code: tokenError.code || 'REFRESH_TOKEN_INVALID'
      };
    }
  }

  /**
   * Caso de uso: Encerrar a sessão
   *
   * Um dos dois tokens basta para identificar a sessão, e basta para derrubá-la:
   *
   * - o **refresh token** carrega o `id` do usuário, então identifica a sessão
   *   mesmo quando o cliente não tem mais o access token (expirou, foi rotacionado
   *   ou nunca foi guardado). Sem essa leitura, um logout enviado só com o refresh
   *   deixava o access token válido até a expiração natural;
   * - o **access token** chega como `authenticatedUserId`, vindo do middleware.
   *
   * Revogar a sessão inteira (versão de sessão no Redis) é o que cumpre a promessa
   * do README: não sobra token órfão de um access token que o cliente não
   * apresentou. Os tokens apresentados também entram na blacklist individualmente,
   * para que o par fique inutilizável mesmo quando o revogador do usuário falha.
   */
  async endSession(input: EndSessionInput): Promise<ServiceResult> {
    const { accessToken, refreshToken, authenticatedUserId } = input;
    let revoked = false;
    let unavailable = false;

    const track = (result: ServiceResult): void => {
      revoked = revoked || result.success;
      unavailable = unavailable || result.code === REVOCATION_UNAVAILABLE_CODE;
    };

    // Identidade ANTES de qualquer revogação, e isso é uma exigência de ordem,
    // não estilo: `verifyRefreshToken` consulta a blacklist, então um refresh
    // já revogado vem sempre recusado. Ler o dono depois de colocá-lo na
    // blacklist devolveria sempre "não sei de quem é a sessão" e o
    // `revokeUserTokens` nunca sairia daqui - o access token órfão sobreviveria
    // até a expiração natural, que é exatamente o que este caso de uso promete
    // impedir.
    let userId = authenticatedUserId || null;
    if (!userId && refreshToken && this.tokenGenerator.verifyRefreshToken) {
      try {
        const payload = await this.tokenGenerator.verifyRefreshToken(refreshToken) as { id?: string };
        userId = payload?.id || null;
      } catch {
        // Apresentado inválido, expirado ou já revogado: não há sessão conhecida
        // a derrubar. Revogar a conta errada seria pior que não revogar.
        this.logger.warn('Logout com refresh token que não pôde ser lido');
      }
    }

    try {
      // Tokens apresentados individualmente: um access token mostrado no logout
      // precisa morrer mesmo que a revogação do usuário não esteja disponível.
      if (accessToken) {
        track(await this.revokeToken(accessToken));
      }
      if (refreshToken) {
        track(await this.revokeToken(refreshToken));
      }

      if (userId) {
        track(await this.revokeUserTokens(userId));
      }

      // Falha de infraestrutura não é erro do cliente: a sessão NÃO foi
      // encerrada, e dizer que encerrou seria mentira.
      if (unavailable) {
        return {
          success: false,
          error: 'Encerramento de sessão temporariamente indisponível',
          code: REVOCATION_UNAVAILABLE_CODE
        };
      }

      if (!revoked) {
        return { success: false, error: 'Nenhum token foi revogado', code: 'REVOCATION_FAILED' };
      }

      this.logger.info('Sessão encerrada', { userId });
      return { success: true };

    } catch (error) {
      this.logger.error('Erro ao encerrar sessão', error);
      return {
        success: false,
        error: domainFailureMessage(error, 'Não foi possível encerrar a sessão'),
        code: (error as { code?: string }).code || 'REVOCATION_FAILED'
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
