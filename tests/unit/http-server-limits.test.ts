import { describe, expect, it } from '@jest/globals';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { connect, Socket } from 'net';
import { serverConfig } from '../../src/interfaces/config/appConfig.js';
import { configureHttpServerLimits, httpServerOptions } from '../../src/shared/utils/httpServerLimits.js';

describe('HTTP server limits', () => {
  it('aplica os limites centralizados ao servidor Node', () => {
    const server = createServer(httpServerOptions(serverConfig.timeout));

    configureHttpServerLimits(server, serverConfig.timeout);

    expect(server.timeout).toBe(serverConfig.timeout.server);
    expect(server.headersTimeout).toBe(serverConfig.timeout.headers);
    expect(server.requestTimeout).toBe(serverConfig.timeout.request);
    expect(server.keepAliveTimeout).toBe(serverConfig.timeout.keepAlive);
    expect(server.connectionsCheckingInterval).toBe(serverConfig.timeout.connectionsCheckingInterval);
    expect(server.maxRequestsPerSocket).toBe(serverConfig.timeout.maxRequestsPerSocket);
    expect(server.maxHeadersCount).toBe(serverConfig.timeout.maxHeadersCount);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
    expect(serverConfig.timeout.listenBacklog).toBeGreaterThan(0);
  });

  it('fecha conexoes que deixam os headers incompletos', async() => {
    const limits = {
      ...serverConfig.timeout,
      server: 1000,
      headers: 100,
      request: 1000,
      connectionsCheckingInterval: 25
    };
    const server = createServer(httpServerOptions(limits), (_request, response) => response.end('ok'));
    configureHttpServerLimits(server, limits);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const address = server.address() as AddressInfo;
    let socket: Socket | null = null;
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket = connect(address.port, '127.0.0.1', () => {
          socket?.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
        });
        const timeout = setTimeout(() => {
          socket?.destroy();
          reject(new Error('header timeout nao fechou a conexao'));
        }, 2000);
        socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
        socket.on('end', () => {
          clearTimeout(timeout);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        socket.on('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      expect(response).toMatch(/^HTTP\/1\.1 408/);
    } finally {
      socket?.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
