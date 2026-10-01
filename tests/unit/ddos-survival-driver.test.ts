import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = resolve(ROOT, 'scripts/ddos-survival-test.mjs');
const k6Scenario = readFileSync(resolve(ROOT, 'k6/ddos-survival.js'), 'utf8');
const runnerSource = readFileSync(runner, 'utf8');

const preflight = (baseUrl: string) => spawnSync(process.execPath, [runner, '--preflight-only'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DDOS_BASE_URL: baseUrl, DDOS_ALLOW_REMOTE: '1' }
});

describe('DDoS survival driver', () => {
  it('permite alvos loopback no preflight sem Docker', () => {
    const result = preflight('https://127.0.0.1:3203');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('https://127.0.0.1:3203');
  });

  it('usa loopback IPv4 por padrão, alinhado ao binding do Compose isolado', () => {
    const result = spawnSync(process.execPath, [runner, '--preflight-only'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DDOS_BASE_URL: '' }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('https://127.0.0.1:3203');
  });

  it('recusa host externo mesmo quando DDOS_ALLOW_REMOTE foi definido', () => {
    const result = preflight('https://example.com');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Alvo não local recusado');
  });

  it('recusa host externo antes de verificar Docker ou criar a stack', () => {
    const result = spawnSync(process.execPath, [runner], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DDOS_BASE_URL: 'https://example.com' }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Alvo não local recusado');
    expect(result.stderr).not.toContain('Docker CLI/daemon indisponível');
  });

  it('inclui flood, sondagem viva e thresholds por rota no k6', () => {
    expect(k6Scenario).toContain('login_flood');
    expect(k6Scenario).toContain('refresh_flood');
    expect(k6Scenario).toContain('register_flood');
    expect(k6Scenario).toContain('forwarded_ip_flood');
    expect(k6Scenario).toContain('liveness_probe');
    expect(k6Scenario).toContain('ddos_rate_limited: [\'count>0\']');
    expect(k6Scenario).toContain('ddos_liveness_failures: [\'count==0\']');
  });

  it('usa stack de resiliência, não Compose de produção, e remove volumes ao final', () => {
    expect(runnerSource).toContain('\'-f\', \'docker-compose.resilience.yml\'');
    expect(runnerSource).not.toContain('docker-compose.prod.yml');
    expect(runnerSource).toContain('\'down\', \'-v\', \'--remove-orphans\'');
    expect(runnerSource).toContain('peakContainerMemoryMiB');
    expect(runnerSource).toContain('\'--scale\'');
    expect(runnerSource).toContain('`auth-service=${stack.apiReplicas}`');
    expect(runnerSource).toContain('observeReplicaPids');
  });

  it('usa consumo de memória do docker stats sem confundir com o limite', () => {
    const sample = 'api 410.52MiB / 1GiB\nnginx 45.11MiB / 128MiB';
    const source = [
      'import { parseDockerMemoryStats } from \'./scripts/ddos-survival-test.mjs\'',
      `console.log(parseDockerMemoryStats(${JSON.stringify(sample)}))`
    ].join(';');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: ROOT,
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(Number(result.stdout.trim())).toBeCloseTo(410.52);
  });
});
