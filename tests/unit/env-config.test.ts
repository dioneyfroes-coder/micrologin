import { describe, it, expect, jest } from '@jest/globals';

const loadEnv = async(dotenvConfigResult: Record<string, unknown>) => {
  jest.resetModules();
  const configMock = jest.fn(() => dotenvConfigResult);
  await jest.unstable_mockModule('dotenv', () => ({ default: { config: configMock } }));
  return {
    configMock,
    envModule: await import('../../src/interfaces/config/env.js')
  };
};

describe('env - carregamento de variáveis de ambiente', () => {
  it('carrega variáveis silenciosamente quando dotenv não falha', async() => {
    const { configMock, envModule } = await loadEnv({ parsed: {} });

    expect(envModule).toBeDefined();
    expect(configMock).toHaveBeenCalled();
  });

  it('avisa quando o arquivo .env não existe', async() => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { envModule } = await loadEnv({
      error: { code: 'ENOENT', message: 'missing' }
    });

    expect(envModule).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.env não encontrado'));

    warnSpy.mockRestore();
  });

  it('lança quando o erro de dotenv é crítico', async() => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadEnv({
      error: { code: 'SOMETHING_BROKE', message: 'boom' }
    })).rejects.toBeDefined();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
