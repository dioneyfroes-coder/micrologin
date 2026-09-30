import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * O número de workers é a decisão de tuning com efeito em memória, não só em
 * CPU: a Fase 3.1 mediu 392.9 MB de RSS por processo no pico do `/login`, e
 * o teto do container é 1 GiB. Então a pergunta que este teste faz é: quando o
 * container tem menos CPU que a máquina, o default segue a máquina ou o
 * container?
 */

const HOST_CPUS = 8;

type ClusterShape = { enabled: boolean; workers: number; maxWorkers: number };

const loadCluster = async(env: Record<string, string | undefined> = {}): Promise<ClusterShape> => {
  jest.resetModules();

  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CLUSTER_') || key === 'NODE_ENV') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);

  jest.unstable_mockModule('os', () => {
    const actual = jest.requireActual<typeof import('os')>('os');
    return {
      ...actual,
      default: {
        ...actual,
        // A máquina tem 8 CPUs...
        cpus: () => new Array(HOST_CPUS).fill({ model: 'test', speed: 1 }),
        // ...mas o cgroup do container libera só 2.
        availableParallelism: () => 2
      }
    };
  });

  const { serverConfig } = await import('../../src/interfaces/config/appConfig.js');

  try {
    return serverConfig.cluster as ClusterShape;
  } finally {
    process.env = saved;
  }
};

describe('cluster - número de workers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('segue a cota do container, não a contagem de CPUs da máquina', async() => {
    const cluster = await loadCluster();

    expect(HOST_CPUS).toBeGreaterThan(2);
    expect(cluster.workers).toBe(2);
    expect(cluster.workers).not.toBe(HOST_CPUS);
  });

  it('mantém maxWorkers acima de workers, para o cluster poder crescer', async() => {
    const cluster = await loadCluster();

    expect(cluster.maxWorkers).toBeGreaterThan(cluster.workers);
    expect(cluster.maxWorkers).toBe(4);
  });

  it('CLUSTER_WORKERS tem precedência sobre o default', async() => {
    const cluster = await loadCluster({ CLUSTER_WORKERS: '4', CLUSTER_MAX_WORKERS: '8' });

    expect(cluster.workers).toBe(4);
    expect(cluster.maxWorkers).toBe(8);
  });

  it('cai para o que o Node antigo sabia quando availableParallelism não existe', async() => {
    jest.resetModules();
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CLUSTER_')) {
        delete process.env[key];
      }
    }

    jest.unstable_mockModule('os', () => {
      const actual = jest.requireActual<typeof import('os')>('os');
      return {
        ...actual,
        default: {
          ...actual,
          cpus: () => new Array(HOST_CPUS).fill({ model: 'test', speed: 1 }),
          availableParallelism: undefined
        }
      };
    });

    const { serverConfig } = await import('../../src/interfaces/config/appConfig.js');

    expect((serverConfig.cluster as ClusterShape).workers).toBe(HOST_CPUS);
    process.env = saved;
  });

  it('workers acima de maxWorkers é recusado antes do arranque', async() => {
    jest.resetModules();
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CLUSTER_')) {
        delete process.env[key];
      }
    }
    process.env.CLUSTER_WORKERS = '9';
    process.env.CLUSTER_MAX_WORKERS = '4';

    const { validateConfiguration } = await import('../../src/interfaces/config/appConfig.js');

    expect(() => {
      validateConfiguration();
    }).toThrow(/CLUSTER_WORKERS não pode ser maior que CLUSTER_MAX_WORKERS/);

    process.env = saved;
  });
});
