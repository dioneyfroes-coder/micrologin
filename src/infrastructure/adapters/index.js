/**
 * ADAPTERS - Implementações concretas dos PORTS
 *
 * Estes adapters conectam o CORE da aplicação com o mundo exterior.
 * Podem ser facilmente trocados, configurados ou removidos.
 */

import bcrypt from 'bcrypt';
import { User } from '../../domain/index.js';
import { getUserModel } from '../database/models/User.js';

/**
 * ADAPTER: MongoDB User Repository
 * Implementa o UserRepositoryPort
 */
export class MongoUserAdapter {
  constructor() {
    this.UserModel = getUserModel();
  }

  async findById(id) {
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
      throw new Error(`Erro ao buscar usuário por ID: ${error.message}`);
    }
  }

  async findByUsername(username) {
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
      throw new Error(`Erro ao buscar usuário por username: ${error.message}`);
    }
  }

  async save(user) {
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
      throw new Error(`Erro ao salvar usuário: ${error.message}`);
    }
  }

  async delete(id) {
    try {
      await this.UserModel.findByIdAndDelete(id);
    } catch (error) {
      throw new Error(`Erro ao deletar usuário: ${error.message}`);
    }
  }

  async exists(username) {
    try {
      const count = await this.UserModel.countDocuments({ user: username });
      return count > 0;
    } catch (error) {
      throw new Error(`Erro ao verificar existência do usuário: ${error.message}`);
    }
  }
}

/**
 * ADAPTER: Bcrypt Crypto
 * Implementa o CryptoPort
 */
export class BcryptAdapter {
  constructor(saltRounds = 12) {
    this.saltRounds = saltRounds;
  }

  async hash(plainText) {
    try {
      return await bcrypt.hash(plainText, this.saltRounds);
    } catch (error) {
      throw new Error(`Erro ao criptografar: ${error.message}`);
    }
  }

  async compare(plainText, hash) {
    try {
      return await bcrypt.compare(plainText, hash);
    } catch (error) {
      throw new Error(`Erro ao comparar hash: ${error.message}`);
    }
  }
}

/**
 * ADAPTER: Console Logger
 * Implementa o LoggerPort
 */
export class ConsoleLoggerAdapter {
  info(message, meta = {}) {
    console.log(`ℹ️ [INFO] ${message}`, meta);
  }

  error(message, error = null) {
    console.error(`❌ [ERROR] ${message}`, error?.message || error);
  }

  warn(message, meta = {}) {
    console.warn(`⚠️ [WARN] ${message}`, meta);
  }
}

/**
 * FACTORY: Adapter Factory para Injeção de Dependência
 */
export class AdapterFactory {
  static createUserRepository() {
    return new MongoUserAdapter();
  }

  static createCrypto(saltRounds = 12) {
    return new BcryptAdapter(saltRounds);
  }

  static createCryptoService(type = 'bcrypt', options = {}) {
    if (type !== 'bcrypt') {
      throw new Error(`Tipo de cryptoService não suportado: ${type}`);
    }

    return new BcryptAdapter(options.saltRounds || 12);
  }

  static createLogger() {
    return new ConsoleLoggerAdapter();
  }
}
