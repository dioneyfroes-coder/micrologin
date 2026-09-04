import { describe, it, expect, jest } from '@jest/globals';
import { AuthService } from '../../src/domain/index.js';

describe('Authentication flow integration', () => {
  it('executes a happy-path authentication flow', async() => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    const userRepository = {
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async(user) => ({
        ...user,
        id: 'user-123',
        toSafeObject: () => ({ id: 'user-123', username: user.username })
      })),
      findByUsername: jest.fn().mockResolvedValue({
        id: 'user-123',
        username: 'alice',
        hashedPassword: 'hashed-password',
        toSafeObject: () => ({ id: 'user-123', username: 'alice' })
      })
    };

    const crypto = {
      hash: jest.fn().mockResolvedValue('hashed-password'),
      compare: jest.fn().mockResolvedValue(true)
    };

    const tokenGenerator = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        type: 'Bearer',
        expiresIn: 900000
      })
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);

    const registered = await service.registerUser('alice', 'StrongPass123!');
    const authenticated = await service.authenticateUser('alice', 'StrongPass123!');

    expect(registered.success).toBe(true);
    expect(authenticated.success).toBe(true);
    expect(authenticated.token.accessToken).toBe('access-token-123');
  });
});
