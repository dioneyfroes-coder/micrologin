/**
 * Cabeçalhos de segurança e CORS na camada HTTP.
 *
 * Os dois montam a fronteira do navegador: o helmet decide o que a página que
 * carregou a resposta consegue fazer com ela, e o CORS decide quem pode sequer
 * ler. Um dos dois em modo permissivo silencioso é o tipo de coisa que "funciona"
 * em curl e não aparece em nenhum teste - por isso a verificação aqui é sobre a
 * resposta real, não sobre a configuração interna.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import cors from 'cors';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import setupSecurity from '../../src/interfaces/config/helmet.js';

const ALLOWED_ORIGIN = 'https://app.exemplo.com';
const OTHER_ALLOWED_ORIGIN = 'https://admin.exemplo.com';
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

describe('headers de segurança e CORS', () => {
  let server: Server;
  let tlsServer: Server;
  let baseUrl: string;
  let tlsBaseUrl: string;
  let buildCorsOptions: () => { origin: unknown; credentials: boolean };

  const buildApp = (app: Express, corsOptions: unknown, tlsEnabled: boolean) => {
    setupSecurity(app, tlsEnabled);
    app.use(cors(corsOptions as never));
    app.get('/profile', (_req, res) => {
      res.json({ success: true });
    });
    app.post('/login', (_req, res) => {
      res.status(401).json({ success: false, code: 'AUTHENTICATION_FAILED' });
    });
    return app;
  };

  const listen = async(app: Express) => {
    const listening = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      listening.once('listening', resolve);
      listening.once('error', reject);
    });
    return listening;
  };

  beforeAll(async() => {
    process.env.ALLOWED_ORIGINS = `${ALLOWED_ORIGIN},${OTHER_ALLOWED_ORIGIN}`;

    // Import dinâmico: appConfig lê ALLOWED_ORIGINS na carga do módulo, e um
    // import estático no topo do arquivo já a teria carregado com o valor
    // antigo - o teste passaria por accidento testando a config DEFAULT.
    const corsModule = await import('../../src/interfaces/config/cors.js');
    buildCorsOptions = corsModule.buildCorsOptions as typeof buildCorsOptions;

    server = await listen(buildApp(express(), buildCorsOptions(), false));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Segunda instância idêntica, exceto pelo TLS ligado: é a única variável
    // que decide a presença do HSTS.
    tlsServer = await listen(buildApp(express(), buildCorsOptions(), true));
    tlsBaseUrl = `http://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
  });

  afterAll(async() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
    for (const instance of [server, tlsServer]) {
      instance.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        instance.close(error => error ? reject(error) : resolve());
      });
    }
  });

  describe('buildCorsOptions', () => {
    it('lê as origens de ALLOWED_ORIGINS, sem origem hardcoded', () => {
      const options = buildCorsOptions() as { origin: string[]; credentials: boolean };

      expect(options.origin).toEqual([ALLOWED_ORIGIN, OTHER_ALLOWED_ORIGIN]);
      // `credentials: true` com origem variável é seguro; com '*' seria recusado
      // pelo navegador. A configuração precisa continuar assim.
      expect(options.credentials).toBe(true);
    });
  });

  describe('headers de segurança', () => {
    it('nose, anti-framing e anti-referência estão presentes na resposta', async() => {
      const response = await fetch(`${baseUrl}/profile`);

      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });

    it('reforça os mesmos headers em respostas de erro', async() => {
      const response = await fetch(`${baseUrl}/login`, { method: 'POST' });

      expect(response.status).toBe(401);
      // Um header que some no erro é um header que não protege o erro.
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    });

    it('CSP restringe a origem a self e proíbe plugin/object', async() => {
      const response = await fetch(`${baseUrl}/profile`);
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(csp).toContain('default-src \'self\'');
      expect(csp).toContain('object-src \'none\'');
      expect(csp).toContain('frame-src \'none\'');
    });

    it('HSTS fica de fora quando não há TLS no fim do processo', async() => {
      const response = await fetch(`${baseUrl}/profile`);

      // O header declara "daqui em diante, só HTTPS" e o navegador o ignora
      // quando chega por HTTP. Emitir aqui seria promessa falsa.
      expect(response.headers.get('strict-transport-security')).toBeNull();
    });

    it('HSTS é emitido quando o serviço serve TLS', async() => {
      const response = await fetch(`${tlsBaseUrl}/profile`);
      const hsts = response.headers.get('strict-transport-security') ?? '';

      expect(hsts).toContain('max-age=31536000');
      expect(hsts).toContain('includeSubDomains');
      // Os demais headers não dependem de TLS e continuam presentes.
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  describe('CORS', () => {
    it('devolve a origem permitida e habilita credenciais', async() => {
      const response = await fetch(`${baseUrl}/profile`, {
        headers: { Origin: ALLOWED_ORIGIN }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('aceita a segunda origem configurada', async() => {
      const response = await fetch(`${baseUrl}/profile`, {
        headers: { Origin: OTHER_ALLOWED_ORIGIN }
      });

      expect(response.headers.get('access-control-allow-origin')).toBe(OTHER_ALLOWED_ORIGIN);
    });

    it('origem não listada não recebe permissão de leitura', async() => {
      const response = await fetch(`${baseUrl}/profile`, {
        headers: { Origin: 'https://atacante.example' }
      });

      // A requisição é servida (CORS não é autenticação), mas o navegador
      // não recebe permissão para ler a resposta.
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('nunca reflete de volta a origem do cliente (reflexo livre)', async() => {
      const evil = 'https://atacante.example';
      const response = await fetch(`${baseUrl}/profile`, { headers: { Origin: evil } });

      expect(response.headers.get('access-control-allow-origin')).not.toBe(evil);
    });

    it('preflight anuncia os métodos e headers que a API realmente usa', async() => {
      const response = await fetch(`${baseUrl}/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization'
        }
      });

      expect(response.status).toBe(200);
      const allowedMethods = response.headers.get('access-control-allow-methods') ?? '';
      expect(allowedMethods).toContain('POST');
      expect(allowedMethods).toContain('PUT');
      expect(allowedMethods).toContain('DELETE');

      const allowedHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      expect(allowedHeaders).toContain('authorization');
      expect(allowedHeaders).toContain('x-security-token');
    });

    it('requisição sem Origin não recebe header de CORS', async() => {
      const response = await fetch(`${baseUrl}/profile`);

      // Chamadas server-to-server não negocia origem; emitir header aqui só
      // adicionaria ruído.
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
