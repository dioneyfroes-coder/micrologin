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
    networks?: string[];
    environment?: Record<string, string>;
    volumes?: Array<{ target?: string; source?: string }>;
    sysctls?: Record<string, string>;
    ulimits?: { nofile?: { soft?: number; hard?: number } };
  }>;
};
const proxyConfig = readFileSync(resolve(ROOT, 'nginx/nginx-prod.conf'), 'utf8');

describe('production reverse proxy configuration', () => {
  it('keeps the application private and publishes only the proxy', () => {
    const api = compose.services['auth-service'];
    const proxy = compose.services['auth-proxy'];

    expect(api.ports).toBeUndefined();
    expect(api.expose).toContain('3000');
    expect(api.environment?.TRUST_PROXY).toBe('1');
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
  });
});
