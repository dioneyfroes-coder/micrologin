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
});
