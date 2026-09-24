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

  it('encerra o processo quando a URI não está configurada', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const { connectDatabase } = await loadConnection();

    await connectDatabase();

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('encerra o processo quando a conexão falha', async() => {
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
