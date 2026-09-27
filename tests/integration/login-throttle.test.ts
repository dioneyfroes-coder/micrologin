/**
 * Limite de tentativas de login pela camada HTTP.
 *
 * O que está em jogo aqui é o ataque de força bruta direcionado a UMA conta a
 * partir de várias origens. O limite por IP não o segura: cada origem ganha
 * orçamento próprio. Por isso o `/login` também consome o orçamento por conta,
 * com a chave na forma canônica do username.
 *
 * O app de teste monta o middleware real (`advancedRateLimit.checkLimits`) com
 * `trust proxy` ligado, que é o cenário de produção atrás de um balanceador.
 * O armazenamento é o fallback em memória do próprio rate-limiter-flexible: o
 * que está sob teste é a decisão de chave e a resposta HTTP, não o Redis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../../src/shared/utils/errorHandler.js';

const LOGIN_POINTS = 3;
const originalEnv = { ...process.env };

let server: Server;
let baseUrl: string;
let advancedRateLimit: { reset: () => Promise<void> };

const loginAs = async(username: string, ip: string) => {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ user: username, password: 'Errada123!' })
  });
  const body = await response.json() as { code?: string };
  return { status: response.status, code: body.code, retryAfter: response.headers.get('retry-after') };
};

describe('limite de login por conta (brute force distribuído)', () => {
  beforeAll(async() => {
    process.env.NODE_ENV = 'test';
    // Orçamento pequeno só para este arquivo: o que se quer observar é a
    // contagem, e 3 tentativas tornam o teste rápido e legível.
    process.env.RATE_LIMIT_PROD_LOGIN_POINTS = String(LOGIN_POINTS);
    process.env.RATE_LIMIT_PROD_IP_POINTS = '1000';
    process.env.RATE_LIMIT_PROD_USER_POINTS = '1000';
    delete process.env.REDIS_URL;

    // Import dinâmico (sem resetModules): o limitador lê a configuração na
    // construção do singleton, e o registro de módulo do Jest é isolado por
    // arquivo - resetar criaria uma segunda cópia da classe HttpError e o
    // errorHandler não reconheceria o erro por `instanceof`.
    const limiterModule = await import('../../src/application/middleware/advancedRateLimit.js');
    advancedRateLimit = limiterModule.advancedRateLimit as unknown as { reset: () => Promise<void> };
    await advancedRateLimit.reset();

    const app = express();
    // Atrás de um balanceador, `req.ip` vem do X-Forwarded-For. Sem trust proxy
    // a proteção por IP não teria o que testar.
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(limiterModule.advancedRateLimit.checkLimits);
    app.post('/login', (_req, res) => {
      res.status(401).json({ success: false, code: 'AUTHENTICATION_FAILED' });
    });
    app.use(errorHandler);

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async() => {
    await advancedRateLimit.reset();
  });

  afterAll(async() => {
    process.env = { ...originalEnv };
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('barra a conta mesmo com uma origem nova a cada tentativa', async() => {
    const attempts = [];
    for (let i = 0; i <= LOGIN_POINTS; i += 1) {
      attempts.push(await loginAs('alice', `10.0.0.${i + 1}`));
    }

    // As LOGIN_POINTS primeiras passam: cada IP tinha orçamento próprio.
    expect(attempts.slice(0, LOGIN_POINTS).map(a => a.status)).toEqual(Array(LOGIN_POINTS).fill(401));

    // A seguinte é barrada pela CONTA, mesmo vindo de IP que nunca falhou.
    const blocked = attempts[LOGIN_POINTS];
    expect(blocked.status).toBe(429);
    expect(blocked.code).toBe('RATE_LIMIT_EXCEEDED');
    // O cliente precisa saber quando pode tentar de novo.
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
  });

  it('ajustar a caixa do username não renova o orçamento', async() => {
    for (let i = 0; i < LOGIN_POINTS; i += 1) {
      await loginAs('alice', `10.1.0.${i + 1}`);
    }

    const blocked = await loginAs('  ALICE  ', '10.1.0.99');

    expect(blocked.status).toBe(429);
    expect(blocked.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('contas diferentes não compartilham orçamento', async() => {
    for (let i = 0; i < LOGIN_POINTS; i += 1) {
      await loginAs('alice', `10.2.0.${i + 1}`);
    }

    // A conta alice está esgotada; outras contas, a partir de origens que
    // também não falharam, continuam com orçamento intacto.
    expect((await loginAs('bob', '10.2.0.10')).status).toBe(401);
    expect((await loginAs('carol', '10.2.0.11')).status).toBe(401);
    expect((await loginAs('alice', '10.2.0.12')).status).toBe(429);
  });

  it('sem username no corpo, o orçamento é o da origem (não vira contorno)', async() => {
    const attempts = [];
    for (let i = 0; i <= LOGIN_POINTS; i += 1) {
      const response = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.3.0.1' },
        body: JSON.stringify({})
      });
      attempts.push(response.status);
    }

    expect(attempts[LOGIN_POINTS]).toBe(429);
  });
});
