/**
 * Spoofing de `X-Forwarded-For` — o que o cliente controla e o que não controla.
 *
 * A proteção por IP inteira depende de uma única decisão: de onde vem o
 * `req.ip` que vira chave de orçamento. Este arquivo não testa o `proxy-addr`
 * (biblioteca); testa a nossa parte — o valor que `parseTrustProxy` entrega e o
 * `app.set('trust proxy', ...)` que o consome.
 *
 * Os três cenários são a topologia real e as duas formas de errar:
 *
 *   1. `false` (padrão, app exposto direto): o cabeçalho é do cliente e é
 *      ignorado. Rotacionar `X-Forwarded-For` não abre orçamento novo.
 *   2. faixa de CIDR que **não** inclui o peer que conectou: o proxy declarado
 *      não está aqui, então a confiança não se aplica e o forjador continua
 *      preso ao IP do socket. É o que impede `TRUST_PROXY=true` "porque temos
 *      proxy" de virar bypass em qualquer outro deploy.
 *   3. `1` (produção, nginx na frente reescrevendo o cabeçalho): o cabeçalho
 *      passa a valer e cada origem tem orçamento próprio.
 *
 * Sem o cenário 1, uma configuração "confiável" demais não denuncia nada: ela
 * simplesmente dá mais aire. O bypass só aparece quando alguém compara os dois.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../../src/shared/utils/errorHandler.js';

const IP_POINTS = 2;
const ATTEMPTS = 3;
const originalEnv = { ...process.env };

let server: Server | null = null;
let baseUrl = '';
let advancedRateLimit: { reset: () => Promise<void> };
let rateLimitMiddleware: express.RequestHandler;

const startApp = async(trustProxy: boolean | number | string[]): Promise<void> => {
  await advancedRateLimit.reset();

  const app: Express = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use(rateLimitMiddleware);
  app.post('/register', (_req, res) => {
    res.status(201).json({ success: true });
  });
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const stopApp = async(): Promise<void> => {
  if (!server) {
    return;
  }

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = null;
};

/**
 * Requisições com um `X-Forwarded-For` diferente a cada tentativa.
 *
 * O caminho é `/register` de propósito: ele consome só o orçamento de IP, sem a
 * dimensão de conta que existe em `/login`. O que está em jogo aqui é
 * exclusivamente a chave de origem.
 */
const rotateForwardedIp = async(): Promise<number[]> => {
  const statuses: number[] = [];

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const response = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `203.0.113.${attempt + 1}`
      },
      body: JSON.stringify({ user: `spoof_${attempt}`, password: 'Qualquer1!' })
    });

    statuses.push(response.status);
  }

  return statuses;
};

describe('spoofing de X-Forwarded-For', () => {
  beforeAll(async() => {
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_PROD_IP_POINTS = String(IP_POINTS);
    process.env.RATE_LIMIT_PROD_USER_POINTS = '1000';
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = '1000';
    delete process.env.REDIS_URL;

    const limiterModule = await import('../../src/application/middleware/advancedRateLimit.js');
    advancedRateLimit = limiterModule.advancedRateLimit as unknown as { reset: () => Promise<void> };
    rateLimitMiddleware = limiterModule.advancedRateLimit.checkLimits;
  });

  afterAll(async() => {
    await stopApp();
    process.env = { ...originalEnv };
    // A reconexão do Redis é infinita por decisão de produção: sem o
    // encerramento explícito, o timer pendente segura o processo do jest e a
    // suíte passa os testes sem nunca terminar.
    const { disconnectRedis } = await import('../../src/infrastructure/cache/connection.js');
    await disconnectRedis();
  });

  it('ignora o cabeçalho quando nenhum proxy está declarado', async() => {
    await startApp(false);

    // As três requisições saem do mesmo socket (127.0.0.1), dividem o orçamento
    // e a terceira é barrada. Um cliente que rotacionasse o cabeçalho e
    // continuasse passando provaria que o forjador escolhe a chave.
    expect(await rotateForwardedIp()).toEqual([201, 201, 429]);

    await stopApp();
  });

  it('mantém o forjador preso quando o proxy declarado não está conectado', async() => {
    await startApp(['10.0.0.0/8', '192.168.1.10']);

    // O peer real (127.0.0.1) está fora das faixas declaradas: a confiança não
    // se aplica e o cabeçalho volta a ser do cliente. É a diferença entre
    // "confio no meu proxy" e "confio em qualquer coisa que diga que é proxy".
    expect(await rotateForwardedIp()).toEqual([201, 201, 429]);

    await stopApp();
  });

  it('usa o cabeçalho quando o proxy confiável está declarado', async() => {
    await startApp(1);

    // Topologia de produção: nginx na frente reescrevendo `X-Forwarded-For` com
    // o IP do peer real. Cada origem ganha orçamento próprio — é o que permite
    // barrar varredura de contas vindo de uma origem só.
    expect(await rotateForwardedIp()).toEqual([201, 201, 201]);

    await stopApp();
  });

  it('confiar em toda a cadeia (true) entrega o orçamento ao forjador', async() => {
    await startApp(true);

    // Mesmo efeito de `1` neste transporte, e é por isso que `true` é proibido:
    // ele não depende de haver um proxy que reescreva o cabeçalho. Se o nginx
    // sumir, o cliente volta a escolher a própria chave — e nada além de um
    // `logger.warn` denuncia a mudança de topologia.
    expect(await rotateForwardedIp()).toEqual([201, 201, 201]);

    await stopApp();
  });
});
