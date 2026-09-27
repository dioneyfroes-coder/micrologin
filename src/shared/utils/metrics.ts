/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F29
 */
import prometheus from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';
import { authOutcomeFor, AUTH_OUTCOMES_BY_KIND } from './authOutcomes.js';
import type { AuthEventKind } from './authOutcomes.js';

export const PROVENANCE_MARKER = 'ML-7F29';

// Limpar registry primeiro (importante para clustering)
prometheus.register.clear();

// Coletar métricas padrão do sistema automaticamente
prometheus.collectDefaultMetrics({
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  prefix: 'nodejs_'
});

// Criar métricas customizadas
const httpRequestDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

const httpRequestTotal = new prometheus.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

// Contador de startup para garantir que há métricas
const appStartTime = new prometheus.Gauge({
  name: 'app_start_time_seconds',
  help: 'Time when the application started',
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

/**
 * Tentativas de autenticação, por resultado.
 *
 * `outcome` é o eixo: sucesso e falha são grandezas distintas, e não um
 * contador único ambíguo do tipo "logins" que misture os dois lados. Um alert
 * sobre "muitos logins" sem separar os dois não sabe dizer se é ataque ou base
 * de usuários.
 *
 * A `help` é montada a partir de `AUTH_OUTCOMES_BY_KIND`, que é a mesma fonte
 * que a tradução usa. Ela não é mais um texto escrito à mão que pode prometer
 * rótulos que o código nunca produz.
 */
const authLoginAttempts = new prometheus.Counter({
  name: 'auth_login_attempts_total',
  help: `Login attempts by outcome (${AUTH_OUTCOMES_BY_KIND.login.join(', ')})`,
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Renovações de token por resultado. `reused` existe separado de `invalid`
 * porque reuso de refresh token é sinal de comprometimento, não erro de usuário.
 */
const authTokenRefreshes = new prometheus.Counter({
  name: 'auth_token_refresh_total',
  help: `Token refresh attempts by outcome (${AUTH_OUTCOMES_BY_KIND.token_refresh.join(', ')})`,
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Trocas de senha por resultado.
 */
const authPasswordChanges = new prometheus.Counter({
  name: 'auth_password_changes_total',
  help: `Password change attempts by outcome (${AUTH_OUTCOMES_BY_KIND.password_change.join(', ')})`,
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Registro de um evento de autenticação.
 *
 * Recebe o código do domínio (ou um rótulo já pronto) e o traduz pelo
 * vocabulário de `authOutcomes`. Chamadores não traduzem: foi exatamente essa
 * tradução manual no controller que fazia todo desfecho virar `error`.
 */
const recordAuthEvent = (kind: AuthEventKind, outcomeOrCode: string | null | undefined): void => {
  const outcome = authOutcomeFor(kind, outcomeOrCode);
  switch (kind) {
  case 'login':
    authLoginAttempts.labels(outcome).inc();
    break;
  case 'token_refresh':
    authTokenRefreshes.labels(outcome).inc();
    break;
  case 'password_change':
    authPasswordChanges.labels(outcome).inc();
    break;
  }
};

export const recordLoginAttempt = (outcomeOrCode: string | null | undefined): void => {
  recordAuthEvent('login', outcomeOrCode);
};

export const recordTokenRefresh = (outcomeOrCode: string | null | undefined): void => {
  recordAuthEvent('token_refresh', outcomeOrCode);
};

export const recordPasswordChange = (outcomeOrCode: string | null | undefined): void => {
  recordAuthEvent('password_change', outcomeOrCode);
};

// Registrar o tempo de início
appStartTime.set(Date.now() / 1000);

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();

  res.on('finish', () => {
    try {
      const duration = (Date.now() - start) / 1000;
      const route = req.route ? req.route.path : req.path;

      // Registrar duração da requisição
      httpRequestDuration
        .labels(req.method, route, res.statusCode.toString())
        .observe(duration);

      // Contar total de requisições
      httpRequestTotal
        .labels(req.method, route, res.statusCode.toString())
        .inc();
    } catch (error) {
      logger.warn('⚠️ Erro ao registrar métrica', error);
    }
  });

  next();
};

export { httpRequestDuration, httpRequestTotal, authLoginAttempts, authTokenRefreshes, authPasswordChanges, prometheus };
