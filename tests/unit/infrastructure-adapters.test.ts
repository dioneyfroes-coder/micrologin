import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [{ MongoUserAdapter, BcryptAdapter, ConsoleLoggerAdapter, AdapterFactory }, bcryptModule, models, domain] =
  await (async() => {
    const bcryptMock = {
      hash: jest.fn(),
      compare: jest.fn()
    };

    const modelMock = {
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn()
    };

    await jest.unstable_mockModule('bcrypt', () => ({ default: bcryptMock }));
    await jest.unstable_mockModule('../../src/infrastructure/database/models/User.js', () => ({
      getUserModel: jest.fn(() => modelMock)
    }));

    const adapters = await import('../../src/infrastructure/adapters/index.js');
    const bcryptModule = await import('bcrypt');
    const modelsModule = await import('../../src/infrastructure/database/models/User.js');
    const domainModule = await import('../../src/domain/index.js');

    return [adapters, bcryptModule, modelsModule, domainModule];
  })();

const bcrypt = bcryptModule.default;
const { getUserModel } = models;

const makeDoc = (id: string, user: string, password: string) => ({
  _id: { toString: () => id },
  user,
  password,
  createdAt: new Date(),
  updatedAt: new Date()
});

describe('BcryptAdapter - implementação do CryptoPort', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gera hash com os salt rounds configurados', async() => {
    bcrypt.hash.mockResolvedValue('$2b$12$hashed');
    const adapter = new BcryptAdapter(10);

    const result = await adapter.hash('StrongPass123!');

    expect(bcrypt.hash).toHaveBeenCalledWith('StrongPass123!', 10);
    expect(result).toBe('$2b$12$hashed');
  });

  it('compara texto puro com o hash', async() => {
    bcrypt.compare.mockResolvedValue(true);
    const adapter = new BcryptAdapter();

    const result = await adapter.compare('StrongPass123!', '$2b$12$hashed');

    expect(bcrypt.compare).toHaveBeenCalledWith('StrongPass123!', '$2b$12$hashed');
    expect(result).toBe(true);
  });

  it('encapsula erros de hash com mensagem contextual', async() => {
    bcrypt.hash.mockRejectedValue(new Error('boom'));
    const adapter = new BcryptAdapter();

    await expect(adapter.hash('StrongPass123!')).rejects.toThrow('Erro ao criptografar: boom');
  });

  it('encapsula erros de comparação com mensagem contextual', async() => {
    bcrypt.compare.mockRejectedValue(new Error('boom'));
    const adapter = new BcryptAdapter();

    await expect(adapter.compare('a', 'b')).rejects.toThrow('Erro ao comparar hash: boom');
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
    modelMock.findById.mockResolvedValue(makeDoc('abc123', 'alice', 'hashed'));

    const user = await adapter.findById('abc123');

    expect(user?.id).toBe('abc123');
    expect(user?.username).toBe('alice');
    expect(user?.hashedPassword).toBe('hashed');
  });

  it('retorna null quando não há usuário com o ID', async() => {
    modelMock.findById.mockResolvedValue(null);

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

    const saved = await adapter.save({
      id: null,
      username: 'bob',
      hashedPassword: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    expect(saved.id).toBe('new1');
    expect(modelMock.create).toHaveBeenCalledWith(expect.objectContaining({ user: 'bob' }));
  });

  it('atualiza o documento quando há id', async() => {
    modelMock.findByIdAndUpdate.mockResolvedValue(makeDoc('abc123', 'alice2', 'hashed2'));

    const user = new domain.User('abc123', 'alice2', 'hashed2');
    const saved = await adapter.save(user);

    expect(saved.username).toBe('alice2');
    expect(modelMock.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ user: 'alice2' }),
      { new: true }
    );
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
  it('cria crypto adapter bcrypt por padrão', () => {
    const crypto = AdapterFactory.createCrypto(10) as BcryptAdapter;
    expect(crypto).toBeInstanceOf(BcryptAdapter);
    expect(crypto.saltRounds).toBe(10);
  });

  it('rejeita tipos de crypto não suportados', () => {
    expect(() => AdapterFactory.createCryptoService('argon2')).toThrow('não suportado');
  });

  it('cria logger de console', () => {
    expect(AdapterFactory.createLogger()).toBeInstanceOf(ConsoleLoggerAdapter);
  });
});
