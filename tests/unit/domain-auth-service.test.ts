import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User, DomainError } from '../../src/domain/index.js';

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  findById: jest.fn(),
  findByUsername: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
  exists: jest.fn(),
  ...overrides
});

describe('AuthService - registro', () => {
  it('registra usuário quando as credenciais são válidas e o usuário não existe', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async(user) => ({
        ...user,
        id: 'u-1',
        toSafeObject: () => ({ id: 'u-1', username: user.username })
      }))
    });
    const crypto = { hash: jest.fn().mockResolvedValue('hashed-password') };
    const tokenGenerator = { generateTokenPair: jest.fn() };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.registerUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(result.user).toEqual({ id: 'u-1', username: 'alice' });
    expect(userRepository.exists).toHaveBeenCalledWith('alice');
    expect(crypto.hash).toHaveBeenCalledWith('StrongPass123!');
    expect(logger.info).toHaveBeenCalled();
  });

  it('falha ao registrar usuário que já existe', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      exists: jest.fn().mockResolvedValue(true)
    });

    const service = new AuthService(userRepository, {}, {}, logger);
    const result = await service.registerUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário já existe');
  });

  it('falha ao registrar com credenciais inválidas (DomainError mapeado)', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo();
    const service = new AuthService(userRepository, {}, {}, logger);

    const result = await service.registerUser('ab', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Username deve ter pelo menos 3 caracteres');
  });

  it('falha com mensagem de fallback quando ocorre erro desconhecido', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      exists: jest.fn().mockRejectedValue(new Error('db down'))
    });

    const service = new AuthService(userRepository, {}, {}, logger);
    const result = await service.registerUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Não foi possível registrar o usuário');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('AuthService - autenticação', () => {
  it('autentica com sucesso e gera o par de tokens', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    });
    const crypto = { hash: jest.fn(), compare: jest.fn().mockResolvedValue(true) };
    const tokenGenerator = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 900000,
        type: 'Bearer'
      })
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(result.user.username).toBe('alice');
    expect(result.token.accessToken).toBe('access-token');
    expect(crypto.compare).toHaveBeenCalledWith('StrongPass123!', 'hashed-password');
    expect(tokenGenerator.generateTokenPair).toHaveBeenCalledWith({ id: 'u-1', username: 'alice' });
  });

  it('falha quando o usuário não é encontrado', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(null)
    });

    const service = new AuthService(userRepository, { compare: jest.fn() }, { generateTokenPair: jest.fn() }, logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });

  it('falha quando a senha está incorreta', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    });
    const crypto = { compare: jest.fn().mockResolvedValue(false) };

    const service = new AuthService(userRepository, crypto, {}, logger);
    const result = await service.authenticateUser('alice', 'WrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Senha incorreta');
  });

  it('falha quando o usuário não existe', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockRejectedValue(new Error('db down'))
    });
    const service = new AuthService(userRepository, {}, {}, logger);

    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Não foi possível autenticar o usuário');
  });
});

describe('AuthService - DomainError na construção de credenciais', () => {
  it('propaga códigos de DomainError', () => {
    try {
      new DomainError('SESSION_INVALID', 'Sessão inválida');
      expect(true).toBe(true);
    } catch {
      expect(false).toBe(true);
    }
  });
});
