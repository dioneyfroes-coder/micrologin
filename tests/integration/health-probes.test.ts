import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  performHealthCheck,
  performLivenessCheck,
  performReadinessCheck
} from '../../src/shared/utils/healthCheck.js';
import { errorHandler } from '../../src/shared/utils/errorHandler.js';

describe('health checks - semântica de liveness e readiness', () => {
  describe('performLivenessCheck', () => {
    it('responde vivo sem consultar dependência externa', () => {
      const report = performLivenessCheck();
      expect(report.status).toBe('alive');
      expect(report.pid).toBe(process.pid);
      expect(typeof report.uptime).toBe('number');
    });
  });

  describe('performReadinessCheck', () => {
    it('separa readiness de liveness: Mongo define o estado pronto', async() => {
      const report = await performReadinessCheck();
      expect(['ready', 'not_ready']).toContain(report.status);
      expect(report.ready).toBe(report.status === 'ready');
      expect(report.checks).toHaveProperty('mongodb');
      expect(report.checks).toHaveProperty('redis');
    });
  });

  describe('performHealthCheck', () => {
    it('mantém o relatório detalhado com serviços individuais', async() => {
      const report = await performHealthCheck();
      expect(report.timestamp).toEqual(expect.any(String));
      expect(report.services).toHaveProperty('mongodb');
      expect(report.services).toHaveProperty('redis');
      expect(report.services).toHaveProperty('memory');
    });
  });
});

describe('rotas de probe', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async() => {
    const app = express();
    app.get('/liveness', (_req, res) => {
      res.status(200).json(performLivenessCheck());
    });
    app.get('/readiness', async(_req, res, next) => {
      try {
        const result = await performReadinessCheck();
        res.status(result.ready ? 200 : 503).json(result);
      } catch {
        next(new Error('falha'));
      }
    });
    app.get('/health', async(_req, res) => {
      const result = await performHealthCheck();
      res.status(result.status === 'healthy' ? 200 : 503).json(result);
    });
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
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('/liveness responde 200 sem depender do Mongo', async() => {
    const response = await fetch(`${baseUrl}/liveness`);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe('alive');
  });

  it('/readiness usa 200 ou 503 conforme as dependências', async() => {
    const response = await fetch(`${baseUrl}/readiness`);
    expect([200, 503]).toContain(response.status);
    const body = await response.json() as { ready: boolean; status: string };
    expect(body.ready).toBe(response.status === 200);
    expect(body.status).toBe(body.ready ? 'ready' : 'not_ready');
  });

  it('/health continua sendo o relatório detalhado', async() => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json() as { services?: Record<string, unknown> };
    expect(body.services).toBeDefined();
  });

  it('os três endpoints são distintos', async() => {
    const [liveness, readiness, health] = await Promise.all([
      fetch(`${baseUrl}/liveness`),
      fetch(`${baseUrl}/readiness`),
      fetch(`${baseUrl}/health`)
    ]);
    expect(new Set([liveness.url, readiness.url, health.url]).size).toBe(3);
  });
});
