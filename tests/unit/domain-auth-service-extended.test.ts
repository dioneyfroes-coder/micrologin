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

  it('revoga a sessão quando detecta reuso de refresh', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      refreshTokens: jest.fn().mockRejectedValue(
        Object.assign(new Error('refresh reutilizado'), { code: 'REFRESH_TOKEN_REUSED', userId: 'u-7' })
      ),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };
    const service = new AuthService({}, {}, tokenGenerator, logger);

    const result = await service.refreshUserTokens('reused-refresh-token');

    expect(tokenGenerator.revokeUserTokens).toHaveBeenCalledWith('u-7');
    expect(result).toMatchObject({ success: false, code: 'REFRESH_TOKEN_REUSED' });
  });

  it('permite desativar a revogação automática de sessão por configuração', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      refreshTokens: jest.fn().mockRejectedValue(
        Object.assign(new Error('refresh reutilizado'), { code: 'REFRESH_TOKEN_REUSED', userId: 'u-8' })
      ),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };
    const service = new AuthService({}, {}, tokenGenerator, logger, false);

    const result = await service.refreshUserTokens('reused-refresh-token');

    expect(tokenGenerator.revokeUserTokens).not.toHaveBeenCalled();
    expect(result.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('reporta indisponibilidade se não consegue confirmar a revogação da sessão', async() => {
    const logger = makeLogger();
    const tokenGenerator = {
      refreshTokens: jest.fn().mockRejectedValue(
        Object.assign(new Error('refresh reutilizado'), { code: 'REFRESH_TOKEN_REUSED', userId: 'u-9' })
      ),
      revokeUserTokens: jest.fn().mockResolvedValue(false)
    };
    const service = new AuthService({}, {}, tokenGenerator, logger);

    const result = await service.refreshUserTokens('reused-refresh-token');

    expect(result).toMatchObject({
      success: false,
      code: 'REVOCATION_UNAVAILABLE',
      securityEvent: 'TOKEN_REUSE_DETECTED'
    });
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

describe('AuthService - encerramento de sessão (POST /logout)', () => {
  const makeTokenPort = (overrides: Record<string, unknown> = {}) => ({
    revokeToken: jest.fn().mockResolvedValue(true),
    revokeUserTokens: jest.fn().mockResolvedValue(true),
    verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
    ...overrides
  });

  it('encerra a sessão inteira a partir do refresh token, sem access token', async() => {
    const tokenPort = makeTokenPort();
    const logger = makeLogger();
    const service = new AuthService({}, {}, tokenPort, logger);

    const result = await service.endSession({ refreshToken: 'rt' });

    expect(result.success).toBe(true);
    // O token apresentado vai para a blacklist...
    expect(tokenPort.revokeToken).toHaveBeenCalledWith('rt', 3600000);
    // ...e o dono da sessão, descoberto pelo refresh, tem tudo revogado.
    expect(tokenPort.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });

  it('usa o access token autenticado como identidade, sem reler o refresh', async() => {
    const tokenPort = makeTokenPort();
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({
      accessToken: 'at',
      refreshToken: 'rt',
      authenticatedUserId: 'u-42'
    });

    expect(result.success).toBe(true);
    expect(tokenPort.revokeToken).toHaveBeenCalledWith('at', 3600000);
    expect(tokenPort.revokeToken).toHaveBeenCalledWith('rt', 3600000);
    expect(tokenPort.revokeUserTokens).toHaveBeenCalledWith('u-42');
    expect(tokenPort.verifyRefreshToken).not.toHaveBeenCalled();
  });

  it('não tenta revogar tokens que não foram apresentados', async() => {
    const tokenPort = makeTokenPort();
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({ authenticatedUserId: 'u-1' });

    expect(result.success).toBe(true);
    expect(tokenPort.revokeToken).not.toHaveBeenCalled();
    expect(tokenPort.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });

  it('refresh token ilegível não derruba a sessão, mas o que foi revogado continua válido', async() => {
    const tokenPort = makeTokenPort({
      verifyRefreshToken: jest.fn().mockRejectedValue(
        Object.assign(new Error('Refresh token inválido'), { code: 'REFRESH_TOKEN_INVALID' })
      )
    });
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({ refreshToken: 'token-ruim' });

    // O token apresentado foi para a blacklist, então a resposta é de sucesso
    expect(result.success).toBe(true);
    expect(tokenPort.revokeToken).toHaveBeenCalledWith('token-ruim', 3600000);
    // Não há sessão conhecida a derrubar: mentir aqui revogaria a conta errada.
    expect(tokenPort.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('TokenService sem verifyRefreshToken ainda encerra o par apresentado', async() => {
    const tokenPort = makeTokenPort({ verifyRefreshToken: undefined });
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({ refreshToken: 'rt' });

    expect(result.success).toBe(true);
    expect(tokenPort.revokeToken).toHaveBeenCalledWith('rt', 3600000);
    expect(tokenPort.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('repasse REVOCATION_UNAVAILABLE em vez de dizer que a sessão acabou', async() => {
    // Em fail-closed o adapter LANÇA: o TokenPort só devolve boolean, quem
    // sinaliza a indisponibilidade é a exceção com código.
    const unavailable = Object.assign(new Error('Revogação de tokens indisponível'), {
      code: 'REVOCATION_UNAVAILABLE'
    });
    const tokenPort = makeTokenPort({
      revokeToken: jest.fn().mockRejectedValue(unavailable),
      revokeUserTokens: jest.fn().mockRejectedValue(unavailable)
    });
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({
      accessToken: 'at',
      refreshToken: 'rt',
      authenticatedUserId: 'u-1'
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('REVOCATION_UNAVAILABLE');
  });

  it('revogação parcial (um token caiu, o usuário não) ainda encerra a sessão', async() => {
    const tokenPort = makeTokenPort({
      revokeUserTokens: jest.fn().mockResolvedValue(false)
    });
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({ accessToken: 'at', authenticatedUserId: 'u-1' });

    // O access token apresentado morreu: ele não volta a valer.
    expect(result.success).toBe(true);
  });

  it('sem nenhum token e sem sessão identificada, nada é revogado', async() => {
    const tokenPort = makeTokenPort();
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({});

    expect(result.success).toBe(false);
    expect(result.code).toBe('REVOCATION_FAILED');
  });

  it('descobre o dono do refresh token ANTES de colocá-lo na blacklist (ordem obrigatória)', async() => {
    // TokenPort que se comporta como o adapter real: verifyRefreshToken é
    // recusado para token já revogado. É por isso que ler o refresh depois de
    // revogá-lo nunca encontra ninguém, e a revogação em massa silenciosamente
    // nunca acontece.
    const blacklist = new Set<string>();
    const tokenPort = {
      revokeToken: jest.fn(async(token: string) => {
        blacklist.add(token);
        return true;
      }),
      revokeUserTokens: jest.fn().mockResolvedValue(true),
      verifyRefreshToken: jest.fn(async(token: string) => {
        if (blacklist.has(token)) {
          throw new Error('Refresh token foi revogado');
        }
        return { id: 'u-77', username: 'alice' };
      })
    };
    const service = new AuthService({}, {}, tokenPort, makeLogger());

    const result = await service.endSession({ refreshToken: 'rt-real' });

    expect(result.success).toBe(true);
    expect(tokenPort.verifyRefreshToken).toHaveBeenCalledWith('rt-real');
    // A sessão inteira do dono do refresh cai, não só o par apresentado.
    expect(tokenPort.revokeUserTokens).toHaveBeenCalledWith('u-77');
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
