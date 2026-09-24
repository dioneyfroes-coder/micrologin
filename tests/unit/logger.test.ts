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
