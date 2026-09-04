import { describe, it, expect, jest } from '@jest/globals';

const mongooseMock = {
  connect: jest.fn(async() => {})
};

const loadConnection = async() => {
  jest.resetModules();
  await jest.unstable_mockModule('mongoose', () => ({ default: mongooseMock }));
  return await import('../../src/infrastructure/database/connection.js');
};

describe('connectDatabase - MongoDB connection', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.URI_MONGODB;
  });

  it('connects using the configured URI and logs success', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';

    await connectDatabase();

    expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://localhost:27017/app', {});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Conectado ao MongoDB'));

    logSpy.mockRestore();
  });

  it('exits when the URI is not configured', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const { connectDatabase } = await loadConnection();

    await connectDatabase();

    expect(errorSpy.mock.calls[0][0]).toContain('Erro ao conectar');
    expect(errorSpy.mock.calls[0][1].message).toContain('URI_MONGODB não definida');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits when the connection attempt rejects', async() => {
    mongooseMock.connect.mockRejectedValueOnce(new Error('connection timeout'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const { connectDatabase } = await loadConnection();
    process.env.URI_MONGODB = 'mongodb://localhost:27017/app';

    await connectDatabase();

    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
