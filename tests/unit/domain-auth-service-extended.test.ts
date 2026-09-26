import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User } from '../../src/domain/index.js';

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const makeUser = () =>
  new User('u-1', 'alice', 'hashed-password', new Date('2024-01-01'), new Date('2024-01-01'));

describe('AuthService - perfil do usuário', () => {
  it('obtém perfil por ID sem expor a senha', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()) };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.getUserProfile('u-1');

    expect(result.success).toBe(true);
    expect(result.user?.id).toBe('u-1');
    expect((result.user as Record<string, unknown>).hashedPassword).toBeUndefined();
  });

  it('falha ao obter perfil quando o usuário não existe', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(null) };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.getUserProfile('missing');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });

  it('atualiza o username com sucesso', async() => {
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
    const result = await service.updateUserProfile('u-1', 'alice2');

    expect(result.success).toBe(true);
    expect(result.user?.username).toBe('alice2');
    expect(repo.exists).toHaveBeenCalledWith('alice2');
  });

  it('falha ao atualizar para um username já existente', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      exists: jest.fn().mockResolvedValue(true)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', 'alice2');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Username já existe');
  });

  it('verifica duplicidade na forma canônica ao atualizar o username', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      exists: jest.fn().mockResolvedValue(true),
      save: jest.fn()
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', '  ALICE2  ', null);

    expect(result.success).toBe(false);
    expect(repo.exists).toHaveBeenCalledWith('alice2');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('não consulta duplicidade quando o novo username só muda a caixa', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      exists: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockImplementation(async(u) => ({
        ...u,
        toSafeObject: () => ({ id: 'u-1', username: u.username })
      }))
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.updateUserProfile('u-1', 'ALICE');

    expect(result.success).toBe(true);
    expect(repo.exists).not.toHaveBeenCalled();
    expect(result.user?.username).toBe('alice');
  });

  it('não altera senha pela atualização de perfil', async() => {
    const logger = makeLogger();
    const user = makeUser();
    const originalHash = user.hashedPassword;
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async(u) => ({
        ...u,
        toSafeObject: () => ({ id: 'u-1', username: 'alice' })
      }))
    };
    const crypto = { hash: jest.fn().mockResolvedValue('new-hash') };

    const service = new AuthService(repo, crypto, {}, logger);
    const result = await service.updateUserProfile('u-1');

    expect(result.success).toBe(true);
    // A troca de senha é um caso de uso separado, com step-up e histórico
    expect(crypto.hash).not.toHaveBeenCalled();
    expect(user.hashedPassword).toBe(originalHash);
  });

  it('deleta usuário com sucesso', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      delete: jest.fn().mockResolvedValue(undefined)
    };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.deleteUser('u-1');

    expect(result.success).toBe(true);
    expect(repo.delete).toHaveBeenCalledWith('u-1');
  });

  it('falha ao deletar usuário inexistente', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(null) };

    const service = new AuthService(repo, {}, {}, logger);
    const result = await service.deleteUser('missing');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');
  });
});

describe('AuthService - refresh e revogação', () => {
  const tokenGenerator = {
    refreshTokens: jest.fn().mockResolvedValue({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresIn: 900000,
      type: 'Bearer'
    }),
    revokeToken: jest.fn().mockResolvedValue(true),
    revokeUserTokens: jest.fn().mockResolvedValue(true)
  };

  it('renova tokens com rotação via refresh token', async() => {
    const logger = makeLogger();
    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.refreshUserTokens('valid-refresh-token');

    expect(result.success).toBe(true);
    expect(result.token?.accessToken).toBe('new-at');
    expect(result.token?.refreshToken).toBe('new-rt');
  });

  it('reporta erro ao renovar com refresh token inválido, preservando o código', async() => {
    const logger = makeLogger();
    const bad = {
      refreshTokens: jest.fn().mockRejectedValue(
        Object.assign(new Error('Refresh token inválido: x'), { code: 'REFRESH_TOKEN_INVALID' })
      )
    };

    const service = new AuthService({}, {}, bad, logger);
    const result = await service.refreshUserTokens('bad-token');

    expect(result.success).toBe(false);
    expect(result.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('revoga um token específico', async() => {
    const logger = makeLogger();
    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.revokeToken('token-x');

    expect(result.success).toBe(true);
    expect(tokenGenerator.revokeToken).toHaveBeenCalledWith('token-x', 3600000);
  });

  it('revoga todos os tokens de um usuário', async() => {
    const logger = makeLogger();
    const service = new AuthService({}, {}, tokenGenerator, logger);
    const result = await service.revokeUserTokens('u-1');

    expect(result.success).toBe(true);
    expect(tokenGenerator.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });
});

describe('AuthService - troca de senha (step-up + histórico + sessões)', () => {
  const OLD_PASSWORD = 'OldStrongPass123!';
  const NEW_PASSWORD = 'NewStrongPass456!';

  const makeService = (options: {
    user?: User | null;
    currentMatches?: boolean;
    historyMatch?: boolean;
  } = {}) => {
    const {
      user = makeUser(),
      currentMatches = true,
      historyMatch = false
    } = options;

    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async(u: User) => u)
    };
    // compare: senha atual confere, senha nova não confere com o histórico
    const crypto = {
      hash: jest.fn().mockResolvedValue('new-hash'),
      compare: jest.fn(async(plain: string) => (
        plain === OLD_PASSWORD ? currentMatches : historyMatch
      ))
    };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    return { service: new AuthService(repo, crypto, tokens, logger), repo, crypto, tokens, user };
  };

  it('exige a senha atual (step-up)', async() => {
    const { service } = makeService({ currentMatches: false });

    const result = await service.changePassword('u-1', 'senha-errada', NEW_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.code).toBe('CURRENT_PASSWORD_INVALID');
  });

  it('falha quando o usuário não existe', async() => {
    const { service } = makeService({ user: null });

    const result = await service.changePassword('missing', OLD_PASSWORD, NEW_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.code).toBe('USER_NOT_FOUND');
  });

  it('troca a senha, guarda o hash anterior e marca a data da troca', async() => {
    const { service, repo, crypto, user } = makeService();

    const result = await service.changePassword('u-1', OLD_PASSWORD, NEW_PASSWORD);

    expect(result.success).toBe(true);
    expect(crypto.hash).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(user.hashedPassword).toBe('new-hash');
    expect(user.passwordHistory).toEqual(['hashed-password']);
    expect(user.passwordChangedAt.getTime()).toBeGreaterThan(new Date('2024-01-01').getTime());
  });

  it('recusa senha fora da política', async() => {
    const { service, crypto, tokens } = makeService();

    const result = await service.changePassword('u-1', OLD_PASSWORD, 'fraca');

    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_PASSWORD');
    expect(crypto.hash).not.toHaveBeenCalled();
    expect(tokens.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('recusa senha comum', async() => {
    const { service } = makeService();

    const result = await service.changePassword('u-1', OLD_PASSWORD, 'Mudar@Senha123');

    expect(result.success).toBe(false);
    expect(result.code).toBe('PASSWORD_TOO_COMMON');
  });

  it('recusa reutilização da própria senha atual', async() => {
    const { service, tokens } = makeService({ historyMatch: true });

    const result = await service.changePassword('u-1', OLD_PASSWORD, OLD_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.code).toBe('PASSWORD_REUSED');
    expect(tokens.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('recusa reutilização de senha que está no histórico', async() => {
    const user = new User('u-1', 'alice', 'hashed-password', new Date('2024-01-01'), new Date('2024-01-01'), ['hash-antigo']);
    const { service } = makeService({ user, historyMatch: true });

    const result = await service.changePassword('u-1', OLD_PASSWORD, NEW_PASSWORD);

    expect(result.success).toBe(false);
    expect(result.code).toBe('PASSWORD_REUSED');
  });

  it('encerra todas as sessões do usuário após a troca', async() => {
    const { service, tokens } = makeService();

    await service.changePassword('u-1', OLD_PASSWORD, NEW_PASSWORD);

    // Um access token vazado deixa de valer no mesmo instante da troca
    expect(tokens.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });

  it('não devolve hash nem histórico de senha na resposta', async() => {
    const { service } = makeService();

    const result = await service.changePassword('u-1', OLD_PASSWORD, NEW_PASSWORD);

    expect(result.user).toBeDefined();
    expect(result.user).not.toHaveProperty('hashedPassword');
    expect(result.user).not.toHaveProperty('passwordHistory');
  });
});
