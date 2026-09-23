/**
 * ADAPTERS - Implementações concretas dos PORTS
 *
 * Estes adapters conectam o CORE da aplicação com o mundo exterior.
 * Podem ser facilmente trocados, configurados ou removidos.
 */

import bcrypt from 'bcrypt';
import type { CryptoService, Logger, UserRepository } from '../../domain/index.js';
import { User } from '../../domain/index.js';
import { getUserModel } from '../database/models/User.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * ADAPTER: MongoDB User Repository
 * Implementa o UserRepositoryPort
 */
export class MongoUserAdapter implements UserRepository {
  private UserModel: ReturnType<typeof getUserModel>;

  constructor() {
    this.UserModel = getUserModel();
  }

  async findById(id: string): Promise<User | null> {
    try {
      const userData = await this.UserModel.findById(id);
      if (!userData) {
        return null;
      }

      return new User(
        userData._id.toString(),
        userData.user,
        userData.password,
        userData.createdAt,
        userData.updatedAt
      );
    } catch (error) {
      throw new Error(`Erro ao buscar usuário por ID: ${(error as Error).message}`);
    }
  }

  async findByUsername(username: string): Promise<User | null> {
    try {
      const userData = await this.UserModel.findOne({ user: username });
      if (!userData) {
        return null;
      }

      return new User(
        userData._id.toString(),
        userData.user,
        userData.password,
        userData.createdAt,
        userData.updatedAt
      );
    } catch (error) {
      throw new Error(`Erro ao buscar usuário por username: ${(error as Error).message}`);
    }
  }

  async save(user: User): Promise<User> {
    try {
      if (user.id) {
        // Update
        const userData = await this.UserModel.findByIdAndUpdate(
          user.id,
          {
            user: user.username,
            password: user.hashedPassword,
            updatedAt: user.updatedAt
          },
          { new: true }
        );

        if (!userData) {
          throw new Error('Usuário não encontrado para atualização');
        }

        return new User(
          userData._id.toString(),
          userData.user,
          userData.password,
          userData.createdAt,
          userData.updatedAt
        );
      } else {
        // Create
        const userData = await this.UserModel.create({
          user: user.username,
          password: user.hashedPassword,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        });

        return new User(
          userData._id.toString(),
          userData.user,
          userData.password,
          userData.createdAt,
          userData.updatedAt
        );
      }
    } catch (error) {
      throw new Error(`Erro ao salvar usuário: ${(error as Error).message}`);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.UserModel.findByIdAndDelete(id);
    } catch (error) {
      throw new Error(`Erro ao deletar usuário: ${(error as Error).message}`);
    }
  }

  async exists(username: string): Promise<boolean> {
    try {
      const count = await this.UserModel.countDocuments({ user: username });
      return count > 0;
    } catch (error) {
      throw new Error(`Erro ao verificar existência do usuário: ${(error as Error).message}`);
    }
  }
}

/**
 * ADAPTER: Bcrypt Crypto
 * Implementa o CryptoPort
 */
export class BcryptAdapter implements CryptoService {
  private saltRounds: number;

  constructor(saltRounds = 12) {
    this.saltRounds = saltRounds;
  }

  async hash(plainText: string): Promise<string> {
    try {
      return await bcrypt.hash(plainText, this.saltRounds);
    } catch (error) {
      throw new Error(`Erro ao criptografar: ${(error as Error).message}`);
    }
  }

  async compare(plainText: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plainText, hash);
    } catch (error) {
      throw new Error(`Erro ao comparar hash: ${(error as Error).message}`);
    }
  }
}

/**
 * ADAPTER: Console Logger
 * Implementa o LoggerPort
 */
export class ConsoleLoggerAdapter implements Logger {
  info(message: string, meta: Record<string, unknown> = {}): void {
    logger.info(message, meta);
  }

  error(message: string, error: unknown = null): void {
    logger.error(message, error);
  }

  warn(message: string, meta: Record<string, unknown> = {}): void {
    logger.warn(message, meta);
  }
}

/**
 * FACTORY: Adapter Factory para Injeção de Dependência
 */
export class AdapterFactory {
  static createUserRepository(): UserRepository {
    return new MongoUserAdapter();
  }

  static createCrypto(saltRounds = 12): BcryptAdapter {
    return new BcryptAdapter(saltRounds);
  }

  static createCryptoService(type = 'bcrypt', options: { saltRounds?: number } = {}): BcryptAdapter {
    if (type !== 'bcrypt') {
      throw new Error(`Tipo de cryptoService não suportado: ${type}`);
    }

    return new BcryptAdapter(options.saltRounds || 12);
  }

  static createLogger(): ConsoleLoggerAdapter {
    return new ConsoleLoggerAdapter();
  }
}
