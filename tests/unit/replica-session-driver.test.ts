import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = resolve(ROOT, 'scripts/replica-session-test.mjs');
const runnerUrl = pathToFileURL(runner).href;
const runnerSource = readFileSync(runner, 'utf8');

const preflight = (baseUrl: string) => spawnSync(process.execPath, [runner, '--preflight-only'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DDOS_BASE_URL: baseUrl, DDOS_ALLOW_REMOTE: '1' }
});

const evaluate = (expression: string) => {
  const source = [
    `import { readReplicaIdentity, resolveMinimumReplicas } from ${JSON.stringify(runnerUrl)};`,
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

describe('replica session driver', () => {
  describe('piso de réplicas', () => {
    // Um piso de 1 é a forma mais barata de neutralizar a prova inteira: com
    // uma única réplica no upstream, token aceito / revogado / aceito de novo
    // passa sem que nada seja compartilhado.
    it('exige no mínimo duas réplicas por padrão', () => {
      expect(evaluate('resolveMinimumReplicas({})')).toBe(2);
      expect(evaluate('resolveMinimumReplicas({ REPLICA_MIN_REPLICAS: "" })')).toBe(2);
    });

    it('aceita um piso maior, para exigir mais que duas réplicas', () => {
      expect(evaluate('resolveMinimumReplicas({ REPLICA_MIN_REPLICAS: "3" })')).toBe(3);
    });

    it('recusa piso de 1, que esvaziaria a prova', () => {
      expect(evaluate(`(() => {
        try { resolveMinimumReplicas({ REPLICA_MIN_REPLICAS: '1' }); return 'aceitou'; }
        catch (error) { return error.message; }
      })()`)).toContain('>= 2');
    });

    it('recusa valor que não é inteiro em vez de cair num NaN silencioso', () => {
      for (const raw of ['0', '-3', '2.5', 'dois', 'NaN']) {
        expect(evaluate(`(() => {
          try { resolveMinimumReplicas({ REPLICA_MIN_REPLICAS: ${JSON.stringify(raw)} }); return 'aceitou'; }
          catch (error) { return 'recusou'; }
        })()`)).toBe('recusou');
      }
    });
  });

  describe('preflight', () => {
    it('aceita alvo loopback sem Docker', () => {
      const result = preflight('https://127.0.0.1:3213');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('https://127.0.0.1:3213');
    });

    it('recusa host externo, herdando a trava do runner de DDoS', () => {
      const result = preflight('https://example.com');

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    });
  });

  describe('prova de estado compartilhado', () => {
    // Estas cinco asserções existem porque a prova pode passar pelo motivo
    // errado. Cada uma delas descreve um modo de falha em que o teste fica
    // verde sem que o estado seja compartilhado de fato.

    it('exige que o proxy tenha alcançado mais de uma réplica distinta', () => {
      // Sem isto, um proxy que não distribui (uma única réplica no upstream)
      // satisfaz todas as demais verificações: token aceito, revogado e
      // aceito de novo. O teste passaria provando round-robin, e não sessão
      // compartilhada.
      expect(runnerSource).toContain('REPLICA_MIN_REPLICAS');
      expect(runnerSource).toContain('waitForReplicas(baseUrl, minimumReplicas)');
      expect(runnerSource).toContain('seen.size >= minimum');
      expect(runnerSource).toContain('identities.size');
    });

    it('verifica o token válido em todas as réplicas antes de revogar', () => {
      // Chave ES256 divergente entre réplicas também produz 401. Sem esta
      // etapa prévia, a negativa observada depois do logout seria indistinguível
      // de "chave não compartilhada" — que é justamente o defeito que o teste
      // existe para detectar.
      const antesDoLogout = runnerSource.slice(0, runnerSource.indexOf('const logout = await json(baseUrl'));
      expect(antesDoLogout).toContain('recusou o token válido');
      expect(antesDoLogout).toContain('antes de revogar');
      expect(runnerSource).toContain('sharedSigningKeyBeforeRevocation');
    });

    it('prova que a revogação não é um no-op, abrindo sessão nova depois', () => {
      // "Todas recusaram o token antigo" é o mesmo resultado de uma revogação
      // desligada. Só uma sessão nova aceita em todas as réplicas distingue as
      // duas coisas.
      expect(runnerSource).toContain('a revogação não é um no-op');
      expect(runnerSource).toContain('newSessionAcceptedEverywhere');
    });

    it('endereça as réplicas pelo IP interno, sem passar pelo proxy', () => {
      // Consultar as réplicas pela URL do proxy não diria nada: o request
      // cairia em qualquer réplica e a negativa observada não provaria que o
      // estado atravessou containers distintos.
      expect(runnerSource).toContain('directUrl');
      expect(runnerSource).toContain('`http://${address.ip}:3000`');
      expect(runnerSource).toContain('docker inspect'.replace('docker inspect', '\'inspect\''));
      expect(runnerSource).toContain('resolveReplicaAddresses');
    });

    it('revoga pela borda (proxy) e verifica pela origem (IP interno)', () => {
      // Logout e troca de senha vão pelo proxy, que é o caminho do cliente;
      // as verificações vão pelo IP interno. Inverter os dois significaria
      // testar o proxy como origem e a origem como proxy.
      expect(runnerSource).toContain('json(baseUrl, \'/logout\'');
      expect(runnerSource).toContain('baseUrl, \'/password\'');
      expect(runnerSource).toContain('a revogação não atravessou as réplicas');
    });
  });

  describe('execução', () => {
    it('sobe a topologia de réplicas do perfil ddos, sem tocar em produção', () => {
      expect(runnerSource).toContain('\'--profile\', \'ddos\'');
      expect(runnerSource).toContain('\'-f\', \'docker-compose.resilience.yml\'');
      expect(runnerSource).not.toContain('docker-compose.prod.yml');
      expect(runnerSource).toContain('`auth-service=${replicasWanted}`');
    });

    it('desmonta o stack e o material efêmero mesmo em falha', () => {
      expect(runnerSource).toContain('} finally {');
      expect(runnerSource).toContain('\'down\', \'-v\', \'--remove-orphans\'');
      expect(runnerSource).toContain('rmSync(tempDir, { recursive: true, force: true })');
    });

    it('provisiona as chaves e os certificados em disco efêmero, fora do repositório', () => {
      expect(runnerSource).toContain('generate-jwt-keys.sh');
      expect(runnerSource).toContain('generate-dependency-secrets.sh');
      expect(runnerSource).toContain('mkdtempSync(join(tmpdir()');
      expect(runnerSource).not.toContain('scripts/generate-jwt-keys.sh \'');
    });
  });

  describe('identidade de réplica', () => {
    it('lê a identidade de serviço do observability', () => {
      expect(evaluate('readReplicaIdentity({ service: { instance_id: \'auth-service-2\' } })'))
        .toBe('auth-service-2');
    });

    it('descarta resposta sem identidade utilizável', () => {
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
