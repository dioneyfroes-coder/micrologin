import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User, LoginCredentials, AuthResult, DomainError } from '../../src/domain/index.js';

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const makeUser = () =>
  new User('u-1', 'alice', 'hashed-password', new Date('2024-01-01'), new Date('2024-01-01'));

describe('Domain - user profile management', () => {
  it('gets a user profile by ID', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.getUserProfile('u-1');

    expect(result.success).toBe(true);
    expect(result.user.id).toBe('u-1');
    expect(result.user.hashedPassword).toBeUndefined();
  });

  it('fails to get profile when user does not exist', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(null)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.getUserProfile('missing');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });

  it('updates the username successfully', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async(u) => ({
        ...u,
        toSafeObject: () => ({ id: 'u-1', username: 'alice2' })
      }))
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', 'alice2', null);

    expect(result.success).toBe(true);
    expect(result.user.username).toBe('alice2');
  });

  it('rejects an update when the new username already exists', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      exists: jest.fn().mockResolvedValue(true)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', 'taken', null);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Username já existe');
  });

  it('rejects an update with a short password', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', null, 'short');

    expect(result.success).toBe(false);
    expect(result.error).toContain('12');
  });

  it('deletes an existing user', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      delete: jest.fn().mockResolvedValue(true)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.deleteUser('u-1');

    expect(result.success).toBe(true);
    expect(repo.delete).toHaveBeenCalledWith('u-1');
  });

  it('fails to delete a user that does not exist', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(null)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.deleteUser('missing');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });
});

describe('Domain - entities and value objects', () => {
  it('rejects a username without the minimum length', () => {
    expect(() => new LoginCredentials('ab', 'StrongPass123!')).toThrow(DomainError);
  });

  it('rejects a username with invalid characters', () => {
    expect(() => new LoginCredentials('inválid name', 'StrongPass123!')).toThrow(DomainError);
    expect(() => new LoginCredentials('user@name', 'StrongPass123!')).toThrow(DomainError);
  });

  it('accepts a username with only letters, numbers and underscores', () => {
    const creds = new LoginCredentials('alice_123', 'StrongPass123!');
    expect(creds.username).toBe('alice_123');
  });

  it('validates username rules in the User entity', () => {
    const valid = new User('1', 'alice123');
    expect(valid.isValidUsername('alice123')).toBe(true);

    const invalid = new User('1', 'x!');
    expect(invalid.isValidUsername('x!')).toBe(false);
    expect(invalid.isValidUsername('a')).toBe(false);
    expect(invalid.isValidUsername('this-username-is-far-too-long-for-the-rule')).toBe(false);
  });

  it('returns AuthResult.success with user and token', () => {
    const user = { id: 'u-1' };
    const token = { accessToken: 'token' };
    const result = AuthResult.success(user, token);

    expect(result.success).toBe(true);
    expect(result.user).toBe(user);
    expect(result.token).toBe(token);
    expect(result.error).toBeNull();
  });
});

describe('Domain - error isolation', () => {
  it('does not leak unknown repository errors to the client', async() => {
    const logger = makeLogger();
    const repo = {
      exists: jest.fn().mockRejectedValue(new Error('mongo internal details'))
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.registerUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Não foi possível registrar');
    expect(result.error).not.toContain('mongo');
  });

  it('does not leak unknown repository errors on authentication', async() => {
    const logger = makeLogger();
    const repo = {
      findByUsername: jest.fn().mockRejectedValue(new Error('redis secret detail'))
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Não foi possível autenticar');
    expect(result.error).not.toContain('redis');
  });
});

describe('Domain - token refresh and revocation', () => {
  it('refreshes tokens and returns the new pair', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      refreshTokens: jest.fn().mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        type: 'Bearer',
        expiresIn: 900000
      })
    };

    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.refreshUserTokens('old-rt');

    expect(result.success).toBe(true);
    expect(result.token).toEqual({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      type: 'Bearer',
      expiresIn: 900000
    });
  });

  it('reports refresh failure with the original token code', async() => {
    const logger = makeLogger();
    const error = new Error('Refresh token expirado');
    error.code = 'REFRESH_TOKEN_EXPIRED';
    const tokenGenerator = {
      refreshTokens: jest.fn().mockRejectedValue(error)
    };

    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.refreshUserTokens('expired-rt');

    expect(result.success).toBe(false);
    expect(result.code).toBe('REFRESH_TOKEN_EXPIRED');
  });

  it('revokes a specific token', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      revokeToken: jest.fn().mockResolvedValue(true)
    };

    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.revokeToken('some-token', 60000);

    expect(result.success).toBe(true);
    expect(tokenGenerator.revokeToken).toHaveBeenCalledWith('some-token', 60000);
  });

  it('revokes all tokens of a user', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };

    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.revokeUserTokens('u-1');

    expect(result.success).toBe(true);
    expect(tokenGenerator.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });
});
