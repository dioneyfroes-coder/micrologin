import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://localhost').replace(/\/$/, '');
const DURATION = __ENV.DURATION || '20s';
const VUS = Number(__ENV.VUS || 10);
const LOGIN_USER = __ENV.LOGIN_USER;
const LOGIN_PASS = __ENV.LOGIN_PASS;

const rateLimited = new Counter('ddos_rate_limited');
const livenessFailures = new Counter('ddos_liveness_failures');
const serverErrors = new Counter('ddos_server_errors');

export const options = {
  insecureSkipTLSVerify: __ENV.INSECURE_TLS === 'true',
  scenarios: {
    login_flood: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'loginFlood'
    },
    refresh_flood: {
      executor: 'constant-vus',
      vus: Math.max(1, Math.floor(VUS / 2)),
      duration: DURATION,
      exec: 'refreshFlood'
    },
    register_flood: {
      executor: 'constant-vus',
      vus: Math.max(1, Math.floor(VUS / 2)),
      duration: DURATION,
      exec: 'registerFlood'
    },
    forwarded_ip_flood: {
      executor: 'constant-vus',
      vus: Math.max(1, Math.floor(VUS / 2)),
      duration: DURATION,
      exec: 'forwardedIpFlood'
    },
    liveness_probe: {
      executor: 'constant-vus',
      vus: 2,
      duration: DURATION,
      exec: 'probeLiveness'
    }
  },
  thresholds: {
    'http_req_duration': [`p(95)<${Number(__ENV.MAX_P95_MS || 5000)}`],
    'http_req_duration{scenario:login_flood}': [`p(95)<${Number(__ENV.MAX_P95_MS || 5000)}`],
    'http_req_duration{scenario:refresh_flood}': [`p(95)<${Number(__ENV.MAX_P95_MS || 5000)}`],
    'http_req_duration{scenario:register_flood}': [`p(95)<${Number(__ENV.MAX_P95_MS || 5000)}`],
    'http_req_duration{scenario:forwarded_ip_flood}': [`p(95)<${Number(__ENV.MAX_P95_MS || 5000)}`],
    ddos_rate_limited: ['count>0'],
    ddos_liveness_failures: ['count==0'],
    ddos_server_errors: ['count<5']
  }
};

const recordStatus = (response) => {
  if (response.status === 429) {
    rateLimited.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
    // O summary-export diz QUANTOS 5xx houve, nunca o que eles eram. Sem isto,
    // um 503 deliberado (fail-closed sem Redis) e um 500 de bug contam igual no
    // relatório, e a diferença entre "o limitezagou" e "o serviço quebrou"
    // fica impossível saber, depois do fim do flood. Amostra, não despejo: o log
    // inteiro de um flood seria grande demais para ser útil.
    if (fivexxLogged < 5) {
      fivexxLogged += 1;
      console.log(`[5xx] ${response.status} ${response.request?.method} ${response.url} :: ${String(response.body).slice(0, 300)}`);
    }
  }
};

let fivexxLogged = 0;

const login = (password = LOGIN_PASS, headers = {}) => {
  const response = http.post(`${BASE_URL}/login`, JSON.stringify({
    user: LOGIN_USER,
    password
  }), {
    headers: { 'Content-Type': 'application/json', ...headers },
    tags: { name: '/login' }
  });
  recordStatus(response);
  return response;
};

export function loginFlood() {
  const response = login();
  check(response, { 'login path responds without 5xx': result => result.status < 500 });
  sleep(0.1);
}

export function refreshFlood() {
  const loginResponse = login();
  if (loginResponse.status === 200) {
    let refreshToken;
    try {
      refreshToken = JSON.parse(loginResponse.body).data?.refreshToken;
    } catch {
      refreshToken = undefined;
    }

    if (refreshToken) {
      const response = http.post(`${BASE_URL}/refresh`, JSON.stringify({ refreshToken }), {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: '/refresh' }
      });
      recordStatus(response);
      check(response, { 'refresh path responds without 5xx': result => result.status < 500 });
    }
  }
  sleep(0.1);
}

export function registerFlood() {
  const username = `ddos_${__VU}_${__ITER}_${Date.now()}`;
  const response = http.post(`${BASE_URL}/register`, JSON.stringify({
    user: username,
    password: `DdosSurvival_${__VU}_${__ITER}!Aa9`
  }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: '/register' }
  });
  recordStatus(response);
  check(response, { 'register path responds without 5xx': result => result.status < 500 });
  sleep(0.2);
}

export function forwardedIpFlood() {
  const varyingIp = `198.51.100.${(__VU + __ITER) % 254 + 1}`;
  const response = login('WrongDdosPassword123!Aa', { 'X-Forwarded-For': varyingIp });
  check(response, { 'forwarded IP path responds without 5xx': result => result.status < 500 });
  sleep(0.1);
}

export function probeLiveness() {
  const response = http.get(`${BASE_URL}/liveness`, { tags: { name: '/liveness' } });
  if (response.status !== 200) {
    livenessFailures.add(1);
  }
  check(response, { 'liveness stays 200 during flood': result => result.status === 200 });
  sleep(0.25);
}
