import type { Server, ServerOptions } from 'http';

export interface HttpServerLimits {
  server: number;
  headers: number;
  request: number;
  keepAlive: number;
  connectionsCheckingInterval: number;
  maxRequestsPerSocket: number;
  maxHeadersCount: number;
}

export const httpServerOptions = (limits: HttpServerLimits): Pick<
ServerOptions,
'headersTimeout' | 'requestTimeout' | 'keepAliveTimeout' | 'connectionsCheckingInterval'
> => ({
  headersTimeout: limits.headers,
  requestTimeout: limits.request,
  keepAliveTimeout: limits.keepAlive,
  connectionsCheckingInterval: limits.connectionsCheckingInterval
});

export const configureHttpServerLimits = (server: Server, limits: HttpServerLimits): void => {
  server.timeout = limits.server;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.maxHeadersCount = limits.maxHeadersCount;
};
