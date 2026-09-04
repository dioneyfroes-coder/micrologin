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

describe('BcryptAdapter - CryptoPort implementation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hashes plain text using bcrypt with configured salt rounds', async() => {
    bcrypt.hash.mockResolvedValue('$2b$12$hashed');
    const adapter = new BcryptAdapter(10);

    const result = await adapter.hash('StrongPass123!');

    expect(bcrypt.hash).toHaveBeenCalledWith('StrongPass123!', 10);
    expect(result).toBe('$2b$12$hashed');
  });

  it('compares plain text against a hash', async() => {
    bcrypt.compare.mockResolvedValue(true);
    const adapter = new BcryptAdapter();

    const result = await adapter.compare('StrongPass123!', '$2b$12$hashed');

    expect(bcrypt.compare).toHaveBeenCalledWith('StrongPass123!', '$2b$12$hashed');
    expect(result).toBe(true);
  });

  it('wraps hash errors with a contextual message', async() => {
    bcrypt.hash.mockRejectedValue(new Error('boom'));
    const adapter = new BcryptAdapter();

    await expect(adapter.hash('StrongPass123!')).rejects.toThrow('Erro ao criptografar: boom');
  });
});

describe('MongoUserAdapter - UserRepositoryPort implementation', () => {
  let modelMock;
  let adapter;

  beforeEach(() => {
    jest.clearAllMocks();
    modelMock = getUserModel();
    adapter = new MongoUserAdapter();
  });

  it('maps a found user document to a domain User', async() => {
    modelMock.findById.mockResolvedValue({
      _id: { toString: () => 'abc123' },
      user: 'alice',
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const user = await adapter.findById('abc123');

    expect(user.id).toBe('abc123');
    expect(user.username).toBe('alice');
    expect(user.hashedPassword).toBe('hashed');
  });

  it('returns null when no user matches the ID', async() => {
    modelMock.findById.mockResolvedValue(null);

    const user = await adapter.findById('missing');

    expect(user).toBeNull();
  });

  it('finds a user by username', async() => {
    modelMock.findOne.mockResolvedValue({
      _id: { toString: () => 'abc123' },
      user: 'alice',
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const user = await adapter.findByUsername('alice');

    expect(user.username).toBe('alice');
  });

  it('creates a new user when no id is present', async() => {
    modelMock.create.mockResolvedValue({
      _id: { toString: () => 'new1' },
      user: 'bob',
      password: 'hashed',
      createdAt: new Date(),
      updatedAt: new Date()
    });

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

  it('updates the user document when an id is present', async() => {
    modelMock.findByIdAndUpdate.mockResolvedValue({
      _id: { toString: () => 'abc123' },
      user: 'alice2',
      password: 'hashed2',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const user = new domain.User('abc123', 'alice2', 'hashed2');
    const saved = await adapter.save(user);

    expect(saved.username).toBe('alice2');
    expect(modelMock.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ user: 'alice2' }),
      { new: true }
    );
  });

  it('deletes a user by id', async() => {
    modelMock.findByIdAndDelete.mockResolvedValue(true);

    await adapter.delete('abc123');

    expect(modelMock.findByIdAndDelete).toHaveBeenCalledWith('abc123');
  });

  it('checks whether a username exists', async() => {
    modelMock.countDocuments.mockResolvedValue(1);

    const exists = await adapter.exists('alice');

    expect(exists).toBe(true);
    expect(modelMock.countDocuments).toHaveBeenCalledWith({ user: 'alice' });
  });

  it('returns false when no user has the username', async() => {
    modelMock.countDocuments.mockResolvedValue(0);

    const exists = await adapter.exists('ghost');

    expect(exists).toBe(false);
  });
});

describe('ConsoleLoggerAdapter - LoggerPort implementation', () => {
  it('logs info, error and warn messages', () => {
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

describe('AdapterFactory', () => {
  it('creates a bcrypt crypto adapter by default', () => {
    const crypto = AdapterFactory.createCrypto(10);
    expect(crypto).toBeInstanceOf(BcryptAdapter);
    expect(crypto.saltRounds).toBe(10);
  });

  it('rejects unsupported crypto types', () => {
    expect(() => AdapterFactory.createCryptoService('argon2')).toThrow('não suportado');
  });

  it('creates a console logger', () => {
    expect(AdapterFactory.createLogger()).toBeInstanceOf(ConsoleLoggerAdapter);
  });
});
