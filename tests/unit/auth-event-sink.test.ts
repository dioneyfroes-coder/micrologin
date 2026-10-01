import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { requestLogger } from '../../src/application/middleware/requestLogger.js';
import { requestLogAggregator } from '../../src/application/observability/requestLogAggregator.js';
import {
  recordAuthEvent,
  recordLoginAttempt,
  recordTokenRefresh,
  recordSecurityEvent,
  recordPasswordChange,
  setAuthEventSink
} from '../../src/application/observability/authEventSink.js';
import type { AuthEvent } from '../../src/application/observability/authEventSink.js';

/**
 * Coleta os eventos publicados e deixa o destino num lugar previsível.
 *
 * O serviço não embute nem scrapeia métricas: quem consome decide. Estes testes
 * verificam a PROMESSA da porta - o evento chega com o desfecho já traduzido, e
 * trocar o destino não exige tocar nos chamadores.
 */
const coletar = (): { events: AuthEvent[]; restore: () => void } => {
  const events: AuthEvent[] = [];
  const restore = setAuthEventSink(event => {
    events.push(event);
  });
  return { events, restore };
};

describe('requestLogger - middleware de log de requisições', () => {
  it('define X-Request-Id, loga método/path/status/duration no finish e alimenta o agregador', () => {
    requestLogAggregator.reset();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const setHeader = jest.fn();
    let finishHandler: () => void = () => {};
    const req = { method: 'POST', path: '/login', route: null, get: () => undefined };
    const res = {
      setHeader,
      statusCode: 201,
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const next = jest.fn();

    requestLogger(req as never, res as never, next);

    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
    expect(next).toHaveBeenCalledTimes(1);
    expect(finishHandler).not.toBe(undefined);

    finishHandler();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('POST /login'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('201'));
    expect(requestLogAggregator.getSnapshot().total).toBe(1);
    expect(requestLogAggregator.getSnapshot().by_status['201']).toBe(1);

    logSpy.mockRestore();
  });
});

describe('authEventSink - o desfecho viaja já traduzido', () => {
  let restore: (() => void) | null = null;
  let events: AuthEvent[] = [];

  beforeEach(() => {
    ({ events, restore } = coletar());
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('publica o login com o resultado certo, separado por lado', () => {
    recordLoginAttempt('success');
    recordLoginAttempt('failure');

    expect(events.map(event => `${event.kind}:${event.outcome}`))
      .toEqual(['login:success', 'login:failure']);
  });

  it('não mistura reuso de refresh com falha comum de usuário', () => {
    // O chamador passa o CÓDIGO do domínio. Era esse o caminho real, e como o
    // código não estava no conjunto de rótulos, os dois desfechos viravam
    // `error` e o teste, alimentado com os rótulos, passava sem exercitar nada
    // do que a aplicação faz.
    recordTokenRefresh('REFRESH_TOKEN_REUSED');
    recordTokenRefresh('REFRESH_TOKEN_INVALID');

    expect(events.map(event => event.outcome)).toEqual(['reused', 'invalid']);
    // O código do domínio viaja junto com o rótulo: o rótulo serve para
    // agrupar, o código serve para investigar.
    expect(events.map(event => event.code))
      .toEqual(['REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_INVALID']);
  });

  it('publica a detecção de reuso como evento de segurança', () => {
    recordSecurityEvent('TOKEN_REUSE_DETECTED');

    expect(events).toMatchObject([{
      kind: 'security',
      outcome: 'reused',
      code: 'TOKEN_REUSE_DETECTED',
      severity: 'high'
    }]);
  });

  it('separa revogação indisponível de token ruim', () => {
    // Redis fora em fail-closed: a sessão NÃO foi encerrada. Colapsar isso em
    // `invalid` faria uma indisponibilidade de infraestrutura parecer erro de
    // cliente - e o inverso também.
    recordTokenRefresh('REVOCATION_UNAVAILABLE');

    expect(events[0].outcome).toBe('unavailable');
  });

  it('troca de senha distingue senha atual errada de política de senha', () => {
    // São coisas diferentes: a primeira é o usuário errando a própria senha
    // atual, a segunda é uma senha que a política recusa.
    recordPasswordChange('CURRENT_PASSWORD_INVALID');
    recordPasswordChange('PASSWORD_REUSED');

    expect(events.map(event => event.outcome)).toEqual(['current_password_invalid', 'rejected']);
  });

  it('nenhum código real de cada fluxo colapsa em "error"', () => {
    // Cada código é testado só no fluxo que o emite: um `REFRESH_TOKEN_*` passado
    // para troca de senha é lixo de qualquer forma, e vira `error` por
    // konstru��ão.
    const porFluxo: Array<[(codigo: string) => unknown, string[]]> = [
      [recordTokenRefresh, [
        'REFRESH_TOKEN_REUSED',
        'REFRESH_TOKEN_INVALID',
        'REFRESH_TOKEN_EXPIRED',
        'REVOCATION_UNAVAILABLE'
      ]],
      [recordPasswordChange, [
        'CURRENT_PASSWORD_INVALID',
        'INVALID_PASSWORD',
        'PASSWORD_TOO_COMMON',
        'PASSWORD_REUSED',
        'USER_NOT_FOUND'
      ]],
      [recordLoginAttempt, ['AUTHENTICATION_FAILED', 'VALIDATION_ERROR']]
    ];

    for (const [emitir, codigos] of porFluxo) {
      events = [];
      codigos.forEach(emitir);
      // `error` fica reservado para o que é realmente desconhecido: se um código
      // que o domínio emite virasse `error`, o sinal de comprometimento
      // desapareceria.
      expect({ codigos, viraramError: events.filter(e => e.outcome === 'error') })
        .toEqual({ codigos, viraramError: [] });
    }
  });

  it('código desconhecido vira "error" e não vira rótulo novo', () => {
    // Um rótulo por erro destruiria qualquer agrupamento posterior.
    recordPasswordChange('senha_com_aspas\n_e_linha_nova');

    expect(events[0].outcome).toBe('error');
  });

  it('devolve o rótulo traduzido, para o chamador usar a mesma decisão', () => {
    // A auditoria deriva severidade e contadores do valor devolvido. Se a
    // tradução fosse feita em dois lugares, as duas decisões could divergir.
    expect(recordTokenRefresh('REFRESH_TOKEN_REUSED')).toBe('reused');
    expect(recordAuthEvent('login', 'success')).toBe('success');
  });

  it('destino que lança não derruba a autenticação', () => {
    restore?.();
    const restoreQuebrado = setAuthEventSink(() => {
      throw new Error('coletor fora do ar');
    });

    try {
      // O login já foi decidido; observabilidade quebrada não pode virar 500
      // numa credencial correta.
      expect(recordLoginAttempt('success')).toBe('success');
      expect(recordTokenRefresh('REFRESH_TOKEN_REUSED')).toBe('reused');
    } finally {
      restoreQuebrado();
    }
  });

  it('setAuthEventSink(null) volta para o destino padrão, que é o log', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const restauraPadrao = setAuthEventSink(null);

    try {
      recordLoginAttempt('success');

      // O coletor do beforeEach foi desfeito: o evento vai para o log, que é o
      // destino padrão e o que sustenta a retrospectiva sem coletor externo.
      expect(events).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('auth_event'));
    } finally {
      restauraPadrao();
      logSpy.mockRestore();
    }
  });
});
