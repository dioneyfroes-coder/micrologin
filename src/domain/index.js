/**
 * ARQUITETURA HEXAGONAL - NÚCLEO DA APLICAÇÃO
 *
 * Este é o coração do microserviço de autenticação.
 * Contém apenas lógica de negócio pura, sem dependências externas.
 * Comunica-se com o mundo exterior através de PORTS (interfaces).
 */

/**
 * Entidade User - Núcleo do negócio
 */
export class User {
  constructor(id, username, hashedPassword, createdAt = new Date(), updatedAt = new Date()) {
    this.id = id;
    this.username = username;
    this.hashedPassword = hashedPassword;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  /**
   * Regras de negócio para validação do usuário
   */
  isValid() {
    return !!(this.username &&
             this.username.length >= 3 &&
             this.hashedPassword);
  }

  /**
   * Regra de negócio para username válido
   */
  isUsernameValid() {
    return !!(this.username &&
             this.username.length >= 3 &&
             this.username.length <= 50 &&
             /^[a-zA-Z0-9_]+$/.test(this.username));
  }

  /**
   * Atualiza dados do usuário seguindo regras de negócio
   */
  updateData(newUsername, newHashedPassword) {
    if (newUsername && newUsername !== this.username) {
      if (!this.isValidUsername(newUsername)) {
        throw new Error('Username inválido');
      }
      this.username = newUsername;
    }

    if (newHashedPassword) {
      this.hashedPassword = newHashedPassword;
    }

    this.updatedAt = new Date();
  }

  isValidUsername(username) {
    return !!(username &&
             username.length >= 3 &&
             username.length <= 50 &&
             /^[a-zA-Z0-9_]+$/.test(username));
  }

  /**
   * Retorna dados seguros (sem senha)
   */
  toSafeObject() {
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
  constructor(username, plainPassword) {
    this.username = username;
    this.plainPassword = plainPassword;
    this.validate();
  }

  validate() {
    if (!this.username || this.username.length < 3) {
      throw new Error('Username deve ter pelo menos 3 caracteres');
    }
    if (!this.plainPassword || this.plainPassword.length < 6) {
      throw new Error('Senha deve ter pelo menos 6 caracteres');
    }
  }
}

/**
 * Value Object para resultado de autenticação
 */
export class AuthResult {
  constructor(user, token, success = true, error = null) {
    this.user = user;
    this.token = token;
    this.success = success;
    this.error = error;
    this.timestamp = new Date();
  }

  static success(user, token) {
    return new AuthResult(user, token, true, null);
  }

  static failure(error) {
    return new AuthResult(null, null, false, error);
  }
}

/**
 * PORTS - Interfaces que o CORE define para comunicação externa
 * O mundo exterior deve implementar essas interfaces
 */

// PORT para persistência de usuários
export const UserRepositoryPort = {
  async findById(_id) {
    throw new Error('Port not implemented');
  },
  async findByUsername(_username) {
    throw new Error('Port not implemented');
  },
  async save(_user) {
    throw new Error('Port not implemented');
  },
  async delete(_id) {
    throw new Error('Port not implemented');
  },
  async exists(_username) {
    throw new Error('Port not implemented');
  }
};

// PORT para criptografia
export const CryptoPort = {
  async hash(_plainText) {
    throw new Error('Port not implemented');
  },
  async compare(_plainText, _hash) {
    throw new Error('Port not implemented');
  }
};

// PORT para geração de tokens
export const TokenPort = {
  async generate(_payload) {
    throw new Error('Port not implemented');
  },
  async verify(_token) {
    throw new Error('Port not implemented');
  }
};

// PORT para logging
export const LoggerPort = {
  info(_message, _meta) {
    throw new Error('Port not implemented');
  },
  error(_message, _error) {
    throw new Error('Port not implemented');
  },
  warn(_message, _meta) {
    throw new Error('Port not implemented');
  }
};

/**
 * SERVIÇOS DO NÚCLEO - Lógica de negócio pura
 */

/**
 * Serviço de autenticação - CORE BUSINESS LOGIC
 */
export class AuthService {
  constructor(userRepository, crypto, tokenGenerator, logger) {
    // Injeção de dependência através dos PORTS
    this.userRepository = userRepository;
    this.crypto = crypto;
    this.tokenGenerator = tokenGenerator;
    this.logger = logger;
  }

  /**
   * Caso de uso: Registrar usuário
   */
  async registerUser(username, plainPassword) {
    try {
      // Validar entrada
      const credentials = new LoginCredentials(username, plainPassword);

      // Regra de negócio: usuário não pode já existir
      const userExists = await this.userRepository.exists(credentials.username);
      if (userExists) {
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
      return { success: false, error: error.message };
    }
  }

  /**
   * Caso de uso: Autenticar usuário
   */
  async authenticateUser(username, plainPassword) {
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
      const token = await this.tokenGenerator.generate({
        id: user.id,
        username: user.username
      });

      this.logger.info('Usuário autenticado', { username: user.username });

      return AuthResult.success(user.toSafeObject(), token);

    } catch (error) {
      this.logger.error('Erro na autenticação', error);
      return AuthResult.failure(error.message);
    }
  }

  /**
   * Caso de uso: Obter perfil do usuário
   */
  async getUserProfile(userId) {
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
      return { success: false, error: error.message };
    }
  }

  /**
   * Caso de uso: Atualizar perfil do usuário
   */
  async updateUserProfile(userId, newUsername, newPassword) {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        return { success: false, error: 'Usuário não encontrado' };
      }

      // Verificar se novo username já existe
      if (newUsername && newUsername !== user.username) {
        const exists = await this.userRepository.exists(newUsername);
        if (exists) {
          return { success: false, error: 'Username já existe' };
        }
      }

      // Hash da nova senha se fornecida
      let newHashedPassword = null;
      if (newPassword) {
        if (newPassword.length < 6) {
          return { success: false, error: 'Senha deve ter pelo menos 6 caracteres' };
        }
        newHashedPassword = await this.crypto.hash(newPassword);
      }

      // Aplicar regras de negócio através da entidade
      user.updateData(newUsername, newHashedPassword);

      // Persistir
      const updatedUser = await this.userRepository.save(user);

      this.logger.info('Perfil atualizado', { userId: user.id });

      return {
        success: true,
        user: updatedUser.toSafeObject()
      };

    } catch (error) {
      this.logger.error('Erro ao atualizar perfil', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Caso de uso: Deletar usuário
   */
  async deleteUser(userId) {
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
      return { success: false, error: error.message };
    }
  }
}
