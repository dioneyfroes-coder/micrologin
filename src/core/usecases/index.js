import { UserEntity, AuthEntity } from '../entities/index.js';

/**
 * Caso de uso: Registrar Usuário
 * Seguindo o Single Responsibility Principle
 */
export class RegisterUserUseCase {
  constructor(userRepository, cryptoService, validationService, logger) {
    this.userRepository = userRepository;
    this.cryptoService = cryptoService;
    this.validationService = validationService;
    this.logger = logger;
  }

  async execute(userData) {
    try {
      // Validação de entrada
      const validation = this.validationService.validate(userData, {
        username: { required: true, minLength: 3 },
        password: { required: true, minLength: 6 }
      });

      if (!validation.isValid) {
        throw new Error(`Dados inválidos: ${validation.errors.join(', ')}`);
      }

      // Verificar se usuário já existe
      const existingUser = await this.userRepository.exists(userData.username);
      if (existingUser) {
        throw new Error('Usuário já existe');
      }

      // Criar entidade de usuário
      const userEntity = new UserEntity(
        null,
        userData.username,
        userData.password
      );

      // Validar entidade
      if (!userEntity.isValid()) {
        throw new Error('Dados do usuário inválidos');
      }

      // Criptografar senha
      const hashedPassword = await this.cryptoService.hash(userEntity.password);
      userEntity.password = hashedPassword;

      // Salvar usuário
      const savedUser = await this.userRepository.create(userEntity.toCompleteObject());

      this.logger.info('Usuário registrado com sucesso', { userId: savedUser.id });

      return new UserEntity(
        savedUser.id,
        savedUser.username,
        savedUser.password,
        savedUser.createdAt,
        savedUser.updatedAt
      );

    } catch (error) {
      this.logger.error('Erro ao registrar usuário', error);
      throw error;
    }
  }
}

/**
 * Caso de uso: Autenticar Usuário
 * Seguindo o Single Responsibility Principle
 */
export class AuthenticateUserUseCase {
  constructor(userRepository, cryptoService, authService, logger) {
    this.userRepository = userRepository;
    this.cryptoService = cryptoService;
    this.authService = authService;
    this.logger = logger;
  }

  async execute(credentials) {
    try {
      const { username, password } = credentials;

      // Buscar usuário
      const user = await this.userRepository.findByUsername(username);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      // Verificar senha
      const isPasswordValid = await this.cryptoService.compare(password, user.password);
      if (!isPasswordValid) {
        throw new Error('Senha incorreta');
      }

      // Gerar token
      const token = await this.authService.generateToken({
        id: user.id,
        username: user.username
      });

      // Criar entidade de autenticação
      const authEntity = new AuthEntity(
        user.id,
        token,
        null, // refresh token seria gerado aqui
        new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 horas
      );

      this.logger.info('Usuário autenticado com sucesso', { userId: user.id });

      return {
        user: new UserEntity(user.id, user.username, null, user.createdAt, user.updatedAt),
        auth: authEntity
      };

    } catch (error) {
      this.logger.error('Erro ao autenticar usuário', error);
      throw error;
    }
  }
}

/**
 * Caso de uso: Obter Perfil do Usuário
 */
export class GetUserProfileUseCase {
  constructor(userRepository, logger) {
    this.userRepository = userRepository;
    this.logger = logger;
  }

  async execute(userId) {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      return new UserEntity(
        user.id,
        user.username,
        null, // Não retornar senha
        user.createdAt,
        user.updatedAt
      );

    } catch (error) {
      this.logger.error('Erro ao obter perfil do usuário', error);
      throw error;
    }
  }
}

/**
 * Caso de uso: Atualizar Perfil do Usuário
 */
export class UpdateUserProfileUseCase {
  constructor(userRepository, cryptoService, validationService, logger) {
    this.userRepository = userRepository;
    this.cryptoService = cryptoService;
    this.validationService = validationService;
    this.logger = logger;
  }

  async execute(userId, updateData) {
    try {
      // Buscar usuário existente
      const existingUser = await this.userRepository.findById(userId);
      if (!existingUser) {
        throw new Error('Usuário não encontrado');
      }

      // Criar entidade do usuário
      const userEntity = new UserEntity(
        existingUser.id,
        existingUser.username,
        existingUser.password,
        existingUser.createdAt,
        existingUser.updatedAt
      );

      // Validar dados de atualização
      if (updateData.username) {
        const validation = this.validationService.validate({ username: updateData.username }, {
          username: { required: true, minLength: 3 }
        });

        if (!validation.isValid) {
          throw new Error(`Username inválido: ${validation.errors.join(', ')}`);
        }

        // Verificar se novo username já existe
        const existingUsername = await this.userRepository.exists(updateData.username);
        if (existingUsername && existingUsername.id !== userId) {
          throw new Error('Username já está em uso');
        }
      }

      // Criptografar nova senha se fornecida
      if (updateData.password) {
        const validation = this.validationService.validate({ password: updateData.password }, {
          password: { required: true, minLength: 6 }
        });

        if (!validation.isValid) {
          throw new Error(`Senha inválida: ${validation.errors.join(', ')}`);
        }

        updateData.password = await this.cryptoService.hash(updateData.password);
      }

      // Atualizar entidade
      userEntity.update(updateData);

      // Salvar alterações
      const updatedUser = await this.userRepository.update(userId, userEntity.toCompleteObject());

      this.logger.info('Perfil do usuário atualizado com sucesso', { userId });

      return new UserEntity(
        updatedUser.id,
        updatedUser.username,
        null, // Não retornar senha
        updatedUser.createdAt,
        updatedUser.updatedAt
      );

    } catch (error) {
      this.logger.error('Erro ao atualizar perfil do usuário', error);
      throw error;
    }
  }
}

/**
 * Caso de uso: Deletar Usuário
 */
export class DeleteUserUseCase {
  constructor(userRepository, logger) {
    this.userRepository = userRepository;
    this.logger = logger;
  }

  async execute(userId) {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      await this.userRepository.delete(userId);

      this.logger.info('Usuário deletado com sucesso', { userId });

      return true;

    } catch (error) {
      this.logger.error('Erro ao deletar usuário', error);
      throw error;
    }
  }
}
