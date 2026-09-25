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
  const handlers: Record<string, (signal?: string) => void> = {};
  const spy = jest.spyOn(process, 'on').mockImplementation((event: string, handler: (signal?: string) => void) => {
    handlers[event] = handler;
    return process;
  });
  return { handlers, spy };
};

const captureTimeouts = () => {
  const captured: { fn: () => void; ms: number }[] = [];
  const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    captured.push({ fn, ms });
    return 0;
  }) as unknown as typeof setTimeout);
  return { captured, spy };
};

const createFakeServer = () => ({
  close: jest.fn((cb: () => void) => cb())
});

describe('errorHandler - respostas HTTP de erro', () => {
  it('constrói HttpError com status, code, message e details', async() => {
    const { HttpError } = await loadErrorHandler();
    const error = new HttpError(404, 'NOT_FOUND', 'Mensagem', { field: 'x' });

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Mensagem');
    expect(error.details).toEqual({ field: 'x' });
    expect(error.name).toBe('HttpError');
  });

  it('responde corpo estruturado para HttpError', async() => {
    const { errorHandler, HttpError } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new HttpError(401, 'UNAUTHORIZED', 'Credenciais inválidas', { hints: 'x' }), {} as never, res as never);

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

  it('cai para 500 e loga erro desconhecido', async() => {
    const { errorHandler } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new Error('boom'), {} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor'
    });
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('mapeia payload JSON inválido (body-parser) para 400 INVALID_JSON sem logar erro', async() => {
    const { errorHandler } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const parseError = new SyntaxError('Unexpected token');
    (parseError as unknown as Record<string, unknown>).type = 'entity.parse.failed';
    (parseError as unknown as Record<string, unknown>).status = 400;

    errorHandler(parseError, {} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'INVALID_JSON',
      message: 'Payload JSON inválido'
    });
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('respeita o status 4xx carregado pelo erro de cliente', async() => {
    const { errorHandler } = await loadErrorHandler();
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const clientError = new Error('Entidade muito grande');
    (clientError as unknown as Record<string, unknown>).statusCode = 413;

    errorHandler(clientError, {} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: 'BAD_REQUEST',
      message: 'Requisição inválida'
    });
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe('setupErrorHandlers - graceful shutdown', () => {
  it('registra handlers para sinais e erros não tratados', async() => {
    const { setupErrorHandlers } = await loadErrorHandler();
    const server = createFakeServer();
    const { handlers, spy } = captureProcessHandlers();
    const { spy: timeoutSpy } = captureTimeouts();

    setupErrorHandlers(server, 100);

    expect(handlers.SIGTERM).toBeDefined();
    expect(handlers.SIGINT).toBeDefined();
    expect(handlers.uncaughtException).toBeDefined();
    expect(handlers.unhandledRejection).toBeDefined();

    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('ignora exceções não tratadas de métricas para manter a app rodando', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server, 100);
    handlers.uncaughtException(new Error('metrics forEach() failed'));

    expect(server.close).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('agenda o fallback de force-close para o graceful shutdown', async() => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server, 100);
    handlers.SIGTERM?.();

    expect(server.close).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledWith(expect.any(Function));
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
