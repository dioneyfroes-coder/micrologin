import { describe, it, expect, jest } from '@jest/globals';

describe('env configuration loading', () => {
  const loadEnv = async(dotenvConfigResult) => {
    jest.resetModules();
    const configMock = jest.fn(() => dotenvConfigResult);
    await jest.unstable_mockModule('dotenv', () => ({ default: { config: configMock } }));
    return {
      configMock,
      envModule: await import('../../src/interfaces/config/env.js')
    };
  };

  it('silently loads env vars when dotenv succeeds', async() => {
    const { configMock, envModule } = await loadEnv({ parsed: {} });

    expect(envModule).toBeDefined();
    expect(configMock).toHaveBeenCalled();
  });

  it('warns when the .env file is missing', async() => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { envModule } = await loadEnv({
      error: { code: 'ENOENT', message: 'missing' }
    });

    expect(envModule).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.env não encontrado'));

    warnSpy.mockRestore();
  });

  it('logs a status message in development mode', async() => {
    process.env.NODE_ENV = 'development';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { envModule } = await loadEnv({ parsed: {} });

    expect(envModule).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith('🔧 Variáveis de ambiente carregadas');

    logSpy.mockRestore();
    delete process.env.NODE_ENV;
  });
});
