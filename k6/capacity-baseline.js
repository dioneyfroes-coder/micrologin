// Baseline de capacidade (Fase 3.1) - Authentication Service
//
// Mede quanto um worker aguenta, por endpoint, com p50/p95/p99 e taxa de erro.
// A diferenca para `k6/load-test.js` (que e o teste de fumaca do deploy) e o
// que esta aqui responde:
//
//   - UM endpoint por corrida. Os quatro cenarios juntos somariam 4xN VUs e o
//     percentual de cada um passaria a depender dos outros tres; a tabela de
//     capacidade precisa de um numero por endpoint.
//   - 429 e 4xx NAO contam como falha. O rate limit e shape de trafego
//     deliberado: um 429 e a resposta correta do servico, nao defeito. O que
//     entra na taxa de falha e 5xx e erro de transporte (status 0); o 429 sai
//     em coluna propria, porque e assim que se descobre que a medicao mediu o
//     limiter em vez do endpoint.
//   - `/refresh` faz a rotacao de verdade. Um unico refresh token compartilhado
//     por N VUs mediria `REFRESH_TOKEN_REUSED` (401) ja na segunda rotacao, ou
//     seja, mediria o detector de reuso e nao o refresh.
//
// Uso (driver, caminho oficial):
//   scripts/capacity-baseline.sh
//
// Uso direto:
//   k6 run -e BASE_URL=http://localhost:3100 -e ENDPOINTS=login -e VUS=100 \
//          k6/capacity-baseline.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
const VUS = Number(__ENV.VUS || 100);
const DURATION = __ENV.DURATION || '60s';
const RAMP_UP = __ENV.RAMP_UP || '15s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '10s';
const SLEEP = Number(__ENV.SLEEP || 0);
const METRICS_TOKEN = __ENV.METRICS_TOKEN || '';

// `Date.now().toString(36)` = 8 caracteres, o que mantem o nome do usuario
// dentro do teto de 30 de USERNAME_MAX_LENGTH mesmo com o sufixo de iteracao.
const RUN_ID = __ENV.RUN_ID || Date.now().toString(36);

/**
 * Identificador de INVOCACAO do k6.
 *
 * Precisa existir separada do RUN_ID porque o driver roda uma invocacao por
 * (endpoint, VUs) com o mesmo RUN_ID. Sem isso o `/register` de 200 VUs
 * reusava os nomes criados pelo de 100 VUs, e metade das respostas era 400
 * "usuário já existe" - que, como `exists()` roda ANTES do `hash()` no
 * dominio, sai de graça. O efeito era pior do que sujeira na amostra:
 * inflava o rps do cadastro de 22/s para 44/s e escondia o gargalo real.
 */
const CASE_ID = __ENV.CASE_ID || Date.now().toString(36).slice(-5);
const USER_COUNT = Number(__ENV.USER_COUNT || VUS);
const REGISTER_ITERATIONS = Number(__ENV.REGISTER_ITERATIONS || 5);

// 17 bytes: passa de PASSWORD_MIN_LENGTH (12), fica longe de
// PASSWORD_MAX_LENGTH (72) e tem maiuscula, minuscula, digito e simbolo aceito
// (`#`) - as quatro composicoes exigidas por PASSWORD_POLICY.
const PASSWORD = __ENV.PASSWORD || 'K6#Bench2026Pass';

const ALL_ENDPOINTS = ['health', 'login', 'refresh', 'register'];
const ENDPOINTS = (__ENV.ENDPOINTS || ALL_ENDPOINTS.join(','))
  .split(',')
  .map((e) => e.trim())
  .filter((e) => ALL_ENDPOINTS.includes(e));

if (ENDPOINTS.length === 0) {
  throw new Error(`ENDPOINTS invalido: nenhum de ${ALL_ENDPOINTS.join(', ')}`);
}

/**
 * Pool de login.
 *
 * O driver registra esse pool uma vez por RUN_ID, antes da matriz, e o
 * `k6user_<RUN_ID>_<i>` aqui tem que ser o mesmo nome de la. Cada VU fica com
 * um usuario proprio, para que o rate limit por usuario (que existe por tras
 * do orcamento por IP) nao seja o gargalo: o que esta em medicao e o endpoint.
 *
 * Array simples, e nao `SharedArray`: sao no maximo 400 pares
 * usuario/senha, e o `SharedArray` economiza memoria justamente para volume
 * que nao existe aqui - trocaria uma dependencia de internals do k6 por um
 * ganho de kilobytes.
 */
const users = Object.freeze(
  Array.from({ length: USER_COUNT }, (_, i) => ({
    user: `k6user_${RUN_ID}_${i}`,
    password: PASSWORD
  }))
);

/**
 * Uma metrica por endpoint.
 *
 * `http_req_duration` com filtro de tag so aparece no summary se algum
 * threshold a referencia; metricas proprias deixam o relatorio independente de
 * threshold e nao somem quando o limiar e retirado.
 */
const metrics = {};
for (const name of ENDPOINTS) {
  metrics[name] = {
    duration: new Trend(`ml_${name}_latency_ms`, true),
    failure: new Rate(`ml_${name}_failure`),
    ok: new Counter(`ml_${name}_ok`),
    refused: new Counter(`ml_${name}_refused_429`),
    client4xx: new Counter(`ml_${name}_client_4xx`),
    warmup: new Counter(`ml_${name}_warmup`),
    warmupFailed: new Counter(`ml_${name}_warmup_failed`),
    transport: new Counter(`ml_${name}_transport_error`),
    server5xx: new Counter(`ml_${name}_server_5xx`),
    overloaded: new Counter(`ml_${name}_overloaded_503`)
  };
}

/**
 * Estado por VU. k6 da um runtime JS por VU, entao este objeto e local de cada
 * VU e nao precisa de coordenacao. Precisa existir antes de qualquer `exec`,
 * porque o modulo inteiro e avaliado antes da primeira iteracao.
 */
const refreshTokens = {};

/**
 * Parametros de request comuns.
 *
 * `responseCallback` e o que mantem `http_req_failed` util: sem ele o k6 trata
 * 4xx como falha (o default e 200-399) e o threshold de 1% reprovaria uma
 * corrida em que o servico respondeu 429 corretamente. Aqui o k6 so chama de
 * falha o que e falha de capacidade.
 */
const requestParams = function(endpoint, phase) {
  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: `/${endpoint}`, phase },
    responseCallback: http.expectedStatuses(200, 201, 400, 401, 409, 429)
  };
  if (METRICS_TOKEN) {
    params.headers['x-metrics-token'] = METRICS_TOKEN;
  }
  return params;
};

/**
 * Registra o desfecho de uma requisicao no par de metricas do endpoint.
 *
 * Falha de aplicacao e `status === 0` (transporte) ou `status >= 500`.
 */
const record = function(endpoint, status, durationMs, error) {
  const m = metrics[endpoint];
  m.duration.add(durationMs || 0);
  m.failure.add(status === 0 || status >= 500);
  if (status === 0) {
    // `status === 0` e erro de transporte (conexao recusada, reset, timeout do
    // cliente). Sem o texto do erro a taxa de falha e um numero sem causa, e a
    // pergunta que a Fase 3.1 faz - "qual e o gargalo" - fica sem resposta.
    m.transport.add(1, { error: error || 'desconhecido' });
  }
  // A ordem importa e o erro anterior custou uma medicao inteira: testando
  // `>= 400 && < 500` antes do 5xx, todo 500 caia no balde `ok` e a linha de
  // taxa de falha era a unica que denunciava. Cada faixa tem balde proprio.
  if (status === 0) {
    // ja contabilizado acima
  } else if (status === 429) {
    m.refused.add(1);
  } else if (status >= 500) {
    m.server5xx.add(1, { status });
    // 503 do disjuntor de concorrencia NAO e falha do endpoint: e o limite
    // recusando antes de o endpoint ver a requisicao. Sem esta separacao, um
    // teto bem escolhido apareceria na tabela como queda de taxa de erro, e a
    // leitura seria invertida -- o disjuntor estaria "piorando" a medicao.
    if (status === 503) {
      m.overloaded.add(1);
    }
  } else if (status >= 400) {
    m.client4xx.add(1, { status });
  } else {
    m.ok.add(1);
  }
};

const rampStages = function() {
  return [
    { duration: RAMP_UP, target: VUS },
    { duration: DURATION, target: VUS },
    { duration: RAMP_DOWN, target: 0 }
  ];
};

export const options = {
  scenarios: ENDPOINTS.reduce(function(acc, name) {
    if (name === 'register') {
      // `per-vu-iterations` com iteracoes fixas, e nao `constant-vus`:
      // /register escreve no Mongo e o nome do usuario precisa ser unico, entao
      // um loop livre teria crescimento ilimitado de documento. Com N VUs vezes
      // K iteracoes o total de cadastro e conhecido e o banco nao cresce sem
      // limite. A concorrencia observada continua sendo VUs - e rajada, nao
      // rampa, o que esta anotado na tabela de capacidade.
      acc[name] = {
        executor: 'per-vu-iterations',
        vus: VUS,
        iterations: REGISTER_ITERATIONS,
        maxDuration: DURATION,
        exec: name
      };
      return acc;
    }
    acc[name] = {
      executor: 'ramping-vus',
      startVUs: Math.min(VUS, 10),
      stages: rampStages(),
      exec: name
    };
    return acc;
  }, {}),
  thresholds: {
    // So falha de capacidade reprova a corrida. Latencia fica no relatorio: um
    // p95 alto com 0 falhas e exatamente a linha que o roadmap quer medir.
    http_req_failed: ['rate<0.01']
  }
};

/**
 * Cadastra o primeiro usuario do pool.
 *
 * `setup()` roda uma vez, fora de qualquer metrica de requisicao, entao o custo
 * do argon2 do cadastro nao entra na latencia medida. O driver faz o resto do
 * pool antes da matriz, em serie, para nao competir com a medicao.
 */
export function setup() {
  const res = http.post(
    `${BASE_URL}/register`,
    JSON.stringify({ user: users[0].user, password: PASSWORD }),
    requestParams('register', 'setup')
  );

  // 400 = ja existia de uma corrida anterior com o mesmo RUN_ID. Nao e falha.
  if (res.status !== 201 && res.status !== 400) {
    const body = typeof res.body === 'string' ? res.body : '';
    throw new Error(`seed falhou: /register respondeu ${res.status}: ${body.slice(0, 200)}`);
  }
  return { runId: RUN_ID, poolSize: users.length };
}

export function health() {
  const res = http.get(`${BASE_URL}/health`, requestParams('health', 'measure'));
  record('health', res.status, res.timings.duration, res.error);
  check(res, { 'health 2xx': (r) => r.status >= 200 && r.status < 300 });
  if (SLEEP > 0) {
    sleep(SLEEP);
  }
}

export function login() {
  const pick = users[__VU % users.length];
  const res = http.post(
    `${BASE_URL}/login`,
    JSON.stringify({ user: pick.user, password: pick.password }),
    requestParams('login', 'measure')
  );
  record('login', res.status, res.timings.duration, res.error);
  check(res, {
    'login 200 ou recusa valida': (r) => [200, 400, 401, 429].includes(r.status),
    'login sem 5xx': (r) => r.status < 500
  });
  if (SLEEP > 0) {
    sleep(SLEEP);
  }
}

/**
 * Refresh com rotacao real: cada VU autentica uma vez e vai trocando o proprio
 * token a cada iteracao, entao o servico exercita verificar + revogar + emitir.
 *
 * O login de aquecimento fica em contadores proprios, fora da trend de latencia:
 * se o `/login` foi recusado por rate limit, o motivo tem que aparecer como
 * "warmup falhou", e nao como um `/refresh` lento.
 */
export function refresh() {
  const m = metrics.refresh;
  const pick = users[__VU % users.length];
  let token = refreshTokens[__VU];

  if (!token) {
    const loginRes = http.post(
      `${BASE_URL}/login`,
      JSON.stringify({ user: pick.user, password: pick.password }),
      requestParams('login', 'refresh-warmup')
    );
    m.warmup.add(1);
    if (loginRes.status !== 200) {
      m.warmupFailed.add(1);
    }
    try {
      token = loginRes.json().data.refreshToken;
    } catch {
      token = null;
    }
    if (!token) {
      sleep(1);
      return;
    }
    refreshTokens[__VU] = token;
    return;
  }

  const res = http.post(
    `${BASE_URL}/refresh`,
    JSON.stringify({ refreshToken: token }),
    requestParams('refresh', 'measure')
  );
  record('refresh', res.status, res.timings.duration, res.error);
  check(res, {
    'refresh 200 ou recusa valida': (r) => [200, 400, 401, 429].includes(r.status),
    'refresh sem 5xx': (r) => r.status < 500
  });

  try {
    const next = res.json().data.refreshToken;
    if (next) {
      refreshTokens[__VU] = next;
    }
  } catch {
    // corpo sem JSON: o status ja foi registrado acima
  }

  if (SLEEP > 0) {
    sleep(SLEEP);
  }
}

export function register() {
  const res = http.post(
    `${BASE_URL}/register`,
    JSON.stringify({
      user: `k6reg_${RUN_ID}_${CASE_ID}_${__VU}_${__ITER}`,
      password: PASSWORD
    }),
    requestParams('register', 'measure')
  );
  record('register', res.status, res.timings.duration, res.error);
  check(res, {
    'register 201 ou recusa valida': (r) => [201, 400, 409, 429].includes(r.status),
    'register sem 5xx': (r) => r.status < 500
  });
}

/**
 * Le um percentile do objeto `values` de uma Trend no resumo.
 *
 * O k6 expoe so o que foi pedido em `summaryTrendStats`, e o default e
 * `p(90),p(95)` - sem `p(99)` o roadmap nao estaria atendido. Por isso o driver
 * passa `K6_SUMMARY_TREND_STATS="avg,min,med,max,p(90),p(95),p(99)"`. O
 * fallback mantem o script utilizavel em execucao direta, sem esconder a
 * ausencia: devolve `null`, e `null` na tabela e mais honesto que o maximo
 * apresentado como p99.
 *
 * `med` e o p50: e o nome que o k6 usa para a mediana.
 */
const percentile = function(values, key) {
  const v = values ? values[key] : undefined;
  return typeof v === 'number' ? Math.round(v * 100) / 100 : null;
};

/**
 * Relatorio por endpoint: p50/p95/p99, taxa de falha, recusas de rate limit e
 * requisicoes por segundo.
 */
export function handleSummary(data) {
  const durationSec = data.state.testRunDurationMs / 1000;
  const endpoints = {};

  for (const name of ENDPOINTS) {
    const dur = data.metrics[`ml_${name}_latency_ms`];
    const failure = data.metrics[`ml_${name}_failure`];
    const ok = data.metrics[`ml_${name}_ok`];
    const refused = data.metrics[`ml_${name}_refused_429`];
    const client4xx = data.metrics[`ml_${name}_client_4xx`];
    const warmup = data.metrics[`ml_${name}_warmup`];
    const warmupFailed = data.metrics[`ml_${name}_warmup_failed`];
    const transport = data.metrics[`ml_${name}_transport_error`];
    const server5xx = data.metrics[`ml_${name}_server_5xx`];
    const overloaded = data.metrics[`ml_${name}_overloaded_503`];

    const total = (ok ? ok.values.count : 0)
      + (refused ? refused.values.count : 0)
      + (client4xx ? client4xx.values.count : 0);

    const values = dur ? dur.values : null;

    endpoints[name] = {
      requests: total,
      rps: durationSec > 0 ? Math.round((total / durationSec) * 100) / 100 : 0,
      p50_ms: percentile(values, 'med'),
      p90_ms: percentile(values, 'p(90)'),
      p95_ms: percentile(values, 'p(95)'),
      p99_ms: percentile(values, 'p(99)'),
      max_ms: percentile(values, 'max'),
      samples: dur ? dur.values.count : 0,
      ok: ok ? ok.values.count : 0,
      refused_429: refused ? refused.values.count : 0,
      client_4xx: client4xx ? client4xx.values.count : 0,
      client_4xx_by_status: client4xx ? client4xx.values : {},
      failure_pct: failure ? Math.round(failure.values.rate * 10000) / 100 : 0,
      warmup: warmup ? warmup.values.count : 0,
      warmup_failed: warmupFailed ? warmupFailed.values.count : 0,
      transport_errors: transport ? transport.values.count : 0,
      transport_causes: transport ? transport.values : {},
      server_5xx: server5xx ? server5xx.values.count : 0,
      overloaded_503: overloaded ? overloaded.values.count : 0,
      server_5xx_by_status: server5xx ? server5xx.values : {}
    };
  }

  const summary = {
    run_id: RUN_ID,
    case_id: CASE_ID,
    base_url: BASE_URL,
    vus: VUS,
    endpoints_measured: ENDPOINTS,
    test_duration_s: Math.round(durationSec),
    ramp_up: RAMP_UP,
    ramp_down: RAMP_DOWN,
    register_iterations: REGISTER_ITERATIONS,
    endpoints
  };

  const lines = [];
  lines.push('');
  lines.push('endpoint     reqs     rps     p50     p95     p99     max    429    4xx  falha%');
  for (const name of ENDPOINTS) {
    const e = endpoints[name];
    lines.push(
      name.padEnd(11)
      + String(e.requests).padStart(6)
      + String(e.rps).padStart(8)
      + String(e.p50_ms).padStart(9)
      + String(e.p95_ms).padStart(8)
      + String(e.p99_ms).padStart(8)
      + String(e.max_ms).padStart(8)
      + String(e.refused_429).padStart(7)
      + String(e.client_4xx).padStart(7)
      + String(e.failure_pct).padStart(8)
    );
  }

  const out = { stdout: lines.join('\n') + '\n' };
  const target = __ENV.SUMMARY_JSON;
  if (target) {
    out[target] = JSON.stringify(summary, null, 2);
  }
  return out;
}
