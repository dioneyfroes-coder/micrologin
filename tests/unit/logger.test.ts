import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loadLogger = async() => {
  jest.resetModules();
  return await import('../../src/shared/utils/logger.js');
};

describe('logger - níveis e formato', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    jest.restoreAllMocks();
  });

  it('exporta os níveis ordenados', async() => {
    const { LOG_LEVELS } = await loadLogger();
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
  });

  it('shouldLog respeita o nível configurado (default info)', async() => {
    const { shouldLog } = await loadLogger();
    expect(shouldLog('info')).toBe(true);
    expect(shouldLog('debug')).toBe(false);
    expect(shouldLog('error')).toBe(true);
  });

  it('deve logar até warnings quando LOG_LEVEL=warn', async() => {
    process.env.LOG_LEVEL = 'warn';
    const { shouldLog } = await loadLogger();
    expect(shouldLog('info')).toBe(false);
    expect(shouldLog('warn')).toBe(true);
    expect(shouldLog('error')).toBe(true);
  });

  it('imprime mensagem no formato console com timestamp e nível', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { logger } = await loadLogger();
    logger.info('mensagem de teste');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('INFO'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mensagem de teste'));
    logSpy.mockRestore();
  });

  it('imprime erros usando console.error', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { logger } = await loadLogger();
    logger.error('falha', new Error('boom'));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('falha'));
    errorSpy.mockRestore();
  });

  it('console mostra a mensagem e a stack do Error, não um objeto vazio', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { logger } = await loadLogger();
    logger.error('Erro na autenticação', new Error('pkcs8 must be PKCS#8 formatted string'));

    const line = errorSpy.mock.calls[0][0] as string;
    // `{...error}` (o que havia antes) produz `{}`: `message` e `stack` não são
    // propriedades enumeráveis. A falha de assinatura que derrubava todo login
    // ficou sem motivo no log exatamente por isso.
    expect(line).toContain('pkcs8 must be PKCS#8 formatted string');
    expect(line).toContain('Error:');
    errorSpy.mockRestore();
  });

  it('formato estruturado expõe name, message, stack e code do Error', async() => {
    process.env.LOG_FORMAT = 'structured';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { logger } = await loadLogger();

    const failure = Object.assign(new Error('revogação fora'), { code: 'REVOCATION_UNAVAILABLE' });
    logger.error('falha ao autenticar', failure);

    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string) as {
      message: string;
      error: { name: string; message: string; code?: string; stack?: string };
    };
    expect(entry.message).toBe('falha ao autenticar');
    expect(entry.error.message).toBe('revogação fora');
    expect(entry.error.name).toBe('Error');
    expect(entry.error.code).toBe('REVOCATION_UNAVAILABLE');
    expect(entry.error.stack).toContain('Error: revogação fora');
    errorSpy.mockRestore();
  });

  it('não trata objeto comum como Error, e mantém as chaves recebidas', async() => {
    process.env.LOG_FORMAT = 'structured';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { logger } = await loadLogger();
    logger.error('falha com contexto', { attempt: 3, user: 'ana' });

    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(entry.attempt).toBe(3);
    expect(entry.user).toBe('ana');
    errorSpy.mockRestore();
  });

  it('não emite nada para níveis abaixo do configurado', async() => {
    process.env.LOG_LEVEL = 'error';
    const { logger } = await loadLogger();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logger.info('deve ser suprimido');
    logger.warn('também suprimido');
    logger.error('esse passa');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
