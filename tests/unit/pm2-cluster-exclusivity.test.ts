import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

/**
 * PM2 e cluster module não podem multiplicar processos ao mesmo tempo.
 *
 * Com os dois ligados, cada instância do PM2 ainda forka os N workers do
 * cluster module: com os defaults (4 instâncias, 4 workers) são 16 processos,
 * cada um com os ~392.9 MB de RSS medidos no pico do `/login` — 4× o teto de
 * 1 GiB do container. O sintoma (OOM e restart-loop) aparece longe da causa, e
 * o `.env.prod` não é garantia suficiente: ele é sobrescrito, e o
 * `ecosystem.config.cjs` pode ser editado sem que nada reclame.
 *
 * A garantia precisa estar em dois lugares, e este arquivo segura os dois:
 * o `ecosystem.config.cjs` (que precisa desligar o cluster) e o bootstrap do
 * app (que precisa recusar o arranque).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * As variáveis que o PM2 injeta em cada processo que ele gerencia. O app não
 * define nenhuma delas.
 */
const PM2_SIGNATURE = {
  pm_id: '0',
  NODE_APP_INSTANCE: '0',
  pm_exec_path: '/usr/lib/node_modules/pm2/bin/pm2'
};

const clearProcessManagerEnv = (): void => {
  delete process.env.pm_id;
  delete process.env.NODE_APP_INSTANCE;
  delete process.env.pm_exec_path;
  // `PM2_INSTANCES` também é lida pelo guard, e o `process.env` do Jest é
  // compartilhado entre casos: um caso que a deixa de fora contamina o
  // seguinte com um número de instâncias que ninguém pediu.
  delete process.env.PM2_INSTANCES;
};

const loadClusterConfig = async(env: Record<string, string> = {}) => {
  jest.resetModules();

  clearProcessManagerEnv();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CLUSTER_') || key === 'NODE_ENV') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);

  const mod = await import('../../src/interfaces/config/appConfig.js');

  return {
    cluster: mod.serverConfig.cluster as {
      enabled: boolean;
      workers: number;
      processManager: string;
      processManagerInstances: number;
    },
    conflict: mod.clusterConflict,
    validate: mod.validateConfiguration
  };
};

afterEach(() => {
  clearProcessManagerEnv();
  jest.resetModules();
  jest.restoreAllMocks();
  process.env = { ...process.env };
});

describe('exclusão mútua: PM2 e cluster module', () => {
  describe('detecção do process manager', () => {
    it('reconhece o PM2 pela assinatura que ele injeta', async() => {
      const { cluster } = await loadClusterConfig({ ...PM2_SIGNATURE });

      expect(cluster.processManager).toBe('pm2');
      expect(cluster.processManagerInstances).toBe(1);
    });

    it('sem PM2, quem gerencia os processos é o próprio Node', async() => {
      const { cluster } = await loadClusterConfig();

      expect(cluster.processManager).toBe('node');
      expect(cluster.processManagerInstances).toBe(0);
    });

    it('NODE_APP_INSTANCE é índice 0-based, não contagem', async() => {
      const { cluster } = await loadClusterConfig({
        pm_id: '3',
        NODE_APP_INSTANCE: '3'
      });

      // A instância 3 de um PM2_INSTANCES=4 é a ÚLTIMA de quatro. Ler o índice
      // como contagem prometeria "3 processos" no erro, escondendo um deles
      // justamente na aritmética que o operador usa para decidir.
      expect(cluster.processManagerInstances).toBe(4);
    });

    it('PM2_INSTANCES tem precedência sobre o índice', async() => {
      const { cluster } = await loadClusterConfig({
        pm_id: '3',
        NODE_APP_INSTANCE: '3',
        PM2_INSTANCES: '8'
      });

      // O env dePM2 carrega PM2_INSTANCES para os processos filhos; quando está
      // presente ele é a contagem real, e vale mais que a inferência pelo índice.
      expect(cluster.processManagerInstances).toBe(8);
    });

    it('pm_id sem NODE_APP_INSTANCE ainda conta uma instância', async() => {
      // O PM2 em `exec_mode: 'fork'` nem sempre propaga NODE_APP_INSTANCE.
      // Sem esta leitura, o relatório do erro diria "0 processos" numa
      // configuração que está multiplicando.
      const { cluster } = await loadClusterConfig({ pm_id: '0' });

      expect(cluster.processManagerInstances).toBe(1);
    });
  });

  describe('o guard recusa a combinação', () => {
    it('recusa quando PM2 e cluster estão ambos ativos', async() => {
      const { cluster, conflict } = await loadClusterConfig({
        ...PM2_SIGNATURE,
        NODE_ENV: 'production'
      });

      expect(cluster.enabled).toBe(true);
      expect(conflict()).toBeDefined();
    });

    it('o erro diz quantos processos iam existir, não só que há conflito', async() => {
      const { conflict } = await loadClusterConfig({
        pm_id: '0',
        NODE_APP_INSTANCE: '3',
        NODE_ENV: 'production',
        CLUSTER_WORKERS: '4'
      });

      // A mensagem é o que o operador lê às 3h da manhã. "Erro de configuração"
      // sem a aritmética não ajuda ninguém a decidir entre as duas saídas.
      expect(conflict()).toMatch(/4 instâncias|4 processo/);
      expect(conflict()).toMatch(/16 processos/);
      expect(conflict()).toMatch(/CLUSTER_ENABLED=false/);
    });

    it('validateConfiguration reprova o arranque nessa combinação', async() => {
      const { validate } = await loadClusterConfig({
        ...PM2_SIGNATURE,
        NODE_ENV: 'production',
        JWT_ALGORITHM: 'ES256',
        JWT_ES256_PRIVATE_KEY: 'x',
        JWT_ES256_PUBLIC_KEY: 'y'
      });

      expect(() => validate()).toThrow(/PM2 e cluster module não podem estar ativos/);
    });

    it('PM2 com o cluster desligado é a configuração suportada', async() => {
      const { cluster, conflict } = await loadClusterConfig({
        ...PM2_SIGNATURE,
        NODE_ENV: 'production',
        CLUSTER_ENABLED: 'false'
      });

      expect(cluster.enabled).toBe(false);
      expect(conflict()).toBeUndefined();
    });

    it('cluster sem PM2 é a outra configuração suportada', async() => {
      const { cluster, conflict } = await loadClusterConfig({
        NODE_ENV: 'production'
      });

      expect(cluster.enabled).toBe(true);
      expect(cluster.processManager).toBe('node');
      expect(conflict()).toBeUndefined();
    });

    it('NODE_APP_INSTANCE sem pm_id também é o PM2', async() => {
      // `exec_mode: 'fork'` popula só o NODE_APP_INSTANCE. Reconhecer pelo
      // primeiro sinal ausente deixaria passar justamente esse modo.
      const { cluster, conflict } = await loadClusterConfig({
        NODE_APP_INSTANCE: '2',
        NODE_ENV: 'production'
      });

      expect(cluster.processManager).toBe('pm2');
      expect(conflict()).toBeDefined();
    });
  });

  describe('o bootstrap recusa antes de forkar', () => {
    const appSource = readFileSync(resolve(ROOT, 'src/app.ts'), 'utf8');

    it('o caminho do cluster consulta o guard, porque validateConfiguration não roda nele', () => {
      // Com o cluster ligado, o primary forka e nunca constrói o AuthService —
      // que é quem chama validateConfiguration. Um guard só na validação
      // passaria verde enquanto o processo multiplicava em cascata.
      expect(appSource).toMatch(/if \(cluster\.isPrimary && serverConfig\.cluster\.enabled\)/);
      expect(appSource).toMatch(/clusterConflict\(\)/);
    });

    it('o guard é consultado ANTES de qualquer fork', () => {
      const forkBlock = appSource.slice(
        appSource.indexOf('if (cluster.isPrimary && serverConfig.cluster.enabled)'),
        appSource.indexOf('cluster.fork()')
      );

      expect(forkBlock).toMatch(/clusterConflict\(\)/);
      expect(forkBlock).toMatch(/process\.exit\(1\)/);
      expect(forkBlock).not.toMatch(/cluster\.fork\(\)/);
    });

    it('o guard de app.ts é o mesmo do appConfig, não uma cópia', () => {
      // Duas contas separadas divergem — foi assim que os dois pontos passaram
      // a discordar. O app.ts importa a função, não reimplementa a regra.
      expect(appSource).toMatch(/import \{[^}]*clusterConflict[^}]*\} from '\.\/interfaces\/config\/appConfig\.js'/s);
    });
  });

  describe('ecosystem.config.cjs', () => {
    const loadEcosystem = (env: Record<string, string> = {}) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      // `require` sem cache: o arquivo lê process.env no carregamento.
      jest.resetModules();
      // `require` não existe num módulo ESM; `createRequire` dá o mesmo
      // carregamento do Node CommonJS, que é como o PM2 lê o arquivo.
      const config = createRequire(import.meta.url)(resolve(ROOT, 'ecosystem.config.cjs')) as {
        apps: Array<{
          name: string;
          instances: number;
          exec_mode: string;
          env: Record<string, string>;
          env_production: Record<string, string>;
        }>;
      };
      process.env = saved;

      return config.apps[0];
    };

    it('desliga o cluster module nos dois blocos de env', () => {
      const app = loadEcosystem();

      // Este é o ponto do acordo: o PM2 é o multiplicador, então o cluster
      // module precisa estar desligado tanto no dev quanto em produção.
      expect(app.env.CLUSTER_ENABLED).toBe('false');
      expect(app.env_production.CLUSTER_ENABLED).toBe('false');
    });

    it('usa o modo cluster do PM2, que é quem faz o fork', () => {
      expect(loadEcosystem().exec_mode).toBe('cluster');
    });

    it('PM2_INSTANCES configura o número de instâncias', () => {
      expect(loadEcosystem({ PM2_INSTANCES: '7' }).instances).toBe(7);
    });

    it('sem PM2_INSTANCES, mantém o default de 4', () => {
      expect(loadEcosystem().instances).toBe(4);
    });

    it('um PM2_INSTANCES abaixo de 1 chega ao PM2 intacto', () => {
      // Com `|| 4`, o 0 caía no default: o operador digita 0 achando que
      // desliga o PM2 e recebe 4 processos — o oposto do que pediu. `instances`
      // < 1 é erro do PM2, e o valor digitado tem de chegar lá para o erro
      // aparecer em vez de virar um default silencioso por cima.
      expect(loadEcosystem({ PM2_INSTANCES: '0' }).instances).toBe(0);
      expect(loadEcosystem({ PM2_INSTANCES: '-3' }).instances).toBe(-3);
    });

    it('uma variável vazia conta como não dita', () => {
      // `PM2_INSTANCES=` no .env é o mesmo que não declarar; o default entra.
      expect(loadEcosystem({ PM2_INSTANCES: '' }).instances).toBe(4);
      expect(loadEcosystem({ PM2_INSTANCES: '  ' }).instances).toBe(4);
    });

    it('a configuração do PM2 nunca contradiz o guard do bootstrap', () => {
      // Fecha o ciclo: os defaults do ecosystem, aplicados no app, têm que
      // passar pelo `clusterConflict`. Se alguémligar o cluster no ecosystem,
      // este teste falha antes do deploy — e o guard continuaria sendo o que
      // impede o processo de subir errado em produção.
      const app = loadEcosystem({ NODE_ENV: 'production' });
      const clusterEnabled = app.env_production.CLUSTER_ENABLED !== 'false';

      expect(clusterEnabled).toBe(false);
    });
  });
});
