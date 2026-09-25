import { describe, it, expect, jest } from '@jest/globals';
import { AuthService } from '../../src/domain/index.js';

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const makeInMemoryStore = () => {
  const users = new Map<string, { id: string; username: string; hashedPassword: string; createdAt: Date; updatedAt: Date }>();
  const revoked = new Set<string>();

  const userRepository = {
    exists: jest.fn(async(username: string) =>
      Array.from(users.values()).some(u => u.username === username)
    ),
    findByUsername: jest.fn(async(username: string) => {
      const raw = Array.from(users.values()).find(u => u.username === username);
      return raw
        ? {
          id: raw.id,
          get username() {
            return raw.username;
          },
          get hashedPassword() {
            return raw.hashedPassword;
          },
          updateData: (newUsername?: string, newHashedPassword?: string) => {
            if (newUsername !== undefined && newUsername !== null) {
              raw.username = newUsername;
            }
            if (newHashedPassword !== undefined && newHashedPassword !== null) {
              raw.hashedPassword = newHashedPassword;
            }
            raw.updatedAt = new Date();
          },
          updatePassword: (hash: string) => {
            raw.hashedPassword = hash;
            raw.updatedAt = new Date();
          },
          toSafeObject: () => ({
            id: raw.id,
            username: raw.username,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt
          })
        }
        : null;
    }),
    findById: jest.fn(async(id: string) => {
      const raw = users.get(id);
      return raw
        ? {
          id: raw.id,
          get username() {
            return raw.username;
          },
          get hashedPassword() {
            return raw.hashedPassword;
          },
          updateData: (newUsername?: string, newHashedPassword?: string) => {
            if (newUsername !== undefined && newUsername !== null) {
              raw.username = newUsername;
            }
            if (newHashedPassword !== undefined && newHashedPassword !== null) {
              raw.hashedPassword = newHashedPassword;
            }
            raw.updatedAt = new Date();
          },
          updatePassword: (hash: string) => {
            raw.hashedPassword = hash;
            raw.updatedAt = new Date();
          },
          toSafeObject: () => ({
            id: raw.id,
            username: raw.username,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt
          })
        }
        : null;
    }),
    save: jest.fn(async(user: { id: string | null; username: string; hashedPassword: string; createdAt: Date; updatedAt: Date }) => {
      const id = user.id ?? `u-${users.size + 1}`;
      const raw = {
        id,
        username: user.username,
        hashedPassword: user.hashedPassword,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      };
      users.set(id, raw);
      return {
        ...raw,
        toSafeObject: () => ({
          id: raw.id,
          username: raw.username,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt
        })
      };
    }),
    delete: jest.fn(async(id: string) => {
      users.delete(id);
    })
  };

  const tokenGenerator = {
    generateTokenPair: jest.fn(async(payload: { id: string; username: string }) => ({
      accessToken: `access:${payload.id}:${Date.now()}`,
      refreshToken: `refresh:${payload.id}:${Date.now()}`,
      expiresIn: 900000,
      type: 'Bearer'
    })),
    revokeToken: jest.fn(async(token: string) => {
      revoked.add(token);
      return true;
    }),
    revokeUserTokens: jest.fn(async(userId: string) => {
      Array.from(revoked).forEach(token => {
        if (token.includes(userId)) {
          revoked.add(token);
        }
      });
      return true;
    }),
    isRevoked: jest.fn((token: string) => revoked.has(token))
  };

  const crypto = {
    hash: jest.fn(async(plain: string) => `hash:${plain}`),
    compare: jest.fn(async(plain: string, hash: string) => `hash:${plain}` === hash)
  };

  return { users, revoked, userRepository, tokenGenerator, crypto };
};

describe('Integration - fluxo completo de autenticação', () => {
  it('registra, autentica, renova e revoga tokens de ponta a ponta', async() => {
    const store = makeInMemoryStore();
    const logger = makeLogger();
    const service = new AuthService(store.userRepository, store.crypto, store.tokenGenerator, logger);

    // 1. Registro
    const registered = await service.registerUser('alice', 'StrongPass123!');
    expect(registered.success).toBe(true);
    expect(registered.user).toEqual(expect.objectContaining({ username: 'alice' }));

    // 2. Autenticação
    const authenticated = await service.authenticateUser('alice', 'StrongPass123!');
    expect(authenticated.success).toBe(true);
    expect(authenticated.token?.accessToken).toContain('access:');
    expect(authenticated.token?.refreshToken).toContain('refresh:');
    expect((authenticated.user as Record<string, unknown>).hashedPassword).toBeUndefined();

    const userId = authenticated.user?.id as string;

    // 3. Perfil
    const profile = await service.getUserProfile(userId);
    expect(profile.success).toBe(true);
    expect(profile.user?.username).toBe('alice');

    // 4. Atualização de username
    const updated = await service.updateUserProfile(userId, 'alice2');
    expect(updated.success).toBe(true);
    expect(updated.user?.username).toBe('alice2');

    // 5. Revogação de tokens do usuário
    await service.revokeUserTokens(userId);

    // 6. Login novamente e deleção
    const reLogin = await service.authenticateUser('alice2', 'StrongPass123!');
    expect(reLogin.success).toBe(true);

    const deleted = await service.deleteUser(userId);
    expect(deleted.success).toBe(true);

    const afterDelete = await service.getUserProfile(userId);
    expect(afterDelete.success).toBe(false);
  });

  it('falha login com senha incorreta e registra o incidente', async() => {
    const store = makeInMemoryStore();
    const logger = makeLogger();
    const service = new AuthService(store.userRepository, store.crypto, store.tokenGenerator, logger);

    await service.registerUser('bob', 'StrongPass123!');

    const badLogin = await service.authenticateUser('bob', 'WrongPass123!');

    expect(badLogin.success).toBe(false);
    expect(badLogin.error).toBe('Senha incorreta');
  });

  it('não permite registrar duplicatas', async() => {
    const store = makeInMemoryStore();
    const logger = makeLogger();
    const service = new AuthService(store.userRepository, store.crypto, store.tokenGenerator, logger);

    await service.registerUser('carol', 'StrongPass123!');
    const duplicate = await service.registerUser('carol', 'StrongPass123!');

    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toBe('Usuário já existe');
    expect(logger.warn).toHaveBeenCalledWith('Falha ao registrar usuário', {
      username: 'carol',
      reason: 'USER_ALREADY_EXISTS'
    });
  });

  it('revoga tokens pontualmente', async() => {
    const store = makeInMemoryStore();
    const logger = makeLogger();
    const service = new AuthService(store.userRepository, store.crypto, store.tokenGenerator, logger);

    const result = await service.revokeToken('some-refresh-token');
    expect(result.success).toBe(true);
    expect(store.revoked.has('some-refresh-token')).toBe(true);
  });
});
