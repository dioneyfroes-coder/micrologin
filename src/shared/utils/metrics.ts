/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F29
 */
import prometheus from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

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
 * `outcome` é o eixo: `success` e `failure` são grandezas distintas, e não um
 * contador único ambíguo do tipo "logins" que misture sucesso e falha. Um alert
 * sobre "muitos logins" sem separar os dois lados não sabe dizer se é ataque ou
 * base de usuários.
 */
const authLoginAttempts = new prometheus.Counter({
  name: 'auth_login_attempts_total',
  help: 'Login attempts by outcome (success, failure)',
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Renovações de token por resultado. `reused` existe separado de `failure`
 * porque reuso de refresh token é sinal de comprometimento, não erro de usuário.
 */
const authTokenRefreshes = new prometheus.Counter({
  name: 'auth_token_refresh_total',
  help: 'Token refresh attempts by outcome (success, invalid, reused, unavailable)',
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Trocas de senha por resultado.
 */
const authPasswordChanges = new prometheus.Counter({
  name: 'auth_password_changes_total',
  help: 'Password change attempts by outcome (success, current_password_invalid, rejected, error)',
  labelNames: ['outcome'],
  registers: [prometheus.register]
});

/**
 * Registro de autenticação por resultado. Nomes fechados: qualquer valor fora
 * da lista vira `error`, para não criar cardinalidade infinita de labels.
 */
export type AuthOutcome =
  | 'success'
  | 'failure'
  | 'invalid'
  | 'reused'
  | 'unavailable'
  | 'rejected'
  | 'error';

const AUTH_OUTCOMES: ReadonlySet<string> = new Set<AuthOutcome>([
  'success',
  'failure',
  'invalid',
  'reused',
  'unavailable',
  'rejected',
  'error'
]);

const knownOutcome = (outcome: string): AuthOutcome =>
  AUTH_OUTCOMES.has(outcome) ? (outcome as AuthOutcome) : 'error';

export const recordLoginAttempt = (outcome: string): void => {
  authLoginAttempts.labels(knownOutcome(outcome)).inc();
};

export const recordTokenRefresh = (outcome: string): void => {
  authTokenRefreshes.labels(knownOutcome(outcome)).inc();
};

export const recordPasswordChange = (outcome: string): void => {
  authPasswordChanges.labels(knownOutcome(outcome)).inc();
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
