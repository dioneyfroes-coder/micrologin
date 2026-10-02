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

  it('derruba o processo em qualquer uncaughtException, inclusive com "forEach" na mensagem', async() => {
    // A isenção antiga era `if (err.message.includes('forEach')) return`. O
    // ponto deste teste é que a palavra deixou de ter qualquer efeito: um
    // `TypeError` de domínio dentro de um `forEach` derrubava o processo igual
    // a qualquer outro erro.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server, 100);
    handlers.uncaughtException(new TypeError('x is not a function in forEach'));

    expect(server.close).toHaveBeenCalled();
    await new Promise(resolve => globalThis.setImmediate(resolve));

    // Saída não-zero: é isso que faz o PM2/systemd reiniciarem. Um exit(0)
    // seria lido como encerramento limpo e o processo inconsistente sobreviveria.
    //
    // A afirmação vem ANTES de disparar o timer de force-close de propósito: ele
    // também chama exit(1), e checar depois transformaria qualquer código de
    // saída em teste verde.
    expect(exitSpy).toHaveBeenCalledWith(1);

    captured.forEach(entry => entry.fn());

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('registra a causa do uncaughtException antes de derrubar', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { spy: timeoutSpy } = captureTimeouts();

    setupErrorHandlers(createFakeServer(), 100);
    handlers.uncaughtException(new Error('banana'));

    // Um exit sem log é um processo que morre sem explicação: quem lê o log
    // depois do restart não tem como saber por que o container caiu. O logger
    // formata mensagem e causa numa string só, então é ela que carrega as duas.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Erro não tratado'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('banana'));

    // O `close()` do fake é síncrono, mas o callback que ele dispara é async:
    // o `process.exit` acontece numa microtask depois daqui. Sem esta espera, o
    // `mockRestore()` rodaria antes e o exit chamaria o `process.exit` de
    // verdade — matando a própria suíte.
    await new Promise(resolve => globalThis.setImmediate(resolve));

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('graceful shutdown é idempotente: dois sinais não abrem duas rotinas', async() => {
    // Sem a trava, o segundo shutdown chamaria `server.close()` de novo sobre
    // um servidor já fechado — o que lança, cai no `catch` e chama exit(1) no
    // meio do encerramento limpo, antes do `close()` bem-sucedido completar.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server, 100);
    handlers.SIGTERM?.();
    handlers.uncaughtException?.(new Error('segunda coisa'));
    handlers.SIGINT?.();

    expect(server.close).toHaveBeenCalledTimes(1);
    // Um único timer de force-close, senão os dois compete para matar o processo.
    expect(captured).toHaveLength(1);

    captured.forEach(entry => entry.fn());
    await new Promise(resolve => globalThis.setImmediate(resolve));

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('SIGTERM encerra com saída 0: encerramento pedido é sucesso', async() => {
    // O inverso do uncaughtException: aqui exit(0) é o correto, e é o que evita
    // que um deploy ou um `docker stop` treatable vire reinício eternal.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();

    setupErrorHandlers(createFakeServer(), 100);
    handlers.SIGTERM?.();
    await new Promise(resolve => globalThis.setImmediate(resolve));

    // Antes do timer: o exit(1) do force-close não pode satisfazer esta
    // afirmação, que é justamente sobre o exit(0) do encerramento limpo.
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    captured.forEach(entry => entry.fn());

    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    spy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('unhandledRejection usa o mesmo modelo e também derruba com saída não-zero', async() => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => 0 as never);
    const { setupErrorHandlers } = await loadErrorHandler();
    const { handlers, spy } = captureProcessHandlers();
    const { captured, spy: timeoutSpy } = captureTimeouts();
    const server = createFakeServer();

    setupErrorHandlers(server, 100);
    handlers.unhandledRejection?.(new Error('query falhou'), Promise.resolve());

    expect(server.close).toHaveBeenCalled();
    await new Promise(resolve => globalThis.setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalledWith(1);

    captured.forEach(entry => entry.fn());

    logSpy.mockRestore();
    errorSpy.mockRestore();
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
