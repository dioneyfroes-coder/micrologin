/**
 * ADAPTERS - Implementações concretas dos PORTS
 *
 * Estes adapters conectam o CORE da aplicação com o mundo exterior.
 * Podem ser facilmente trocados, configurados ou removidos.
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../core/domain.js';
import { getUserModel } from '../models/User.js';
import { securityConfig } from '../config/appConfig.js';

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
 * ADAPTER: JWT Token Generator
 * Implementa o TokenPort
 */
export class JWTAdapter {
  constructor(secret, expiresIn = '6h') {
    if (!secret) {
      throw new Error('JWT_SECRET é obrigatório - deve ser fornecido no construtor');
    }

    this.secret = secret;
    this.expiresIn = expiresIn;
  }

  async generate(payload) {
    try {
      return jwt.sign(payload, this.secret, {
        expiresIn: this.expiresIn,
        issuer: 'auth-service',
        audience: 'api-users'
      });
    } catch (error) {
      throw new Error(`Erro ao gerar token: ${error.message}`);
    }
  }

  async verify(token) {
    try {
      return jwt.verify(token, this.secret);
    } catch (error) {
      throw new Error(`Token inválido: ${error.message}`);
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
 * ADAPTER: Structured Logger (exemplo de adapter alternativo)
 * Implementa o LoggerPort com estrutura JSON
 */
export class StructuredLoggerAdapter {
  info(message, meta = {}) {
    console.log(JSON.stringify({
      level: 'info',
      message,
      meta,
      timestamp: new Date().toISOString()
    }));
  }

  error(message, error = null) {
    console.error(JSON.stringify({
      level: 'error',
      message,
      error: error?.message || error,
      stack: error?.stack,
      timestamp: new Date().toISOString()
    }));
  }

  warn(message, meta = {}) {
    console.warn(JSON.stringify({
      level: 'warn',
      message,
      meta,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * ADAPTER FACTORY - Facilita a criação de adapters
 */
export class AdapterFactory {
  createUserRepository(type = 'mongo') {
    switch (type) {
    case 'mongo':
      return new MongoUserAdapter();
    default:
      throw new Error(`Tipo de repositório não suportado: ${type}`);
    }
  }

  createCryptoService(type = 'bcrypt', options = {}) {
    switch (type) {
    case 'bcrypt':
      return new BcryptAdapter(
        options.saltRounds || securityConfig.bcrypt.saltRounds
      );
    default:
      throw new Error(`Tipo de crypto não suportado: ${type}`);
    }
  }

  createJWTService(type = 'jwt', options = {}) {
    switch (type) {
    case 'jwt':
      return new JWTAdapter(
        options.secret || securityConfig.jwt.secret,
        options.expiresIn || securityConfig.jwt.expiresIn
      );
    default:
      throw new Error(`Tipo de token generator não suportado: ${type}`);
    }
  }

  createLogger(type = 'console') {
    switch (type) {
    case 'console':
      return new ConsoleLoggerAdapter();
    case 'structured':
      return new StructuredLoggerAdapter();
    default:
      throw new Error(`Tipo de logger não suportado: ${type}`);
    }
  }
}
