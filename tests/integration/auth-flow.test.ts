import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User } from '../../src/domain/index.js';

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

/**
 * Store em memória que usa a entidade real do domínio (User), de modo que as
 * regras de negócio (normalização do username, validação) valem para o teste.
 */
const makeInMemoryStore = () => {
  const users = new Map<string, User>();
  const revoked = new Set<string>();

  const userRepository = {
    exists: jest.fn(async(username: string) =>
      Array.from(users.values()).some(u => u.username === username)
    ),
    findByUsername: jest.fn(async(username: string) => {
      return Array.from(users.values()).find(u => u.username === username) ?? null;
    }),
    findById: jest.fn(async(id: string) => users.get(id) ?? null),
    save: jest.fn(async(user: User) => {
      if (!user.id) {
        user.id = `u-${users.size + 1}`;
      }
      users.set(user.id, user);
      return user;
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

  it('trata username como identidade única, independente da caixa', async() => {
    const store = makeInMemoryStore();
    const logger = makeLogger();
    const service = new AuthService(store.userRepository, store.crypto, store.tokenGenerator, logger);

    // Registro com maiúsculas e espaços nas bordas
    const registered = await service.registerUser('  Dave  ', 'StrongPass123!');
    expect(registered.success).toBe(true);
    expect(registered.user?.username).toBe('dave');

    // Qualquer variação de caixa autentica
    expect((await service.authenticateUser('dave', 'StrongPass123!')).success).toBe(true);
    expect((await service.authenticateUser('DAVE', 'StrongPass123!')).success).toBe(true);
    expect((await service.authenticateUser('  DaVe  ', 'StrongPass123!')).success).toBe(true);

    // Duplicata com outra caixa é bloqueada
    const duplicate = await service.registerUser('DAVE', 'StrongPass123!');
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toBe('Usuário já existe');

    // Atualização de username também é normalizada
    const userId = registered.user?.id as string;
    const updated = await service.updateUserProfile(userId, 'DAVE2');
    expect(updated.success).toBe(true);
    expect(updated.user?.username).toBe('dave2');
    expect((await service.authenticateUser('dave2', 'StrongPass123!')).success).toBe(true);
  });
});
