import { describe, it, expect, jest } from '@jest/globals';

const mongooseMock = {
  connection: {
    readyState: 1,
    close: jest.fn(async() => {})
  }
};

const loadErrorHandler = async() => {
  jest.resetModules();
  await jest.unstable_mockModule('mongoose', () => ({ default: mongooseMock }));
  return await import('../../src/shared/utils/errorHandler.js');
};

const captureProcessHandlers = () => {
  const handlers = {};
  const spy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
    handlers[event] = handler;
    return process;
  });
  return { handlers, spy };
};

const createFakeServer = () => ({
  close: jest.fn(cb => cb())
});

const captureTimeouts = () => {
  const captured = [];
  const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
    captured.push({ fn, ms });
    return 0;
  });
  return { captured, spy };
};

describe('errorHandler - HTTP error responses', () => {
  it('builds HttpError with status, code, message and details', async() => {
    const { HttpError } = await loadErrorHandler();
    const error = new HttpError(404, 'NOT_FOUND', 'Mensagem', { field: 'x' });

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Mensagem');
    expect(error.details).toEqual({ field: 'x' });
    expect(error.name).toBe('HttpError');
  });

  it('responds with a structured body for HttpError', async() => {
    const { errorHandler, HttpError } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new HttpError(401, 'UNAUTHORIZED', 'Credenciais inválidas', { hints: 'x' }), {}, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Credenciais inválidas',
      details: { hints: 'x' }
    });
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('falls back to 500 for unknown errors and logs them', async() => {
    const { errorHandler } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new Error('boom'), {}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor'
    });
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe('setupErrorHandlers - process-level handling', () => {
  it('registers signal and error handlers and a force-close timer strategy', async() => {
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server);

    expect(handlers.SIGTERM).toBeDefined();
    expect(handlers.SIGINT).toBeDefined();
    expect(handlers.uncaughtException).toBeDefined();
    expect(handlers.unhandledRejection).toBeDefined();

    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('ignores metrics-related uncaught exceptions so the app keeps running', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server);
    handlers.uncaughtException(new Error('metrics forEach() failed'));

    expect(server.close).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('schedules a force-close fallback for graceful shutdown', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server);
    handlers.SIGTERM();

    expect(server.close).toHaveBeenCalled();
    expect(captured.length).toBeGreaterThan(0);

    captured.forEach(entry => entry.fn());
    await new Promise(resolve => globalThis.setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });
});
