import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mongooseMock = {
  connect: jest.fn(async() => {})
};

const loadConnection = async() => {
  jest.resetModules();
  await jest.unstable_mockModule('mongoose', () => ({ default: mongooseMock }));
  return await import('../../src/infrastructure/database/connection.js');
};

const MONGO_ENV = [
  'URI_MONGODB', 'MONGODB_USER', 'MONGODB_PASSWORD', 'MONGODB_PASSWORD_PATH',
  'MONGODB_AUTH_SOURCE', 'MONGODB_TLS', 'MONGODB_MAX_POOL_SIZE',
  'MONGODB_TIMEOUT', 'MONGODB_SOCKET_TIMEOUT'
];

describe('connectDatabase - conexão MongoDB', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mongooseMock.connect.mockClear();
    for (const key of MONGO_ENV) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MONGO_ENV) {
      delete process.env[key];
    }
  });

  it('aplica pool e timeouts que antes ficavam declarados e sem efeito', async() => {
    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';

    await connectDatabase();

    expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://localhost:27017/app', {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });
  });

  it('passa a credencial separada da URI como auth/authSource', async() => {
    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';
    process.env.MONGODB_USER = 'auth-service';
    process.env.MONGODB_PASSWORD = 'senha-de-teste';

    await connectDatabase();

    expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://localhost:27017/app', {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      auth: { username: 'auth-service', password: 'senha-de-teste' },
      authSource: 'admin'
    });
  });

  it('rejeita quando a URI não está configurada', async() => {
    const { connectDatabase } = await loadConnection();

    await expect(connectDatabase()).rejects.toThrow('URI_MONGODB não definida');
  });

  it('rejeita quando a conexão falha', async() => {
    mongooseMock.connect.mockRejectedValueOnce(new Error('connection timeout'));

    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';

    await expect(connectDatabase()).rejects.toThrow('connection timeout');
  });
});
