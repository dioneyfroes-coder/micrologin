import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compose = load(readFileSync(resolve(ROOT, 'docker-compose.prod.yml'), 'utf8')) as {
  services: Record<string, {
    image?: string;
    ports?: string[];
    expose?: string[];
    container_name?: string;
    networks?: string[];
    environment?: Record<string, string>;
    volumes?: Array<{ target?: string; source?: string }>;
    sysctls?: Record<string, string>;
    ulimits?: { nofile?: { soft?: number; hard?: number } };
  }>;
};
const resilienceCompose = load(readFileSync(resolve(ROOT, 'docker-compose.resilience.yml'), 'utf8')) as {
  services: Record<string, {
    profiles?: string[];
    ports?: string[];
    expose?: string[];
    container_name?: string;
    networks?: string[];
  }>;
};
const resilienceDirectCompose = load(readFileSync(resolve(ROOT, 'docker-compose.resilience.direct.yml'), 'utf8')) as {
  services: Record<string, { ports?: string[] }>;
};
const proxyConfig = readFileSync(resolve(ROOT, 'nginx/nginx-prod.conf'), 'utf8');
const resilienceScript = readFileSync(resolve(ROOT, 'scripts/infra-resilience-test.sh'), 'utf8');

describe('production reverse proxy configuration', () => {
  it('keeps the application private and publishes only the proxy', () => {
    const api = compose.services['auth-service'];
    const proxy = compose.services['auth-proxy'];

    expect(api.ports).toBeUndefined();
    expect(api.container_name).toBeUndefined();
    expect(api.expose).toContain('3000');
    expect(api.environment?.TRUST_PROXY).toBe('1');
    expect(api.environment?.INSTANCE_ID).toBe('${INSTANCE_ID:-}');
    expect(proxy.image).toBe('nginx:1.28-alpine');
    expect(proxy.ports).toEqual(expect.arrayContaining([
      '${APP_PORT:-80}:80',
      '443:443'
    ]));
    expect(proxy.networks).toEqual(['auth-network']);
    expect(proxy.volumes?.map(volume => volume.target)).toEqual(expect.arrayContaining([
      '/etc/nginx/nginx.conf',
      '/etc/nginx/tls'
    ]));
    expect(api.sysctls?.['net.core.somaxconn']).toBe('${NET_CORE_SOMAXCONN:-4096}');
    expect(api.ulimits?.nofile).toEqual({ soft: 8192, hard: 8192 });
    expect(proxy.ulimits?.nofile).toEqual({ soft: 4096, hard: 4096 });
    expect(Object.keys(compose.services).filter(service => /^mongodb(?:-|$)/.test(service))).toEqual(['mongodb']);
  });

  it('enforces edge limits and overwrites client-controlled forwarding headers', () => {
    expect(proxyConfig).toContain('server auth-service:3000 resolve max_fails=2 fail_timeout=5s;');
    expect(proxyConfig).toContain('limit_req_zone $binary_remote_addr zone=per_ip:10m rate=20r/s;');
    expect(proxyConfig).toContain('limit_conn per_ip_conn 40;');
    expect(proxyConfig).toContain('client_max_body_size 100k;');
    expect(proxyConfig).toContain('client_header_timeout 10s;');
    expect(proxyConfig).toContain('client_body_timeout 10s;');
    expect(proxyConfig).toContain('ssl_certificate /etc/nginx/tls/fullchain.pem;');
    expect(proxyConfig).toContain('ssl_certificate_key /etc/nginx/tls/privkey.pem;');
    expect(proxyConfig).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
    expect(proxyConfig).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(proxyConfig).not.toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    expect(proxyConfig).toContain('location ~ ^/(liveness|readiness)$ {');
    expect(proxyConfig).toContain('limit_req zone=per_ip burst=40 nodelay;');
    expect(proxyConfig).toContain('limit_conn per_ip_conn 40;');
    const healthProbeLocation = proxyConfig.match(/location ~ \^\/\(liveness\|readiness\)\$ \{([\s\S]*?)\n {4}\}/)?.[1] ?? '';
    expect(healthProbeLocation).not.toContain('limit_req');
    expect(healthProbeLocation).not.toContain('limit_conn');
  });

  it('oferece perfil ddos isolado em loopback com imagem de produção', () => {
    const proxy = resilienceCompose.services['auth-proxy'];
    const api = resilienceCompose.services['auth-service'];

    expect(proxy.profiles).toContain('ddos');
    expect(proxy.ports).toEqual(expect.arrayContaining([
      '127.0.0.1:${DDOS_PROXY_HTTP_PORT:-3201}:80',
      '127.0.0.1:${DDOS_PROXY_TLS_PORT:-3203}:443'
    ]));
    expect(proxy.networks).toEqual(['resilience-network']);
    expect(api.ports).toBeUndefined();
    expect(api.expose).toContain('3000');
    expect(api.container_name).toBeUndefined();
    expect(resilienceDirectCompose.services['auth-service'].ports).toEqual([
      '127.0.0.1:${RESILIENCE_PORT:-3200}:3000'
    ]);
  });

  it('resolve o container da API pelo serviço Compose em vez de nome fixo', () => {
    expect(resilienceScript).toMatch(/APP_CONTAINER_ID=.*ps -q auth-service/);
    expect(resilienceScript).not.toContain('micrologin-resilience-app');
  });
});

/**
 * A confiança em `X-Forwarded-For` é uma afirmação sobre a topologia, e a
 * topologia é feita de arquivos. Estes testes amarram as três peças que precisam
 * concordar entre si: o exemplo de env de produção, o Compose de produção e o
 * `app.set` que entrega o valor ao Express.
 *
 * Sem a amarração, cada peça pode estar certa sozinha e o conjunto errado — por
 * exemplo, `TRUST_PROXY=1` no exemplo de env (parece correto) com o app
 * ignorando a configuração. O rate limit por IP passaria a usar o IP do
 * container, e nenhuma falha apareceria: só a proteção sumiria.
 */
describe('X-Forwarded-For: as três peças da confiança em proxy', () => {
  const prodEnvExample = readFileSync(resolve(ROOT, '.env.prod.example'), 'utf8');
  const appSource = readFileSync(resolve(ROOT, 'src/app.ts'), 'utf8');

  const envValue = (source: string, key: string): string | undefined => {
    const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'));

    return match?.[1].trim();
  };

  it.each([
    ['.env.prod.example', () => envValue(prodEnvExample, 'TRUST_PROXY')],
    ['docker-compose.prod.yml', () => compose.services['auth-service'].environment?.TRUST_PROXY]
  ])('%s declara um salto, nunca a cadeia inteira', (_file, read) => {
    const value = read();

    expect(value).toBe('1');
    // `true` passaria no teste acima se alguém mudasse os dois arquivos juntos,
    // e é justamente o valor que a regra de arranque recusa em produção.
    expect(value).not.toBe('true');
  });

  it('o exemplo de produção não traz o opt-in de confiança irrestrita', () => {
    // Se o exemplo já trouxesse `TRUST_PROXY_ALLOW_UNRESTRICTED=true`, a
    // capacidade de recusar `true` na produção viria desligada de fábrica.
    expect(envValue(prodEnvExample, 'TRUST_PROXY_ALLOW_UNRESTRICTED')).toBeUndefined();
  });

  it('o exemplo de desenvolvimento não confia em cabeçalho de cliente', () => {
    const devEnv = readFileSync(resolve(ROOT, '.env.example'), 'utf8');

    expect(envValue(devEnv, 'TRUST_PROXY')).toBe('false');
  });

  it('o app entrega a configuração ao Express, sem literal no meio do caminho', () => {
    // `src/app.ts` está fora do mapa de cobertura do Jest (ver `jest.config.js`),
    // então o único jeito de prender o caboamento é ler o fonte. A alternativa
    // seria um e2e com orçamento de IP Observe, que não distingue "configurou" de
    // "não configurou" porque as duas respostas dão 429.
    expect(appSource).toMatch(/this\.app\.set\('trust proxy',\s*serverConfig\.proxy\.trustProxy\)/);
    expect(appSource).not.toMatch(/set\('trust proxy',\s*(true|'1'|1)\s*\)/);
    // O `set` precisa vir antes de qualquer middleware que leia `req.ip`: um
    // `trust proxy` configurado depois do `requestLogger` já teria registrado o
    // IP errado na primeira requisição.
    const trustProxyAt = appSource.indexOf('set(\'trust proxy\'');
    const rateLimitAt = appSource.indexOf('advancedRateLimit.checkLimits');

    expect(trustProxyAt).toBeGreaterThan(-1);
    expect(trustProxyAt).toBeLessThan(rateLimitAt);
  });
});
