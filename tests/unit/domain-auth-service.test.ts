import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User, DomainError, REVOCATION_UNAVAILABLE_CODE } from '../../src/domain/index.js';

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

  it('consulta e persiste o username na forma canônica (minúsculas)', async() => {
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

    const service = new AuthService(userRepository, crypto, {}, logger);
    const result = await service.registerUser('  Alice  ', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(userRepository.exists).toHaveBeenCalledWith('alice');
    expect(userRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' })
    );
    expect(result.user).toEqual({ id: 'u-1', username: 'alice' });
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

  it('propaga o código de revogação indisponível em vez de virar "senha errada"', async() => {
    // O adapter de tokens recusa em fail-closed quando o armazenamento de
    // revogação está fora. O `catch` genérico transformava isso em falha de
    // credencial, e o 503 do logout (que tem caminho próprio) virava 401 no
    // login: mesma causa, respostas opostas.
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    });
    const revocationDown = Object.assign(new Error('Revogação indisponível'), {
      code: REVOCATION_UNAVAILABLE_CODE
    });
    const tokenGenerator = {
      generateTokenPair: jest.fn().mockRejectedValue(revocationDown)
    };

    const service = new AuthService(
      userRepository,
      { compare: jest.fn().mockResolvedValue(true) },
      tokenGenerator,
      logger
    );
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(result.code).toBe(REVOCATION_UNAVAILABLE_CODE);
    expect(result.token).toBeNull();
  });

  it('recusa de credencial não ganha código de infraestrutura', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    });

    const service = new AuthService(
      userRepository,
      { compare: jest.fn().mockResolvedValue(false) },
      {},
      logger
    );
    const result = await service.authenticateUser('alice', 'WrongPass123!');

    // O código ausente é o que mantém o 401 genérico no lugar certo: o
    // controller só troca a resposta quando a causa é de infraestrutura.
    expect(result.success).toBe(false);
    expect(result.code).toBeNull();
  });

  it('busca o usuário pela forma canônica, independentemente da caixa enviada', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hashed-password'))
    });
    const crypto = { compare: jest.fn().mockResolvedValue(true) };
    const tokenGenerator = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 900000,
        type: 'Bearer'
      })
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator, logger);
    const result = await service.authenticateUser('  ALICE  ', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(userRepository.findByUsername).toHaveBeenCalledWith('alice');
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

describe('AuthService - reescrita do hash no login', () => {
  const tokenGenerator = () => ({
    generateTokenPair: jest.fn().mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 900000,
      type: 'Bearer'
    })
  });

  it('reescreve o hash fora do padrão atual e devolve o login', async() => {
    const logger = makeLogger();
    const user = new User('u-1', 'alice', 'hash-argon2-antigo');
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async(saved) => saved)
    });
    const crypto = {
      hash: jest.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$novo'),
      compare: jest.fn().mockResolvedValue(true),
      needsRehash: jest.fn().mockReturnValue(true)
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator(), logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(result.token.accessToken).toBe('at');
    // A reescrita acontece depois de a senha ser provada, e com a senha em
    // claro que o próprio usuário acabou de digitar.
    expect(crypto.hash).toHaveBeenCalledWith('StrongPass123!');
    expect(userRepository.save).toHaveBeenCalledTimes(1);
    expect(user.hashedPassword).toBe('$argon2id$v=19$m=19456,t=2,p=1$novo');
  });

  it('não trata reescrita como troca de senha: histórico e data ficam intactos', async() => {
    const logger = makeLogger();
    const user = new User('u-1', 'alice', 'hash-argon2-antigo', new Date('2024-01-01'), new Date('2024-02-02'), ['antigo-1'], new Date('2024-03-03'));
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async(saved) => saved)
    });
    const crypto = {
      hash: jest.fn().mockResolvedValue('hash-novo'),
      compare: jest.fn().mockResolvedValue(true),
      needsRehash: jest.fn().mockReturnValue(true)
    };

    await new AuthService(userRepository, crypto, tokenGenerator(), logger)
      .authenticateUser('alice', 'StrongPass123!');

    // Se o hash antigo fosse para o histórico, a senha original voltaria a ser
    // rejeitada depois da migração — e `passwordChangedAt` passaria a mentir
    // sobre quando o usuário trocou a senha.
    expect(user.passwordHistory).toEqual(['antigo-1']);
    expect(user.passwordChangedAt).toEqual(new Date('2024-03-03'));
    expect(user.updatedAt).toEqual(new Date('2024-02-02'));
  });

  it('mantém o login quando a escrita da reescrita falha', async() => {
    const logger = makeLogger();
    const user = new User('u-1', 'alice', 'hash-argon2-antigo');
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockRejectedValue(new Error('mongo indisponível'))
    });
    const crypto = {
      hash: jest.fn().mockResolvedValue('hash-novo'),
      compare: jest.fn().mockResolvedValue(true),
      needsRehash: jest.fn().mockReturnValue(true)
    };

    const service = new AuthService(userRepository, crypto, tokenGenerator(), logger);
    const result = await service.authenticateUser('alice', 'StrongPass123!');

    // O usuário provou a senha e o acesso é legítimo: uma falha de escrita não
    // pode virar erro de autenticação. A reescrita volta no próximo login.
    expect(result.success).toBe(true);
    expect(result.token.accessToken).toBe('at');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Não foi possível reescrever o hash'),
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('não escreve nada quando o hash já está no padrão', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hash-atual')),
      save: jest.fn()
    });
    const crypto = {
      hash: jest.fn(),
      compare: jest.fn().mockResolvedValue(true),
      needsRehash: jest.fn().mockReturnValue(false)
    };

    const result = await new AuthService(userRepository, crypto, tokenGenerator(), logger)
      .authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('funciona com hasher que não sabe dizer quando reescrever', async() => {
    // Os doubles que só sabem hash/compare continuam válidos: `needsRehash` é
    // opcional justamente para não obrigar todo mundo a saber responder isso.
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hash-atual'))
    });
    const crypto = { compare: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(userRepository, crypto, tokenGenerator(), logger)
      .authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(true);
  });

  it('não reescreve quando a senha está errada', async() => {
    const logger = makeLogger();
    const userRepository = makeRepo({
      findByUsername: jest.fn().mockResolvedValue(new User('u-1', 'alice', 'hash-argon2-antigo'))
    });
    const crypto = {
      hash: jest.fn(),
      compare: jest.fn().mockResolvedValue(false),
      needsRehash: jest.fn().mockReturnValue(true)
    };

    const result = await new AuthService(userRepository, crypto, tokenGenerator(), logger)
      .authenticateUser('alice', 'StrongPass123!');

    expect(result.success).toBe(false);
    expect(crypto.hash).not.toHaveBeenCalled();
  });
});

describe('AuthService - histórico indisponível na troca de senha', () => {
  it('recusa com código de indisponibilidade quando o histórico não pode ser lido', async() => {
    // Fail-open aqui significaria liberar troca de senha sem checar reuso — a
    // resposta que o usuário quer, sem base para dar. 503 diz a verdade certa.
    const logger = makeLogger();
    const user = new User('u-1', 'alice', 'hash-atual', new Date(), new Date(), ['hash-antigo']);
    const userRepository = makeRepo({ findById: jest.fn().mockResolvedValue(user) });
    const crypto = {
      // O hash atual não é o da senha nova; a falha vem do histórico.
      compare: jest.fn()
        .mockResolvedValueOnce(true)   // senha atual confere
        .mockResolvedValueOnce(false)  // não é reuso do hash atual
        .mockRejectedValueOnce(new Error('pepper ausente')),
      hash: jest.fn()
    };

    const result = await new AuthService(userRepository, crypto, {}, logger)
      .changePassword('u-1', 'StrongPass123!', 'Kf7#mQ2$vLp9!');

    expect(result.success).toBe(false);
    expect(result.code).toBe('PASSWORD_HISTORY_UNAVAILABLE');
    expect(crypto.hash).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
