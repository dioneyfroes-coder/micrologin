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
  // A partir da Fase 1.3 produção exige credencial nas dependências e transporte
  // dedicado. A rede isolada é o caminho que não precisa de certificado aqui.
  process.env.MONGODB_USER = 'auth-service';
  process.env.MONGODB_PASSWORD = 'senha-mongo-de-teste';
  process.env.REDIS_USERNAME = 'auth-service';
  process.env.REDIS_PASSWORD = 'senha-redis-de-teste';
  process.env.DEPENDENCY_NETWORK_ISOLATED = 'true';
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

  it('SESSION_FAIL_OPEN=true em produção derruba o arranque', async() => {
    configureProduction('a'.repeat(32));
    process.env.SESSION_FAIL_OPEN = 'true';

    const { securityConfig, validateConfiguration } = await loadConfig();

    // O valor continua legível (quem lê a config vê a intenção), mas a
    // validação recusa: produção é fail-closed por construção, não por default,
    // e um default que protege não serve se um valor explícito desliga a
    // proteção sem custo.
    expect(securityConfig.session.failOpen).toBe(true);
    expect(() => validateConfiguration()).toThrow(/SESSION_FAIL_OPEN=true não é permitido em produção/);
  });

  it('fora de produção o fail-open explícito continua sendo aceito', async() => {
    process.env.NODE_ENV = 'development';
    process.env.SESSION_FAIL_OPEN = 'true';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';
    delete process.env.JWT_ALGORITHM;
    delete process.env.JWT_ES256_PRIVATE_KEY;
    delete process.env.JWT_ES256_PUBLIC_KEY;

    const { securityConfig, validateConfiguration } = await loadConfig();

    expect(securityConfig.session.failOpen).toBe(true);
    expect(validateConfiguration()).toBe(true);
  });
});

describe('configuração de hash de senha', () => {
  it('usa argon2id com 64MiB por padrão, o ponto de melhor custo para o atacante', async() => {
    const { securityConfig } = await loadConfig();

    expect(securityConfig.passwordHash.algorithm).toBe('argon2id');
    // m=64MiB, t=1: 3.4x a memória por tentativa dos m=19MiB da OWASP com a
    // mesma latência de login. Ver a tabela em docs/metricas.md.
    expect(securityConfig.passwordHash.argon2).toEqual({ memoryCost: 65536, timeCost: 1, parallelism: 1 });
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

  it('recusa m=128MiB, que estouraria a memória do container', async() => {
    // 128 MiB × 8 logins = 1 GiB, acima do orçamento de 768 MiB que sobra dos
    // 1 GiB do container. O que é recusado é a conta inteira, não o número de
    // um hash sozinho: um hash que cabe, repetido 8 vezes, não cabe.
    process.env.ARGON2_MEMORY_COST = '131072';
    process.env.ARGON2_PARALLELISM = '1';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/768 MiB/);
  });

  it('o teto de concorrência é 8 por padrão e é o mesmo que a memória orça', async() => {
    const { securityConfig, getConfigSummary } = await loadConfig();

    expect(securityConfig.passwordHash.concurrency).toEqual({ limit: 8, maxQueue: 64 });
    // O número é publicado para que a simultaneidade observada em runtime possa
    // ser conferida contra o valor que o orçamento aprovou.
    expect((getConfigSummary() as unknown as {
      security: { passwordHash: { argon2MaxConcurrency: number } };
    }).security.passwordHash.argon2MaxConcurrency).toBe(8);
  });

  it('ARGON2_MAX_CONCURRENCY configura o teto que a memória orça', async() => {
    process.env.ARGON2_MAX_CONCURRENCY = '4';

    const { securityConfig, validateConfiguration } = await loadConfig();

    expect(securityConfig.passwordHash.concurrency.limit).toBe(4);
    expect(validateConfiguration()).toBe(true);
  });

  it('recusa ARGON2_MAX_CONCURRENCY abaixo de 1', async() => {
    // 0 significaria "sem teto" com a conta de memória ainda descrevendo 0
    // hashes: a validação passaria e a máquina aceitaria quantos vierem. O
    // número que orça memória e o número que a impõe não podem divergir.
    process.env.ARGON2_MAX_CONCURRENCY = '0';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/ARGON2_MAX_CONCURRENCY/);
  });

  it('a memória é orçada com o teto que será IMPOSTO, não com o padrão', async() => {
    // m=128MiB × 4 = 512 MiB: cabe. Com o teto padrão de 8, o mesmo m seria
    // 1 GiB e seria recusado. É a prova de que a conta usa o número configurado
    // em vez de uma constante — a divergência que existia antes desta 1.0.0.
    process.env.ARGON2_MEMORY_COST = '131072';
    process.env.ARGON2_MAX_CONCURRENCY = '4';

    const { validateConfiguration, securityConfig } = await loadConfig();

    expect(securityConfig.passwordHash.concurrency.limit).toBe(4);
    expect(validateConfiguration()).toBe(true);
  });

  it('recusa quando o teto configurado estoura o orçamento, mesmo que o padrão caiba', async() => {
    // m=96MiB × 8 = 768 MiB, exatamente o orçamento: passa. Com teto 16, a
    // mesma memória passa a pedir 1.5 GiB e precisa ser recusada no arranque.
    process.env.ARGON2_MEMORY_COST = '98304';
    process.env.ARGON2_MAX_CONCURRENCY = '16';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/768 MiB/);
  });

  it('recusa ARGON2_MAX_QUEUE negativo', async() => {
    process.env.ARGON2_MAX_QUEUE = '-1';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/ARGON2_MAX_QUEUE/);
  });

  it('aceita o padrão de 64MiB com folga para o runtime', async() => {
    // 64 MiB × 8 logins = 512 MiB, dentro do orçamento de 768 MiB, com ~33%
    // de folga para o runtime. Este é o motivo do padrão não ser 96 MiB.
    const { validateConfiguration, securityConfig } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    expect(securityConfig.passwordHash.argon2.memoryCost).toBe(65536);
  });

  it('aceita m=96MiB, que fecha a conta exatamente com o orçamento', async() => {
    // 96 MiB × 8 logins = 768 MiB exatos. Passa porque o guard compara com
    // `>`, e isso é intencional: 96 MiB é o maior valor que ainda cabe, mas
    // não deixa folga nenhuma para o runtime. Por isso o padrão é 64 MiB e
    // não o máximo teórico — o maior valor que cabe não é o melhor valor.
    process.env.ARGON2_MEMORY_COST = '98304';
    process.env.ARGON2_PARALLELISM = '1';

    const { validateConfiguration, securityConfig } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
    expect(securityConfig.passwordHash.argon2.memoryCost).toBe(98304);
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

  it('mantém argon2id mesmo se o ambiente pedir outro algoritmo', async() => {
    // O bcrypt saiu do projeto e o algoritmo não é mais configurável: aceitar
    // a variável criaria um caminho de gravação que o `compare` não entende,
    // e o usuário que caísse nele ficaria preso sem como entrar.
    process.env.PASSWORD_HASH_ALGORITHM = 'bcrypt';

    const { securityConfig, validateConfiguration } = await loadConfig();

    expect(securityConfig.passwordHash.algorithm).toBe('argon2id');
    expect(validateConfiguration()).toBe(true);
  });
});

describe('credenciais das dependências em produção (Fase 1.3)', () => {
  it('aceita credencial separada com rede isolada', async() => {
    configureProduction('a'.repeat(32));

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });

  it('recusa MongoDB sem credencial: banco aberto não vai para produção', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.MONGODB_USER;
    delete process.env.MONGODB_PASSWORD;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/MongoDB sem credencial/);
  });

  it('recusa Redis sem senha: cache aberto aceita qualquer cliente', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.REDIS_USERNAME;
    delete process.env.REDIS_PASSWORD;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/Redis sem senha/);
  });

  it('recusa credencial na URI junto com as variáveis separadas', async() => {
    configureProduction('a'.repeat(32));
    process.env.URI_MONGODB = 'mongodb://user:senha@localhost:27017/test-db';

    const { validateConfiguration } = await loadConfig();

    // Duas fontes para a mesma conexão: o driver escolhe uma e o operador
    // acredita na outra. É recusado, não resolvido em silêncio.
    expect(() => validateConfiguration()).toThrow(/URI_MONGODB já traz credencial/);
  });

  it('recusa credencial pela metade', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.MONGODB_PASSWORD;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/MONGODB_USER exige MONGODB_PASSWORD/);
  });

  it('recusa variável e arquivo do mesmo segredo ao mesmo tempo', async() => {
    configureProduction('a'.repeat(32));
    process.env.MONGODB_PASSWORD_PATH = '/tmp/nao-importa';

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/MONGODB_PASSWORD e MONGODB_PASSWORD_PATH/);
  });

  it('recusa produção sem TLS e sem rede isolada', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.DEPENDENCY_NETWORK_ISOLATED;

    const { validateConfiguration } = await loadConfig();

    expect(() => validateConfiguration()).toThrow(/sem TLS em produção/);
  });

  it('aceita TLS explícito no lugar da rede isolada', async() => {
    configureProduction('a'.repeat(32));
    delete process.env.DEPENDENCY_NETWORK_ISOLATED;
    process.env.MONGODB_TLS = 'true';
    process.env.REDIS_TLS = 'true';

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });

  it('não exige credencial nem transporte fora de produção', async() => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-secret-key-with-at-least-32-chars-123';
    process.env.URI_MONGODB = 'mongodb://localhost:27017/test-db';

    const { validateConfiguration } = await loadConfig();

    expect(validateConfiguration()).toBe(true);
  });
});
