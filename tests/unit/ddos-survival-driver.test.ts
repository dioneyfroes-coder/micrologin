import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = resolve(ROOT, 'scripts/ddos-survival-test.mjs');
const runnerUrl = pathToFileURL(runner).href;
const k6Scenario = readFileSync(resolve(ROOT, 'k6/ddos-survival.js'), 'utf8');
const runnerSource = readFileSync(runner, 'utf8');

const preflight = (baseUrl: string) => spawnSync(process.execPath, [runner, '--preflight-only'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DDOS_BASE_URL: baseUrl, DDOS_ALLOW_REMOTE: '1' }
});

/**
 * Executa uma expressão contra as funções puras exportadas pelo runner. O
 * módulo tem guarda de `main()`, então importar não executa a suíte.
 */
const evaluate = (expression: string) => {
  const source = [
    `import { collectReplicaIdentities, parseK6Summary, readReplicaIdentity } from ${JSON.stringify(runnerUrl)};`,
    `console.log(JSON.stringify(${expression}));`
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(`avaliação falhou: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
};

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

  // O que segue trava duas regressões que já custaram uma execução de suíte.
  describe('leitura do summary do k6', () => {
    // O `--summary-export` grava a métrica como `{ rate, count }`. Ler
    // `values.count` (formato do dashboard web) devolvia `undefined`, o `?? 0`
    // convertia em zero e a suíte reprovava com "não observou 429" mesmo
    // tendo 3848 deles.
    it('lê a métrica no formato real do export, sem o wrapper values', () => {
      const summary = {
        metrics: {
          ddos_rate_limited: { count: 3848, rate: 191.481938 },
          ddos_liveness_failures: { count: 0, rate: 0 },
          ddos_server_errors: { count: 0, rate: 0 }
        }
      };

      expect(evaluate(`parseK6Summary(${JSON.stringify(summary)})`)).toEqual({
        rateLimited: 3848,
        livenessFailures: 0,
        serverErrors: 0
      });
    });

    // A guarda de 5xx era código morto pelo mesmo motivo: lia 0 sempre, então
    // `serverErrors >= 5` nunca disparava e um 5xx real durante o flood
    // passava. Precisa enxergar o número.
    it('lê falhas de liveness e respostas 5xx, que antes valiam sempre zero', () => {
      const summary = {
        metrics: {
          ddos_rate_limited: { count: 120 },
          ddos_liveness_failures: { count: 3 },
          ddos_server_errors: { count: 7 }
        }
      };

      expect(evaluate(`parseK6Summary(${JSON.stringify(summary)})`)).toEqual({
        rateLimited: 120,
        livenessFailures: 3,
        serverErrors: 7
      });
    });

    it('aceita o JSON serializado, como o runner lê do disco', () => {
      const summary = JSON.stringify({ metrics: { ddos_rate_limited: { count: 5 } } });

      expect(evaluate(`parseK6Summary(${JSON.stringify(summary)})`)).toEqual({
        rateLimited: 5,
        livenessFailures: 0,
        serverErrors: 0
      });
    });

    it('não inventa contagem quando a métrica não está no export', () => {
      expect(evaluate('parseK6Summary({})')).toEqual({
        rateLimited: 0,
        livenessFailures: 0,
        serverErrors: 0
      });
    });
  });

  describe('identidade de réplica', () => {
    // PID é por namespace de container. Na stack de três réplicas, duas
    // responderam `pid: 8`: contar PIDs distintos media números, não réplicas,
    // e a asserção passou numa execução e reprovou na outra sem mudança no
    // serviço.
    it('distingue réplicas que compartilham o mesmo PID', () => {
      const primeira = { status: 'alive', pid: 8, service: { instance_id: 'auth-service-2' } };
      const segunda = { status: 'alive', pid: 8, service: { instance_id: 'auth-service-3' } };

      // Passa pela agregação real, não só pela leitura: trocar o ponto de uso
      // de volta para `pid` reprovaria aqui.
      expect(evaluate(
        `collectReplicaIdentities([${JSON.stringify(primeira)}, ${JSON.stringify(segunda)}]).size`
      )).toBe(2);
    });

    it('conta réplicas distintas, não respostas', () => {
      const tres = [
        { pid: 7, service: { instance_id: 'auth-service-1' } },
        { pid: 8, service: { instance_id: 'auth-service-2' } },
        { pid: 8, service: { instance_id: 'auth-service-3' } }
      ];

      expect(evaluate(`collectReplicaIdentities(${JSON.stringify(tres)}).size`)).toBe(3);
    });

    it('ignora resposta sem identidade em vez de contá-la como réplica', () => {
      const respostas = [
        { pid: 7, service: { instance_id: 'auth-service-1' } },
        { pid: 8 },
        { service: { instance_id: '' } },
        '<html>502</html>'
      ];

      expect(evaluate(`collectReplicaIdentities(${JSON.stringify(respostas)}).size`)).toBe(1);
    });

    it('lê INSTANCE_ID quando provisionado e cai no hostname como último recurso', () => {
      const comInstanceId = { service: { instance_id: 'INSTANCE_ID_FORCADO' } };
      const soHostname = { service: { instance_id: 'container-abc' } };

      expect(evaluate(`readReplicaIdentity(${JSON.stringify(comInstanceId)})`))
        .toBe('INSTANCE_ID_FORCADO');
      expect(evaluate(`readReplicaIdentity(${JSON.stringify(soHostname)})`))
        .toBe('container-abc');
    });

    it('não conta resposta sem identidade utilizável', () => {
      const semCampo = { status: 'alive', pid: 8 };
      const vazio = { service: { instance_id: '' } };
      const tipoErrado = { service: { instance_id: 42 } };
      const naoJson = '<html>502 Bad Gateway</html>';

      for (const body of [semCampo, vazio, tipoErrado, naoJson]) {
        expect(evaluate(`readReplicaIdentity(${JSON.stringify(body)}) ?? null`)).toBeNull();
      }
    });
  });
});
