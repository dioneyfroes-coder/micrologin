import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalEnv = { ...process.env };

const loadConfig = async() => {
  jest.resetModules();
  return import('../../src/interfaces/config/appConfig.js');
};

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('TRUST_PROXY - confiança em cabeçalhos de proxy', () => {
  it('não confia em proxy por padrão', async() => {
    delete process.env.TRUST_PROXY;

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toBe(false);
  });

  it.each(['false', '0', 'off', 'no', ''])('trata %s como não confiável', async value => {
    process.env.TRUST_PROXY = value;

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toBe(false);
  });

  it('aceita número de saltos de proxy', async() => {
    process.env.TRUST_PROXY = '2';

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toBe(2);
  });

  it('aceita lista de CIDRs do proxy confiável', async() => {
    process.env.TRUST_PROXY = '10.0.0.0/8, 192.168.1.10';

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toEqual(['10.0.0.0/8', '192.168.1.10']);
  });

  it('aceita `true`, mas avisa que a confiança é ampla', async() => {
    process.env.TRUST_PROXY = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TRUST_PROXY'));
  });

  it('aceita caixa alta e espaços em volta', async() => {
    process.env.TRUST_PROXY = '  TRUE  ';

    const { serverConfig } = await loadConfig();

    expect(serverConfig.proxy.trustProxy).toBe(true);
  });
});

describe('TRUST_PROXY - confiança irrestrita é recusada no arranque de produção', () => {
  const productionEnv = (trustProxy: string): void => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = trustProxy;
    // As outras regras de produção continuam valendo e não são o alvo aqui:
    // `SERVER_ROLE`/`SECURITY_DASHBOARD_TOKEN` e as de TLS. O que está sob
    // teste é se a regra do `TRUST_PROXY` recusa, então a asserção olha a
    // linha dela e não a validity da configuração inteira.
    process.env.JWT_ALGORITHM = 'HS256';
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
    process.env.URI_MONGODB = 'mongodb://user:senha-com-32-chars@localhost:27017/auth';
    process.env.REDIS_URL = 'redis://user:senha-com-32-chars@localhost:6379';
  };

  const trustProxyErrors = async(): Promise<string[]> => {
    const { validateConfiguration } = await loadConfig();

    try {
      validateConfiguration();
      return [];
    } catch (error) {
      return String((error as Error).message).split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('TRUST_PROXY'));
    }
  };

  it('recusa TRUST_PROXY=true', async() => {
    productionEnv('true');

    const errors = await trustProxyErrors();

    expect(errors).toHaveLength(1);
    // A recusa precisa dizer o que fazer: uma parede sem caminho é só um
    //服务 outage com texto melhor.
    expect(errors[0]).toMatch(/TRUST_PROXY=1/);
    expect(errors[0]).toMatch(/TRUST_PROXY_ALLOW_UNRESTRICTED=true/);
  });

  it('recusa o sinonimo "all"', async() => {
    productionEnv('all');

    expect(await trustProxyErrors()).toHaveLength(1);
  });

  it('recusa mesmo com o opt-in em valor diferente de true', async() => {
    productionEnv('true');
    process.env.TRUST_PROXY_ALLOW_UNRESTRICTED = '1';

    expect(await trustProxyErrors()).toHaveLength(1);
  });

  it('aceita quando a topologia e declarada no opt-in', async() => {
    productionEnv('true');
    process.env.TRUST_PROXY_ALLOW_UNRESTRICTED = 'true';

    expect(await trustProxyErrors()).toEqual([]);
  });

  it.each(['1', '2', 'false', 'loopback', '10.0.0.0/8'])('aceita %s sem opt-in', async value => {
    productionEnv(value);

    expect(await trustProxyErrors()).toEqual([]);
  });

  it('em desenvolvimento o aviso continua sendo só aviso', async() => {
    process.env.NODE_ENV = 'development';
    process.env.TRUST_PROXY = 'true';

    expect(await trustProxyErrors()).toEqual([]);
  });
});
