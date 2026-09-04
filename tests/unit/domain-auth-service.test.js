import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User, LoginCredentials, AuthResult } from '../../src/domain/index.js';

describe('AuthService - domain behavior', () => {
  const makeLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  });

  it('registerUser should create a user when credentials are valid and user does not exist', async() => {
    const logger = makeLogger();
    const userRepository = {
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async(user) => ({
        ...user,
        id: 'u-1',
        toSafeObject: () => ({ id: 'u-1', username: user.username })
      }))
    };
    const crypto = {
      hash: jest.fn().mockResolvedValue('hashed-password')
    };
    const tokenGenerator = { generateTokenPair: jest.fn() };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.registerUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(userRepository.exists).toHaveBeenCalledWith('alice');
    expect(crypto.hash).toHaveBeenCalledWith('StrongPass123!');
  });

  it('authenticateUser should fail when user is not found', async() => {
    const logger = makeLogger();
    const userRepository = {
      findByUsername: jest.fn().mockResolvedValue(null)
    };
    const crypto = { compare: jest.fn() };
    const tokenGenerator = { generateTokenPair: jest.fn() };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });

  it('authenticateUser should return success with token when password matches', async() => {
    const logger = makeLogger();
    const userRepository = {
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    };
    const crypto = {
      compare: jest.fn().mockResolvedValue(true)
    };
    const tokenGenerator = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        type: 'Bearer',
        expiresIn: 900000
      })
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(result.token.accessToken).toBe('access-token');
    expect(tokenGenerator.generateTokenPair).toHaveBeenCalledWith({ id: 'u-1', username: 'alice' });
  });

  it('LoginCredentials should reject password shorter than the policy', () => {
    expect(() => new LoginCredentials('alice', 'short')).toThrow('Senha deve ter pelo menos 12 caracteres');
  });

  it('AuthResult.failure should build a failed result', () => {
    const result = AuthResult.failure('invalid');
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid');
  });
});
