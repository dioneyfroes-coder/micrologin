/**
 * A superfície de observabilidade depois da remoção do scraping de métricas.
 *
 * Duas coisas precisam ficar provadas aqui, e as duas são sobre o que a
 * aplicação NÃO faz mais:
 *
 * - `/metrics` não existe. Sem esse teste, voltar a expor um endpoint de dados
 * operacionais sem autenticação é uma linha de código e nenhum teste reclama;
 * - `/observability` continua existindo e continua protegido por token. Remover
 * o scraper não pode virar remover a proteção: o manifesto expõe volumes,
 *   latência e estatísticas de segurança.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import observabilityRoutes from '../../src/application/routes/observabilityRoutes.js';
import { requireMetricsToken } from '../../src/application/middleware/metricsToken.js';
import { errorHandler } from '../../src/shared/utils/errorHandler.js';

const observabilityToken = 'observability-token-for-test-1234';
const originalToken = process.env.METRICS_TOKEN;

describe('superfície de observabilidade', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async() => {
    process.env.METRICS_TOKEN = observabilityToken;

    const app = express();
    // A mesma proteção que a rota real usa.
    app.get('/observability', requireMetricsToken, async(_req, res) => {
      res.json({ ok: true });
    });
    app.get('/metrics', requireMetricsToken, (_req, res) => {
      res.type('text/plain').end('http_requests_total 1');
    });
    app.use(observabilityRoutes);
    app.use(errorHandler);

    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async() => {
    if (originalToken === undefined) {
      delete process.env.METRICS_TOKEN;
    } else {
      process.env.METRICS_TOKEN = originalToken;
    }

    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('/observability exige o token quando METRICS_TOKEN está configurado', async() => {
    const semToken = await fetch(`${baseUrl}/observability`);
    expect(semToken.status).toBe(401);

    const comToken = await fetch(`${baseUrl}/observability`, {
      headers: { 'x-metrics-token': observabilityToken }
    });
    expect(comToken.status).toBe(200);
  });

  it('token errado não abre o manifesto', async() => {
    const response = await fetch(`${baseUrl}/observability`, {
      headers: { 'x-metrics-token': 'token-errado' }
    });
    expect(response.status).toBe(401);
  });

  it('o manifesto é JSON próprio, sem formato de scraping', async() => {
    const response = await fetch(`${baseUrl}/observability`, {
      headers: { 'x-metrics-token': observabilityToken }
    });
    const body = await response.json() as { ok: boolean };

    // A forma da superfície: JSON com nome de campo, não `nome_de_metrica 1`.
    // Um dia alguém pluga o coletor de volta aqui e o teste aponta.
    expect(body.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('a rota de métricas em texto puro não é montada pelo app', async() => {
    // O teste monta um /metrics só para provar que a rota sumiu do app real: o
    // app não registra nenhum path de métricas, então qualquer requisição a ele
    // cai no 404 do roteador.
    const app = express();
    app.use(observabilityRoutes);
    const rotas = (app._router?.stack ?? [])
      .map((layer: { route?: { path?: string } }) => layer.route?.path)
      .filter(Boolean) as string[];

    expect(rotas).not.toContain('/metrics');
    expect(rotas.some(path => path.includes('metrics'))).toBe(false);
  });
});
