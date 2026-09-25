import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import securityRoutes from '../../src/application/routes/securityRoutes.js';
import { errorHandler } from '../../src/shared/utils/errorHandler.js';

const securityToken = 'security-token-for-route-test';
const originalToken = process.env.SECURITY_DASHBOARD_TOKEN;

describe('rotas /security', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async() => {
    process.env.SECURITY_DASHBOARD_TOKEN = securityToken;

    const app = express();
    app.use(express.json());
    app.use('/security', securityRoutes);
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
      delete process.env.SECURITY_DASHBOARD_TOKEN;
    } else {
      process.env.SECURITY_DASHBOARD_TOKEN = originalToken;
    }

    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it.each([
    '/security/stats',
    '/security/report',
    '/security/events',
    '/security/threats',
    '/security/health'
  ])('exige token administrativo em %s', async(path) => {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.json() as { code?: string };

    expect(response.status).toBe(401);
    expect(body.code).toBe('SECURITY_FORBIDDEN');
  });

  it('libera o acesso com o token correto', async() => {
    const response = await fetch(`${baseUrl}/security/stats`, {
      headers: { 'X-Security-Token': securityToken }
    });

    expect(response.status).toBe(200);
  });
});
