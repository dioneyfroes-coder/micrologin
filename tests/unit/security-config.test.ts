import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'crypto';

const originalEnv = { ...process.env };

const loadConfig = async() => {
  jest.resetModules();
  return import('../../src/interfaces/config/appConfig.js');
};

/** Par EC P-256 em PEM, no formato que um `.env` consegue representar. */
const es256Pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    kid: 'v1',
    // `\n` literal: é assim que PEM costuma aparecer dentro de variável de
    // ambiente, e é o que a leitura de configuração precisa normalizar.
    privateKeyEnv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
    publicKeyEnv: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '\\n')
  };
};

const configureProduction = (token: string) => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-with-32-chars-min!!';
  process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
  process.env.SECURITY_DASHBOARD_TOKEN = token;
  const { privateKeyEnv, publicKeyEnv } = es256Pair();
  process.env.JWT_ES256_PRIVATE_KEY = privateKeyEnv;
  process.env.JWT_ES256_PUBLIC_KEY = publicKeyEnv;
  process.env.JWT_ES256_KID = 'v1';
};

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
});

describe('configuração do dashboard de segurança', () => {
  it('exige token em produção', async() => {
    configureProduction('');

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/SECURITY_DASHBOARD_TOKEN é obrigatório/);
  });

  it('exige token com pelo menos 32 caracteres em produção', async() => {
    configureProduction('too-short');

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/pelo menos 32 caracteres/);
  });

  it('aceita um token forte em produção', async() => {
    configureProduction('a'.repeat(32));

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });
});

describe('configuração dos segredos JWT (HS256 legado)', () => {
  it('exige JWT_REFRESH_SECRET em produção (sem fallback para JWT_SECRET)', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ALGORITHM = 'HS256';
    delete process.env.JWT_REFRESH_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET é obrigatório/);
  });

  it('exige JWT_REFRESH_SECRET com pelo menos 32 caracteres', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ALGORITHM = 'HS256';
    process.env.JWT_REFRESH_SECRET = 'curto';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET deve ter pelo menos 32 caracteres/);
  });

  it('rejeita JWT_REFRESH_SECRET igual a JWT_SECRET em produção', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ALGORITHM = 'HS256';
    process.env.JWT_REFRESH_SECRET = process.env.JWT_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_REFRESH_SECRET deve ser diferente/);
  });

  it('aceita segredos distintos e não os expõe no resumo', async() => {
    // Fora de produção: o resumo precisa dizer que há segredo sem dizer qual é.
    // Em produção o caminho é ES256, verificado nos testes abaixo.
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-with-32-chars-min!!';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
    delete process.env.JWT_ALGORITHM;

    const { validateConfiguration, getConfigSummary } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    const summary = getConfigSummary() as unknown as {
      security: { jwt: { algorithm: string; symmetricSecret: boolean; refreshJwt: boolean } };
    };
    expect(summary.security.jwt.algorithm).toBe('HS256');
    expect(summary.security.jwt.symmetricSecret).toBe(true);
    expect(summary.security.jwt.refreshJwt).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('test-secret-key');
  });

  it('não exige JWT_REFRESH_SECRET fora de produção', async() => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
    delete process.env.JWT_REFRESH_SECRET;

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });
});

describe('assinatura ES256', () => {
  it('é o padrão em produção, sem exigir segredo simétrico', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    delete process.env.JWT_ALGORITHM;

    const { validateConfiguration, getConfigSummary } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    const summary = getConfigSummary() as unknown as {
      security: { jwt: { algorithm: string; es256: boolean; kid: string } };
    };
    expect(summary.security.jwt.algorithm).toBe('ES256');
    expect(summary.security.jwt.es256).toBe(true);
    expect(summary.security.jwt.kid).toBe('v1');
  });

  it('exige chave privada e pública', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.JWT_ES256_PRIVATE_KEY;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_ES256_PRIVATE_KEY é obrigatório/);
  });

  it('recusa HS256 em produção: quem verifica não pode assinar', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ALGORITHM = 'HS256';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/HS256 não é permitido em produção/);
  });

  it('recusa algoritmo desconhecido em vez de cair num padrão implícito', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ALGORITHM = 'RS512';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_ALGORITHM deve ser ES256 ou HS256/);
  });

  it('recusa rotação pela metade: chave anterior sem kid', async() => {
    configureProduction('a'.repeat(32));
    const previous = es256Pair();
    process.env.JWT_ES256_PREVIOUS_PUBLIC_KEY = previous.publicKeyEnv;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_ES256_PREVIOUS_KID é obrigatório/);
  });

  it('recusa kid anterior sem a chave correspondente', async() => {
    configureProduction('a'.repeat(32));
    process.env.JWT_ES256_PREVIOUS_KID = 'v0';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/JWT_ES256_PREVIOUS_PUBLIC_KEY é obrigatório/);
  });

  it('recusa kid anterior igual ao atual: seria uma rotação que não rotaciona', async() => {
    configureProduction('a'.repeat(32));
    const previous = es256Pair();
    process.env.JWT_ES256_PREVIOUS_KID = 'v1';
    process.env.JWT_ES256_PREVIOUS_PUBLIC_KEY = previous.publicKeyEnv;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/deve ser diferente de JWT_ES256_KID/);
  });

  it('aceita janela de rotação completa', async() => {
    configureProduction('a'.repeat(32));
    const previous = es256Pair();
    process.env.JWT_ES256_PREVIOUS_KID = 'v0';
    process.env.JWT_ES256_PREVIOUS_PUBLIC_KEY = previous.publicKeyEnv;

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });

  it('normaliza o PEM com quebras de linha literais e aceita base64', async() => {
    configureProduction('a'.repeat(32));
    const pair = es256Pair();
    const base64 = Buffer.from(
      pair.privateKeyEnv.replace(/\\n/g, '\n')
    ).toString('base64');

    const literal = await loadConfig();
    expect(literal.securityConfig.jwt.es256.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(literal.securityConfig.jwt.es256.privateKey).toContain('\n');

    process.env.JWT_ES256_PRIVATE_KEY = base64;
    const encoded = await loadConfig();
    expect(encoded.securityConfig.jwt.es256.privateKey).toBe(
      pair.privateKeyEnv.replace(/\\n/g, '\n')
    );
  });

  it('mantém HS256 fora de produção, onde não há KMS', async() => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
    delete process.env.JWT_ALGORITHM;
    delete process.env.JWT_ES256_PRIVATE_KEY;
    delete process.env.JWT_ES256_PUBLIC_KEY;

    const { validateConfiguration, securityConfig } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    expect(securityConfig.jwt.algorithm).toBe('HS256');
  });
});

describe('política de revogação com Redis indisponível', () => {
  it('é fail-closed por padrão em produção', async() => {
    process.env.NODE_ENV = 'production';
    delete process.env.SESSION_FAIL_OPEN;

    const { securityConfig } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(false);
  });

  it('é fail-open por padrão fora de produção', async() => {
    process.env.NODE_ENV = 'development';
    delete process.env.SESSION_FAIL_OPEN;

    const { securityConfig } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(true);
  });

  it('respeita SESSION_FAIL_OPEN=true explícito em produção', async() => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_FAIL_OPEN = 'true';

    const { securityConfig, getConfigSummary } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(true);
    expect((getConfigSummary() as unknown as { session: { failOpen: boolean } }).session.failOpen).toBe(true);
  });
});

describe('configuração de hash de senha', () => {
  it('usa argon2id nos mínimos da OWASP por padrão', async() => {
    const { securityConfig } = await loadConfig();

    expect(securityConfig.passwordHash.algorithm).toBe('argon2id');
    expect(securityConfig.passwordHash.argon2).toEqual({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
    // Pepper desligado por padrão (D17).
    expect(securityConfig.passwordHash.pepper).toBeUndefined();
  });

  it('recusa memória de argon2 baixa demais para ser memory-hard', async() => {
    process.env.ARGON2_MEMORY_COST = '1024';

    const { validateConfiguration } = await loadConfig();

    // Não é aviso: argon2 com m=1024 é barato de quebrar, e a validação
    // silenciosa devolveria um serviço no ar sem a proteção que ele promete.
    expect(() => validateConfiguration()).toThrow(/ARGON2_MEMORY_COST/);
  });

  it('recusa configuração que estouraria a memória do container', async() => {
    process.env.ARGON2_MEMORY_COST = '131072';
    process.env.ARGON2_PARALLELISM = '4';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/512/);
  });

  it('assume p1 quando o pepper atual não declara versão', async() => {
    process.env.PASSWORD_PEPPER = 'segredo-com-tamanho-suficiente';
    process.env.PASSWORD_PEPPER_VERSION = '';

    const { securityConfig, pepperConfigFor, validateConfiguration } = await loadConfig();

    // Primeira ativação não deveria exigir pensar em versão: `p1` é o
    // grounded truth e vai gravado dentro do hash. Quem rotacionar depois
    // declara `p2` + o anterior, que é onde a versão é obrigatória.
    expect(validateConfiguration()).toBe(true);
    expect(pepperConfigFor(securityConfig.passwordHash.pepper)?.version).toBe('p1');
  });

  it('recusa versão de pepper fora do formato pN', async() => {
    process.env.PASSWORD_PEPPER = 'segredo-com-tamanho-suficiente';
    process.env.PASSWORD_PEPPER_VERSION = 'v1';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/formato pN/);
  });

  it('recusa pepper anterior sem versão própria', async() => {
    process.env.PASSWORD_PEPPER = 'segredo-novo';
    process.env.PASSWORD_PEPPER_VERSION = 'p2';
    process.env.PASSWORD_PEPPER_PREVIOUS = 'segredo-antigo';

    const { validateConfiguration } = await loadConfig();

    // O pepper anterior não tem versão padrão: adivinar `p1` aqui transformaria
    // uma rotação em bloqueio de quem ainda não voltou a fazer login.
    expect(() => validateConfiguration()).toThrow(/PASSWORD_PEPPER_PREVIOUS_VERSION/);
  });

  it('lê pepper com versão e aceita o anterior para rotação', async() => {
    process.env.PASSWORD_PEPPER = 'segredo-novo-com-tamanho';
    process.env.PASSWORD_PEPPER_VERSION = 'p2';
    process.env.PASSWORD_PEPPER_PREVIOUS = 'segredo-antigo';
    process.env.PASSWORD_PEPPER_PREVIOUS_VERSION = 'p1';

    const { securityConfig, pepperConfigFor, validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    expect(pepperConfigFor(securityConfig.passwordHash.pepper))
      .toEqual({ version: 'p2', secret: 'segredo-novo-com-tamanho' });
    expect(pepperConfigFor(securityConfig.passwordHash.previousPepper))
      .toEqual({ version: 'p1', secret: 'segredo-antigo' });
  });

  it('o resumo de configuração expõe o algoritmo sem vazar segredo', async() => {
    process.env.PASSWORD_PEPPER = 'segredo-que-nao-pode-vazar';

    const { getConfigSummary } = await loadConfig();
    const summary = JSON.stringify(getConfigSummary());

    expect(summary).toContain('argon2id');
    expect(summary).toContain('pepperConfigured');
    expect(summary).not.toContain('segredo-que-nao-pode-vazar');
  });

  it('aceita bcrypt como rollback e ainda valida a configuração', async() => {
    process.env.PASSWORD_HASH_ALGORITHM = 'bcrypt';

    const { securityConfig, validateConfiguration } = await loadConfig();

    expect(securityConfig.passwordHash.algorithm).toBe('bcrypt');
    expect(validateConfiguration()).toBe(true);
  });

  it('recusa algoritmo desconhecido em vez de assumir o padrão', async() => {
    process.env.PASSWORD_HASH_ALGORITHM = 'scrypt';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/PASSWORD_HASH_ALGORITHM/);
  });
});
