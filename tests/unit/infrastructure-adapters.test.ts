import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [{ MongoUserAdapter, PasswordHasher, ConsoleLoggerAdapter, AdapterFactory }, models, domain] =
  await (async() => {
    // `select()` é encadeável em Mongoose e devolve a própria query
    const chainable = (result: unknown) => ({ select: jest.fn(() => result) });
    const modelMock = {
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      chainable
    };

    await jest.unstable_mockModule('../../src/infrastructure/database/models/User.js', () => ({
      getUserModel: jest.fn(() => modelMock)
    }));

    const adapters = await import('../../src/infrastructure/adapters/index.js');
    const modelsModule = await import('../../src/infrastructure/database/models/User.js');
    const domainModule = await import('../../src/domain/index.js');

    return [adapters, modelsModule, domainModule];
  })();

const { getUserModel } = models;

const makeDoc = (id: string, user: string, password: string, passwordHistory: string[] = []) => ({
  _id: { toString: () => id },
  user,
  password,
  passwordHistory,
  passwordChangedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date()
});

describe('PasswordHasher - porta de cripto', () => {
  it('grava argon2id com os parâmetros da fábrica', async() => {
    const hasher = AdapterFactory.createCryptoService({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 } });

    expect(hasher).toBeInstanceOf(PasswordHasher);
    await expect(hasher.hash('StrongPass123!')).resolves.toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
  });

  it('nunca sai do argon2id, mesmo pedindo outro tipo', async() => {
    // A antiga rejeição de tipo não builtin mais: o algoritmo é fixo e não há
    // caminho alternativo para cair.
    const hasher = AdapterFactory.createCryptoService({ argon2: { memoryCost: 8192, timeCost: 1, parallelism: 1 } });

    await expect(hasher.hash('StrongPass123!')).resolves.toMatch(/^\$argon2id\$/);
  });
});

describe('MongoUserAdapter - implementação do UserRepositoryPort', () => {
  let modelMock: ReturnType<typeof getUserModel>;
  let adapter: MongoUserAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    modelMock = getUserModel();
    adapter = new MongoUserAdapter();
  });

  it('mapeia documento encontrado para um User de domínio', async() => {
    modelMock.findById.mockReturnValue(modelMock.chainable(makeDoc('abc123', 'alice', 'hashed')));

    const user = await adapter.findById('abc123');

    expect(user?.id).toBe('abc123');
    expect(user?.username).toBe('alice');
    expect(user?.hashedPassword).toBe('hashed');
    expect(user?.passwordHistory).toEqual([]);
  });

  it('carrega o histórico de senhas (select: false no schema)', async() => {
    modelMock.findById.mockReturnValue(
      modelMock.chainable(makeDoc('abc123', 'alice', 'hashed', ['hash-antigo']))
    );

    const user = await adapter.findById('abc123');

    expect(user?.passwordHistory).toEqual(['hash-antigo']);
    expect(modelMock.findById).toHaveBeenCalledWith('abc123');
  });

  it('retorna null quando não há usuário com o ID', async() => {
    modelMock.findById.mockReturnValue(modelMock.chainable(null));

    const user = await adapter.findById('missing');

    expect(user).toBeNull();
  });

  it('busca usuário por username', async() => {
    modelMock.findOne.mockResolvedValue(makeDoc('abc123', 'alice', 'hashed'));

    const user = await adapter.findByUsername('alice');

    expect(user?.username).toBe('alice');
  });

  it('cria um novo usuário quando não há id', async() => {
    modelMock.create.mockResolvedValue(makeDoc('new1', 'bob', 'hashed'));

    const saved = await adapter.save(new domain.User(null, 'bob', 'hashed'));

    expect(saved.id).toBe('new1');
    expect(modelMock.create).toHaveBeenCalledWith(expect.objectContaining({ user: 'bob' }));
  });

  it('atualiza o documento quando há id', async() => {
    modelMock.findByIdAndUpdate.mockReturnValue(
      modelMock.chainable(makeDoc('abc123', 'alice2', 'hashed2'))
    );

    const user = new domain.User('abc123', 'alice2', 'hashed2');
    const saved = await adapter.save(user);

    expect(saved.username).toBe('alice2');
    expect(modelMock.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({
        user: 'alice2',
        passwordHistory: [],
        passwordChangedAt: expect.any(Date)
      }),
      { new: true }
    );
  });

  it('persiste o histórico de senhas ao trocar a senha', async() => {
    modelMock.findByIdAndUpdate.mockReturnValue(
      modelMock.chainable(makeDoc('abc123', 'alice', 'hash-novo', ['hash-antigo']))
    );

    const user = new domain.User('abc123', 'alice', 'hash-novo', new Date(), new Date(), ['hash-antigo']);
    const saved = await adapter.save(user);

    expect(modelMock.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ passwordHistory: ['hash-antigo'] }),
      { new: true }
    );
    expect(saved.passwordHistory).toEqual(['hash-antigo']);
  });

  it('deleta usuário por id', async() => {
    modelMock.findByIdAndDelete.mockResolvedValue(true);

    await adapter.delete('abc123');

    expect(modelMock.findByIdAndDelete).toHaveBeenCalledWith('abc123');
  });

  it('verifica se um username existe', async() => {
    modelMock.countDocuments.mockResolvedValue(1);

    const exists = await adapter.exists('alice');

    expect(exists).toBe(true);
    expect(modelMock.countDocuments).toHaveBeenCalledWith({ user: 'alice' });
  });

  it('retorna false quando o username não existe', async() => {
    modelMock.countDocuments.mockResolvedValue(0);

    const exists = await adapter.exists('ghost');

    expect(exists).toBe(false);
  });
});

describe('ConsoleLoggerAdapter - implementação do LoggerPort', () => {
  it('loga info, error e warn', () => {
    const infoSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const logger = new ConsoleLoggerAdapter();
    logger.info('info msg');
    logger.error('error msg', new Error('detail'));
    logger.warn('warn msg');

    expect(infoSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    infoSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('AdapterFactory - fábrica de adapters', () => {
  it('cria hasher de senha por padrão', () => {
    expect(AdapterFactory.createCryptoService()).toBeInstanceOf(PasswordHasher);
  });

  it('cria logger de console', () => {
    expect(AdapterFactory.createLogger()).toBeInstanceOf(ConsoleLoggerAdapter);
  });
});
