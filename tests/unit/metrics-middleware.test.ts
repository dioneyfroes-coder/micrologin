import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const [requestLoggerImport, metricsImport] = await (async() => {
  const metrics = await import('../../src/shared/utils/metrics.js');
  const logger = await import('../../src/application/middleware/requestLogger.js');
  return [logger, metrics];
})();

const { requestLogger } = requestLoggerImport;
const {
  metricsMiddleware,
  httpRequestTotal,
  httpRequestDuration,
  recordLoginAttempt,
  recordTokenRefresh,
  recordPasswordChange
} = metricsImport;
const { requestLogAggregator } = await import('../../src/application/observability/requestLogAggregator.js');

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

describe('metricsMiddleware - métricas Prometheus', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('registra duração e contagem quando a resposta termina', () => {
    let finishHandler: () => void = () => {};
    const res = {
      statusCode: 200,
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = { method: 'GET', path: '/health', route: null };
    const next = jest.fn();

    metricsMiddleware(req as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));

    finishHandler();

    expect(httpRequestTotal.name).toBe('http_requests_total');
    expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
  });

  it('sobrevive a erros ao coletar métricas', () => {
    let finishHandler: () => void = () => {};
    const res = {
      get statusCode() {
        throw new Error('status not available');
      },
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
      })
    };
    const req = { method: 'GET', path: '/health', route: null };
    const next = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    metricsMiddleware(req as never, res as never, next);
    finishHandler();

    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('métricas de autenticação - semântica por resultado', () => {
  it('separa sucesso e falha em rótulos distintos', async() => {
    recordLoginAttempt('success');
    recordLoginAttempt('failure');
    recordLoginAttempt('failure');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const login = samples.find(sample => sample.name === 'auth_login_attempts_total');

    expect(login).toBeDefined();
    const byOutcome = Object.fromEntries(
      (login?.values ?? []).map(value => [value.labels.outcome, value.value])
    );
    expect(byOutcome.success).toBeGreaterThanOrEqual(1);
    expect(byOutcome.failure).toBeGreaterThanOrEqual(2);
  });

  it('não mistura reuso de refresh com falha comum de usuário', async() => {
    // O controller passa o CÓDIGO do domínio, não o rótulo pronto. Era esse o
    // caminho real, e como o código não estava no conjunto de labels, os dois
    // desfechos viravam `error` e este teste, alimentado com os rótulos, passava
    // sem exercitar nada do que a aplicação faz.
    recordTokenRefresh('REFRESH_TOKEN_REUSED');
    recordTokenRefresh('REFRESH_TOKEN_INVALID');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const refresh = samples.find(sample => sample.name === 'auth_token_refresh_total');
    const byOutcome = Object.fromEntries(
      (refresh?.values ?? []).map(value => [value.labels.outcome, value.value])
    );

    expect(byOutcome.reused).toBeGreaterThanOrEqual(1);
    expect(byOutcome.invalid).toBeGreaterThanOrEqual(1);
    expect(byOutcome.error).toBeUndefined();
  });

  it('separa revogação indisponível de token ruim', async() => {
    // Redis fora em fail-closed: a sessão NÃO foi encerrada. Colapsar isso em
    // `invalid` faria uma indisponibilidade de infraestrutura parecer erro de
    // cliente - e o inverso, attacks, também.
    recordTokenRefresh('REVOCATION_UNAVAILABLE');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const refresh = samples.find(sample => sample.name === 'auth_token_refresh_total');
    const outcomes = (refresh?.values ?? []).map(value => value.labels.outcome);

    expect(outcomes).toContain('unavailable');
  });

  it('troca de senha distingue senha atual errada de política de senha', async() => {
    recordPasswordChange('CURRENT_PASSWORD_INVALID');
    recordPasswordChange('PASSWORD_REUSED');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const changes = samples.find(sample => sample.name === 'auth_password_changes_total');
    const outcomes = (changes?.values ?? []).map(value => value.labels.outcome);

    // São coisas diferentes: a primeira é o usuário errando a própria senha
    // atual, a segunda é uma senha que a política recusa.
    expect(outcomes).toContain('current_password_invalid');
    expect(outcomes).toContain('rejected');
  });

  it('nenhum desfecho real de autenticação colapsa em "error"', async() => {
    // A regressão que motivou a mudança, verificada pelo caminho do controller.
    const codigos = [
      'REFRESH_TOKEN_REUSED',
      'REFRESH_TOKEN_INVALID',
      'REFRESH_TOKEN_EXPIRED',
      'REVOCATION_UNAVAILABLE',
      'CURRENT_PASSWORD_INVALID',
      'INVALID_PASSWORD',
      'PASSWORD_TOO_COMMON',
      'PASSWORD_REUSED',
      'USER_NOT_FOUND'
    ];
    codigos.forEach(codigo => {
      recordTokenRefresh(codigo);
      recordPasswordChange(codigo);
    });
    recordLoginAttempt('failure');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const porMetric = new Map(
      samples
        .filter(sample => sample.name.startsWith('auth_'))
        .map(sample => [sample.name, new Set(sample.values.map(v => v.labels.outcome))])
    );

    // Nenhum `error` pode ter vindo de um código que o domínio de fato emite.
    // `error` continua reservado para o que é realmente desconhecido.
    expect(porMetric.get('auth_token_refresh_total')).toEqual(
      new Set(['invalid', 'reused', 'unavailable', 'error'])
    );
    expect(porMetric.get('auth_password_changes_total')).toEqual(
      new Set(['current_password_invalid', 'rejected', 'error'])
    );
    expect(porMetric.get('auth_login_attempts_total')).toEqual(new Set(['success', 'failure']));
  });

  it('normaliza outcome desconhecido em error, sem criar label nova', async() => {
    recordPasswordChange('senha_com_aspas_e_linha_nova');

    const samples = await metricsImport.prometheus.register.getMetricsAsJSON();
    const changes = samples.find(sample => sample.name === 'auth_password_changes_total');
    const outcomes = (changes?.values ?? []).map(value => value.labels.outcome);

    expect(outcomes).toContain('error');
    // O rótulo inventado não pode ter virado dimensão: cardinalidade de label é
    // custo de memória no Prometheus.
    expect(outcomes.every(outcome => [
      'success', 'current_password_invalid', 'rejected', 'error'
    ].includes(outcome))).toBe(true);
  });
});
