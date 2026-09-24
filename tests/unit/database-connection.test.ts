import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mongooseMock = {
  connect: jest.fn(async() => {})
};

const loadConnection = async() => {
  jest.resetModules();
  await jest.unstable_mockModule('mongoose', () => ({ default: mongooseMock }));
  return await import('../../src/infrastructure/database/connection.js');
};

describe('connectDatabase - conexão MongoDB', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.URI_MONGODB;
  });

  it('conecta usando a URI configurada sem opções extras', async() => {
    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';

    await connectDatabase();

    expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://localhost:27017/app', {});
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
