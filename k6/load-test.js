// Teste de carga (k6) - Authentication Service
//
// Pré-requisito: instalar o k6  ->  https://grafana.com/docs/k6/latest/set-up/install-k6/
//
// Uso:
//   k6 run k6/load-test.js
//   k6 run -e BASE_URL=https://auth.example.com k6/load-test.js
//   k6 run -e BASE_URL=http://localhost:3000 -e VUS=50 -e DURATION=30s k6/load-test.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const LOAD_VUS = Number(__ENV.VUS || 20);
const LOAD_DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    // Checagem de liveness (sem custo de I/O)
    health: {
      executor: 'constant-vus',
      vus: 5,
      duration: '1m',
      exec: 'healthcheck'
    },
    // Fluxo principal: login -> JWT
    login: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: LOAD_VUS },
        { duration: LOAD_DURATION, target: LOAD_VUS },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '10s',
      exec: 'loginFlow'
    },
    // Escritas em MongoDB
    register: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '45s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'registerFlow'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    'http_req_duration{name:/health}': ['p(95)<100'],
    'http_req_duration{name:/login}': ['p(99)<800']
  }
};

export function healthcheck() {
  const res = http.get(`${BASE_URL}/health`, { tags: { name: '/health' } });
  check(res, {
    'health retorna 200': r => r.status === 200
  });
  sleep(1);
}

export function loginFlow() {
  // Credenciais esperadas pelo cenário: usuários já registrados no ambiente alvo.
  const res = http.post(`${BASE_URL}/login`, {
    user: __ENV.LOGIN_USER || 'k6user',
    password: __ENV.LOGIN_PASS || 'K6Pass!1secure'
  }, { tags: { name: '/login' } });

  check(res, {
    'login 200': r => r.status === 200,
    'login retorna accessToken': r => {
      try {
        return JSON.parse(r.body).data?.accessToken !== undefined;
      } catch {
        return false;
      }
    }
  });
  sleep(1);
}

export function registerFlow() {
  // Usuário único por iteração evita colisão de duplicata (400) no banco
  const unique = `k6user_${Date.now()}_${__VU}_${__ITER}`;
  const res = http.post(`${BASE_URL}/register`, {
    user: unique,
    password: 'K6Pass!1secure'
  }, { tags: { name: '/register' } });

  check(res, { 'register 201': r => r.status === 201 });
  sleep(0.2);
}