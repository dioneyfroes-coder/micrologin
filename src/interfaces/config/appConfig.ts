/**
 * CONFIGURAÇÃO CENTRALIZADA DA APLICAÇÃO
 *
 * Centraliza todas as configurações de forma segura e organizada.
 * Separação entre configurações públicas e sensíveis.
 */

// Carregar variáveis de ambiente PRIMEIRO
import './env.js';

import os from 'os';
import { readFileSync } from 'fs';
import { parseEnvNumber } from './rateLimitConfig.js';
import { getMongoConfig } from './mongoConfig.js';
import { getRedisConfig } from './redisConfig.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * CPUs que o processo pode de fato usar, respeitando a cota do container.
 *
 * `os.cpus().length` devolve a quantidade de CPUs da MÁQUINA, não as do
 * container. No stack de produção (2.0 CPU) ele devolvia 4, então o default
 * pedia 4 workers para 2 CPUs: o dobro do que o processador comporta, com o
 * custo de 4 vezes a memória por processo. E a memória por processo não é
 * pequena — a Fase 3.1 mediu 392.9 MB de RSS no pico do `/login`, então 4
 * workers passariam de 1 GiB.
 *
 * `os.availableParallelism()` (Node 18.14+) é a função que olha a cota do
 * cgroup e devolve 2 no mesmo container. O fallback existe para runtimes
 * antigos: sem ela, ao menos continuamos com o que o Node antigo sabia.
 */
const availableCpus = (): number => {
  if (typeof os.availableParallelism === 'function') {
    return os.availableParallelism();
  }

  return os.cpus().length;
};

/**
 * Converte `TRUST_PROXY` em algo que o Express aceite como `trust proxy`.
 *
 * Aceita:
 *   - `false`/`0`/`off`/`no`  -> não confiar em nenhum proxy (padrão seguro)
 *   - número inteiro         -> número de saltos de proxy confiáveis
 *   - CIDR ou lista de CIDRs  -> faixa do proxy confiável
 *   - qualquer outro valor    -> ligado (`true`), com aviso no log
 */
const parseTrustProxy = (raw: string | undefined): boolean | number | string | string[] => {
  const value = (raw ?? 'false').trim().toLowerCase();

  if (['false', '0', 'off', 'no', 'none', 'never', ''].includes(value)) {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return parseEnvNumber(value, 0);
  }

  if (value === 'true' || ['on', 'yes', 'always', 'all'].includes(value)) {
    logger.warn('⚠️ TRUST_PROXY ligado sem restrição: qualquer cliente pode forjar X-Forwarded-For e escapar do rate limit por IP.');
    return true;
  }

  return raw!.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
};

const parsePositiveEnvNumber = (value: string | undefined, fallback: number): number => {
  const parsed = parseEnvNumber(value, fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const httpRequestTimeout = parsePositiveEnvNumber(process.env.HTTP_REQUEST_TIMEOUT, 30000);
const httpHeadersTimeout = Math.min(
  parsePositiveEnvNumber(process.env.HTTP_HEADERS_TIMEOUT, 15000),
  httpRequestTimeout
);

/**
 * Configurações de servidor e aplicação
 */
export const serverConfig = {
  // Servidor
  port: process.env.PORT || 3443,
  host: process.env.HOST || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',

  // SSL/TLS
  ssl: {
    keyPath: process.env.SSL_KEY_PATH || 'server.key',
    certPath: process.env.SSL_CERT_PATH || 'server.crt',
    // SSL habilitado por padrão apenas em produção ("NODE_ENV=production");
    // em dev/test, habilitar explicitamente com SSL_ENABLED=true
    enabled: process.env.SSL_ENABLED !== 'false' &&
      (process.env.NODE_ENV === 'production' || process.env.SSL_ENABLED === 'true')
  },

  // Clustering
  cluster: {
    // Clustering desabilitado por padrão em dev/test (rodar o app direto);
    // habilitar com CLUSTER_ENABLED=true ou em produção.
    enabled: process.env.NODE_ENV === 'production'
      ? process.env.CLUSTER_ENABLED !== 'false'
      : process.env.CLUSTER_ENABLED === 'true',
    workers: parseEnvNumber(process.env.CLUSTER_WORKERS, availableCpus()),
    maxWorkers: parseEnvNumber(process.env.CLUSTER_MAX_WORKERS, availableCpus() * 2),
    respawnDelay: parseEnvNumber(process.env.CLUSTER_RESPAWN_DELAY, 1000)
  },

  // Limite de requisições em andamento
  //
  // Rate limit responde "quantas vezes por janela"; isto responde "quantas ao
  // MESMO TEMPO". São defesas diferentes: o rate limit segura o abuso que
  // insiste, o limite de concorrência segura a rajada.
  //
  // O teto é 1024 porque é o ponto em que ele fica TRANSPARENTE sob a maior
  // carga medida, e só engage acima disso. Medido a 400 VUs, 1 worker, o
  // comportamento do serviço conforme o teto:
  //
  //   sem teto   /login 22.37 rps RSS 365.8 MB   /refresh 485.15 rps RSS 375.4 MB
  //   teto 1024  /login 21.07 rps RSS 357.5 MB   /refresh 543.83 rps RSS 261.8 MB
  //   teto  256  /login 19.55 rps RSS 348.9 MB   /refresh 244.54 rps RSS 325.8 MB
  //   teto   32  /login 11.19 rps RSS 327.3 MB   /refresh  21.11 rps RSS 279.5 MB
  //
  // Duas leituras que contrariam a intuição:
  //
  // 1. Com teto 1024 não houve UMA recusa (0 × 503) e os números ficam nos do
  //    baseline. O teto existe para rajada, não para tráfego normal.
  // 2. O teto é uma alavanca ruim de memória, e por isso ele é frouxo. Teto 256
  //    compra 13% de memória e paga 50% da vazão do /refresh; teto 32 compra
  //    11% e paga metade do /login. A memória desse serviço não é dominada pelo
  //    número de requisições esperando -- é dominada pelo argon2id (~19 MiB por
  //    hash concorrente) e pelo que o GC retém. Quem protege memória sob carga
  //    normal é `availableParallelism()`, o teto do container e o
  //    disjuntor do orquestrador; este limite é a última linha contra rajada.
  //
  // 503 e não 429: 429 é "tente mais tarde por janela" e o cliente já conhece o
  // código do rate limit; 503 com `Retry-After` é "agora eu não consigo", e é o
  // que o balanceador sabe reagir, tirando da rotação em vez de insistir.
  inFlight: {
    max: parseEnvNumber(process.env.MAX_IN_FLIGHT_REQUESTS, 1024),
    // Caminhos que NUNCA são recusados, nem sob rajada.
    //
    // `/health` e `/readiness` são o sinal que o orquestrador usa para decidir
    // se o container está vivo — recusá-los aqui transformaria sobrecarga em
    // reinício, e o serviço voltaria sem ter melhorado nada. `/observability`
    // fica pelo mesmo motivo: sem ele não há como diagnosticar a rajada que o
    // limite acabou de registrar.
    bypassPaths: ['/health', '/readiness', '/observability', '/api-docs']
  },

  // Timeouts
  timeout: {
    server: parsePositiveEnvNumber(process.env.SERVER_TIMEOUT, 30000),
    headers: httpHeadersTimeout,
    request: httpRequestTimeout,
    keepAlive: parsePositiveEnvNumber(process.env.HTTP_KEEP_ALIVE_TIMEOUT, 5000),
    connectionsCheckingInterval: parsePositiveEnvNumber(process.env.HTTP_CONNECTIONS_CHECKING_INTERVAL, 1000),
    maxRequestsPerSocket: parsePositiveEnvNumber(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 1000),
    maxHeadersCount: parsePositiveEnvNumber(process.env.HTTP_MAX_HEADERS_COUNT, 100),
    gracefulShutdown: parsePositiveEnvNumber(process.env.GRACEFUL_SHUTDOWN_TIMEOUT, 5000)
  },

  // Confiança em cabeçalhos de proxy
  proxy: {
    /**
     * `false` (padrão) é a postura segura: `X-Forwarded-For` é controlado por
     * quem fala com o Node, então, sem proxy declarado, aceitar o cabeçalho
     * deixaria qualquer cliente forjar `req.ip` e burlar o rate limit por IP.
     *
     * Atrás de proxy/load balancer, configure `TRUST_PROXY` com o número de
     * saltos (`1`) ou com a faixa de CIDR do proxy. Nunca use `true` (= confiar
     * em toda a cadeia) sem um proxy reverso que reescreva o cabeçalho.
     */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY)
  }
};

/**
 * Configurações de banco de dados
 */
export const databaseConfig = {
  // `mongoConfig` é a fonte única: pool, timeouts, credencial e TLS saem de lá
  // para `mongoose.connect` (connection.ts). Declarar as mesmas opções aqui
  // criava um segundo lugar para a mesma verdade, e um lugar que ninguém lia.
  mongodb: getMongoConfig(),

  redis: {
    ...getRedisConfig()
  }
};

/**
 * Configurações de segurança
 */

/**
 * Logins simultâneos que o serviço precisa absorver sem trocar de hash.
 *
 * É o número que decide o teto de memória do argon2id: `memoryCost` KiB por
 * hash, vezes logins concorrentes, tem que caber no container. Não é uma
 * constante arbitrária — é a concorrência que o serviço já o serviço entrega sem
 * fila perceptível (medido em `docs/metricas.md`), e o que passar disso é
 * traffic shaping, não parameter de hash.
 */
const MAX_CONCURRENT_LOGINS = 8;

/**
 * Memória disponível para hashes do argon2id, em KiB.
 *
 * 1 GiB (`mem_limit` do compose) menos 256 MiB de folga para o runtime Node,
 * conexões, buffer de request e o que o /health considera estrutura do
 * processo. Medido: em repouso o serviço fica em ~52 MiB, e 8 logins com
 * `m=64MiB` sobem para ~512 MiB.
 */
const ARGON2_MEMORY_BUDGET_KIB = 786432;

// `isProduction` é derivado aqui (antes de `environmentConfig`) porque a
// política de revogação depende do ambiente já na leitura das configs.
const isProductionEnv = (process.env.NODE_ENV || 'development') === 'production';

// Política de revogação quando o Redis (blacklist) está indisponível:
//   false (padrão em produção) = fail-closed: nega operações que dependem de
//                               revogação, preservando segurança sobre disponibilidade.
//   true  (padrão em dev/test) = fail-open: mantém disponibilidade, aceitando
//                               que tokens revogados não sejam barrados.
const sessionFailOpenEnv = process.env.SESSION_FAIL_OPEN;

// Algoritmo de assinatura dos tokens.
//
// ES256 (assimétrico) é o alvo: quem assina tem a chave privada, quem verifica
// só a pública. HS256 continua disponível em dev/test, onde não há KMS para
// guardar chave assimétrica e onde os testes fabricam token legado.
//
// A escolha não é do arquivo: em produção, HS256 é recusado na validação.
const jwtAlgorithm = (process.env.JWT_ALGORITHM || (isProductionEnv ? 'ES256' : 'HS256')).toUpperCase();

/**
 * Lê uma chave PEM de variável de ambiente ou de arquivo.
 *
 * PEM tem quebras de linha, e variável de ambiente não. Aceitamos as duas
 * formas que aparecem em arquivo `.env`: `\n` literal, ou base64 do PEM.
 *
 * A variante `<NOME>_PATH` existe porque chave privada não deveria viajar como
 * texto de configuração: em produção ela é montada como arquivo (secret do
 * Docker, volume do Kubernetes, saída do KMS) e o processo recebe só o caminho.
 */
const readPem = (name: string): string | undefined => {
  const raw = process.env[name];
  if (raw) {
    if (raw.includes('-----BEGIN')) {
      return raw.replace(/\\n/g, '\n');
    }
    try {
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  const path = process.env[`${name}_PATH`];
  if (path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      // A causa importa e não é sempre "não configurado": um arquivo montado
      // pelo Docker com o dono do host em modo 600 é, para o processo que roda
      // como outro usuário, ilegível. Dizer "é obrigatório" nesse caso manda o
      // operador atrás da variável de ambiente enquanto o defeito é permissão
      // no arquivo.
      const code = (error as NodeJS.ErrnoException).code;
      const cause = code === 'ENOENT'
        ? 'arquivo não encontrado'
        : code === 'EACCES'
          ? 'sem permissão de leitura (no container, o dono do arquivo é o do host: use scripts/generate-jwt-keys.sh --for-container)'
          : code || 'falha desconhecida';
      logger.error(`Falha ao ler a chave em ${name}_PATH: ${path} — ${cause}`);
      return undefined;
    }
  }

  return undefined;
};

/**
 * Pepper lido do ambiente: segredo + versão, ou o motivo da recusa.
 *
 * A forma é a que `PasswordHasher` consome (tipagem estrutural), declarada aqui
 * para a config não depender da camada de infraestrutura. O `ok: false` existe
 * para que uma configuração inválida vire erro de arranque reportado, e não
 * exceção no import.
 */
type PepperEnvConfig =
  | { ok: true; version: string; secret: string }
  | { ok: false; error: string };

/**
 * Lê um pepper: segredo + versão que fica gravada dentro do hash.
 *
 * Diferente da chave PEM, o segredo é lido cru — pepper é bytes, não um
 * documento. O caminho (`<NOME>_PATH`) existe pelo mesmo motivo da chave
 * privada: em produção o segredo vem montado como secret do Docker, e
 * `docker inspect` não deveria mostrar nada que valha.
 *
 * Erro de configuração NÃO é lançado aqui: este módulo é importado no topo da
 * árvore e uma exceção nessa hora morre fora do `validateConfiguration`, que é
 * onde as demais validações são reportadas. O problema volta como `ok: false`
 * e o arranque recusa com a lista completa.
 */
const readPepper = (name: string, versionName: string, defaultVersion?: string): PepperEnvConfig | undefined => {
  const raw = process.env[name];
  const path = process.env[`${name}_PATH`];

  let secret: string | undefined;
  if (raw) {
    secret = raw;
  } else if (path) {
    try {
      secret = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const cause = code === 'ENOENT'
        ? 'arquivo não encontrado'
        : code === 'EACCES'
          ? 'sem permissão de leitura'
          : code || 'falha desconhecida';
      logger.error(`Falha ao ler o segredo em ${name}_PATH: ${path} — ${cause}`);
      return { ok: false, error: `${name}_PATH não pôde ser lido: ${cause}` };
    }
  }

  if (!secret || !secret.trim()) {
    return undefined;
  }

  const version = process.env[versionName]?.trim() || defaultVersion;
  if (!version) {
    return {
      ok: false,
      error: `${name} está configurado mas ${versionName} não: a versão do pepper é o que ` +
        'permite verificar hashes antigos depois de uma rotação'
    };
  }

  if (!/^p\d+$/.test(version)) {
    return { ok: false, error: `${versionName}="${version}" é inválido: use o formato pN (ex.: p1)` };
  }

  return { ok: true, version, secret: secret.trim() };
};

export const securityConfig = {
  jwt: {
    algorithm: jwtAlgorithm,
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    /**
     * Material ES256. `kid` identifica a chave no header do token: é o que
     * permite trocar a chave de assinatura sem derrubar os tokens já emitidos,
     * porque o verificador sabe qual chave conferir em vez de testar todas.
     */
    es256: {
      kid: process.env.JWT_ES256_KID || 'v1',
      privateKey: readPem('JWT_ES256_PRIVATE_KEY'),
      publicKey: readPem('JWT_ES256_PUBLIC_KEY'),
      // Janela de rotação: a chave anterior continua verificando.
      previousKid: process.env.JWT_ES256_PREVIOUS_KID,
      previousPublicKey: readPem('JWT_ES256_PREVIOUS_PUBLIC_KEY')
    },
    expiresIn: process.env.JWT_EXPIRES || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
    issuer: process.env.JWT_ISSUER || 'auth-service',
    audience: process.env.JWT_AUDIENCE || 'api-users'
  },

  dashboardToken: process.env.SECURITY_DASHBOARD_TOKEN,

  session: {
    failOpen: sessionFailOpenEnv === undefined
      ? !isProductionEnv
      : sessionFailOpenEnv === 'true',
    autoRevokeOnRefreshReuse: process.env.AUTO_REVOKE_ON_REUSE !== 'false'
  },

  /**
   * Hash de senha (D16).
   *
   * `algorithm` decide o que é *gravado*; a verificação é sempre automática pelo
   * formato do hash guardado, então subir o custo migra a base sem ninguém ser
   * trancado fora: cada usuário é reescrito no próximo login.
   *
   * Os padrões do argon2id foram escolhidos por medição no server01 (i5-7200U,
   * 2.0 CPU, 1 GiB): m=64MiB, t=1, p=1. Isso é 3.4x a memória por tentativa que
   * um atacante precisa gastar em relação aos m=19MiB, t=2 da OWASP, e entrega
   * a mesma latência de login (p95 de 81 ms contra 84 ms). Ver `docs/metricas.md`.
   */
  passwordHash: {
    algorithm: 'argon2id' as const,
    argon2: {
      // KiB. 65536 = 64 MiB.
      memoryCost: parseEnvNumber(process.env.ARGON2_MEMORY_COST, 65536),
      timeCost: parseEnvNumber(process.env.ARGON2_TIME_COST, 1),
      parallelism: parseEnvNumber(process.env.ARGON2_PARALLELISM, 1)
    },
    /**
     * Pepper (HMAC-SHA256 antes do hash). Desligado por padrão: só protege se
     * pepper e hash não saírem juntos, e o ganho é defesa em profundidade. Ver
     * `D17` em `docs/SEGURANCA.md`.
     */
    pepper: readPepper('PASSWORD_PEPPER', 'PASSWORD_PEPPER_VERSION', 'p1'),
    /**
     * Pepper anterior, para verificar hashes já gravados durante uma rotação.
     * Quem não voltar a fazer login não pode ser derrubado por uma rotação.
     */
    previousPepper: readPepper('PASSWORD_PEPPER_PREVIOUS', 'PASSWORD_PEPPER_PREVIOUS_VERSION')
  },

  cors: {
    // ✅ REMOVIDO: CORS origins agora vem APENAS do .env
    // Nunca adicione URLs hardcoded aqui - configure em variáveis de ambiente
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map(origin => origin.trim()),
    credentials: true
  }
};

/**
 * Configurações de monitoramento e logging
 */
export const monitoringConfig = {
  healthCheck: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    endpoint: process.env.HEALTH_CHECK_ENDPOINT || '/health'
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'console' // console, structured
  }
};

/**
 * Configurações de desenvolvimento/produção
 */
export const environmentConfig = {
  isDevelopment: serverConfig.nodeEnv === 'development',
  isProduction: serverConfig.nodeEnv === 'production',
  isTest: serverConfig.nodeEnv === 'test',

  // Features toggles
  features: {
    swagger: process.env.SWAGGER_ENABLED !== 'false',
    clustering: serverConfig.cluster.enabled,
    ssl: serverConfig.ssl.enabled,
    redis: databaseConfig.redis.enabled
  }
};

/**
 * Credenciais e transporte das dependências (Fase 1.3, decisão D18).
 *
 * Em produção, o app recusa o arranque quando o Mongo ou o Redis aceitam
 * conexão anônima. A justificativa é a mesma do ES256 e do argon2id:
 * configuração errada aqui não degrada a proteção, ela a remove — banco e cache
 * sem senha são abertos para qualquer processo que alcance a rede, e o que o
 * serviço guarda neles (hashes de senha, blacklist de JWT, contadores de rate
 * limit) é justamente o que não pode ser lido por terceiro.
 *
 * O transporte é a outra metade da decisão, e ela é binária de propósito:
 *
 *   - TLS no caminho (MONGODB_TLS/REDIS_TLS, ou `rediss://`/`mongodb+srv://`);
 *   - ou rede dedicada e sem porta publicada, com o operador assumindo isso por
 *     escrito em `DEPENDENCY_NETWORK_ISOLATED=true`.
 *
 * "Ambas" nunca é a resposta certain: sem TLS e com a rede compartilhada, a
 * senha das dependências atravessa o mesmo caminho em texto claro.
 */
function validateDependencyCredentials(): string[] {
  const errors: string[] = [];
  const mongo = databaseConfig.mongodb;
  const redis = databaseConfig.redis;

  // Segredo ilegível é falha de provisionamento, e vale em qualquer ambiente:
  // quem provisionou achou que configurou a senha.
  if (mongo.authError) {
    errors.push(mongo.authError);
  }
  if (redis.passwordError) {
    errors.push(redis.passwordError);
  }

  // Duas fontes de credencial para a mesma conexão: o driver escolhe uma e o
  // operador acredita na outra.
  if (mongo.credentialsConflict) {
    errors.push('URI_MONGODB já traz credencial e MONGODB_USER/MONGODB_PASSWORD também estão definidas: use uma forma só');
  }
  if (redis.credentialsConflict) {
    errors.push('REDIS_URL já traz credencial e REDIS_USERNAME/REDIS_PASSWORD também estão definidas: use uma forma só');
  }

  // Credencial pela metade: usuário sem senha (ou senha sem usuário) não
  // autentica ninguém, e o sintoma só apareceria no primeiro acesso que falhasse.
  if (process.env.MONGODB_USER && !mongo.auth) {
    errors.push('MONGODB_USER exige MONGODB_PASSWORD (ou MONGODB_PASSWORD_PATH)');
  }
  if (process.env.MONGODB_PASSWORD && !mongo.auth) {
    errors.push('MONGODB_PASSWORD exige MONGODB_USER');
  }

  if (!environmentConfig.isProduction) {
    return errors;
  }

  if (mongo.uri && !mongo.auth && !mongo.uriHasCredentials) {
    errors.push('MongoDB sem credencial não é permitido em produção: defina MONGODB_USER e MONGODB_PASSWORD (ou MONGODB_PASSWORD_PATH), ou credencial na URI');
  }

  if (redis.enabled && !redis.password && !redis.urlHasCredentials) {
    errors.push('Redis sem senha não é permitido em produção: defina REDIS_PASSWORD (ou REDIS_PASSWORD_PATH) com REDIS_USERNAME, ou credencial na REDIS_URL');
  }

  const internalNetwork = process.env.DEPENDENCY_NETWORK_ISOLATED === 'true';
  if (mongo.uri && !mongo.tls && !internalNetwork) {
    errors.push('Conexão com o MongoDB sem TLS em produção: use MONGODB_TLS=true, uma URI mongodb+srv://, ou DEPENDENCY_NETWORK_ISOLATED=true assumindo rede dedicada sem porta publicada');
  }
  if (redis.enabled && !redis.tls && !internalNetwork) {
    errors.push('Conexão com o Redis sem TLS em produção: use REDIS_TLS=true, uma URL rediss://, ou DEPENDENCY_NETWORK_ISOLATED=true assumindo rede dedicada sem porta publicada');
  }

  return errors;
}

/**
 * Validação de configurações obrigatórias
 */
export function validateConfiguration(): boolean {
  const errors: string[] = [];

  const jwt = securityConfig.jwt;
  const es256Enabled = jwt.algorithm === 'ES256';

  // --- Algoritmo de assinatura ------------------------------------------------
  // HS256 em produção significaria que todo processo que verifica um token
  // carrega o segredo que o assina: um dump de memória vira forge de token.
  // Por isso a recusa é explícita, e não um aviso.
  if (!['ES256', 'HS256'].includes(jwt.algorithm)) {
    errors.push(`JWT_ALGORITHM deve ser ES256 ou HS256 (recebido: ${jwt.algorithm})`);
  } else if (environmentConfig.isProduction && jwt.algorithm !== 'ES256') {
    errors.push('JWT_ALGORITHM=HS256 não é permitido em produção: use ES256 (chave privada assina, pública verifica)');
  }

  if (es256Enabled) {
    if (!jwt.es256.privateKey) {
      errors.push('JWT_ES256_PRIVATE_KEY é obrigatório com JWT_ALGORITHM=ES256');
    }
    if (!jwt.es256.publicKey) {
      errors.push('JWT_ES256_PUBLIC_KEY é obrigatório com JWT_ALGORITHM=ES256');
    }
    // Chave anterior sem `kid` (ou vice-versa) é rotação pela metade: a chave
    // antiga não entraria no mapa de verificação e derrubaria tokens vivos.
    if (jwt.es256.previousPublicKey && !jwt.es256.previousKid) {
      errors.push('JWT_ES256_PREVIOUS_KID é obrigatório quando JWT_ES256_PREVIOUS_PUBLIC_KEY está definida');
    }
    if (jwt.es256.previousKid && !jwt.es256.previousPublicKey) {
      errors.push('JWT_ES256_PREVIOUS_PUBLIC_KEY é obrigatório quando JWT_ES256_PREVIOUS_KID está definido');
    }
    if (jwt.es256.previousKid && jwt.es256.previousKid === jwt.es256.kid) {
      errors.push('JWT_ES256_PREVIOUS_KID deve ser diferente de JWT_ES256_KID');
    }
  }

  // Segredos simétricos só são exigidos no caminho HS256; com ES256 eles são
  // residuais de configuração e não devem passar a ser condição de arranque.
  if (!es256Enabled) {
    if (!jwt.secret) {
      errors.push('JWT_SECRET é obrigatório');
    }
    if (jwt.secret && jwt.secret.length < 32) {
      errors.push('JWT_SECRET deve ter pelo menos 32 caracteres');
    }
    if (environmentConfig.isProduction && !jwt.refreshSecret) {
      errors.push('JWT_REFRESH_SECRET é obrigatório em produção');
    }
    if (jwt.refreshSecret && jwt.refreshSecret.length < 32) {
      errors.push('JWT_REFRESH_SECRET deve ter pelo menos 32 caracteres');
    }
    if (environmentConfig.isProduction && jwt.refreshSecret && jwt.refreshSecret === jwt.secret) {
      errors.push('JWT_REFRESH_SECRET deve ser diferente de JWT_SECRET');
    }
  }

  // --- Hash de senha -----------------------------------------------------------
  // Uma configuração errada aqui não degrada a proteção, ela a remove: custo
  // zero de argon2 (m=0) ou `p` alto transformam o hash em algotrivial de
  // quebrar. Por isso os limites são recusados na largada, não avisados.
  const passwordHash = securityConfig.passwordHash;

  const { memoryCost, timeCost, parallelism } = passwordHash.argon2;

  if (memoryCost < 8192) {
    errors.push('ARGON2_MEMORY_COST deve ser pelo menos 8192 KiB (8 MiB): abaixo disso o hash não é memory-hard');
  }
  if (timeCost < 1) {
    errors.push('ARGON2_TIME_COST deve ser pelo menos 1');
  }
  if (parallelism < 1) {
    errors.push('ARGON2_PARALLELISM deve ser pelo menos 1');
  }
  // 8 logins simultâneos consomem o mesmo teto que 1 login consome o dobro:
  // o que importa é memória × concorrência caber no container, não o número
  // de um hash sozinho. O teto vem do `mem_limit` do compose (1 GiB) menos a
  // folga que o framework precisa, e não de um dogma de parâmetro. Com o
  // padrão de 64 MiB, 8 logins usam 512 MiB dos 768 MiB: sobra ~33% de folga
  // para o runtime, e 96 MiB seria recusado aqui.
  if (memoryCost * MAX_CONCURRENT_LOGINS > ARGON2_MEMORY_BUDGET_KIB) {
    errors.push(
      `ARGON2_MEMORY_COST/ARGON2_PARALLELISM altos demais: ${MAX_CONCURRENT_LOGINS} logins ` +
      `simultâneos pediriam ${(memoryCost * MAX_CONCURRENT_LOGINS / 1024).toFixed(0)} MiB, ` +
      `acima do orçamento de ${(ARGON2_MEMORY_BUDGET_KIB / 1024).toFixed(0)} MiB do container ` +
      '(veja docs/metricas.md)'
    );
  }

  // Pepper mal configurado impede a verificação dos hashes já gravados. Recusar
  // no arranque é melhor do que descobrir isso no primeiro login de um usuário
  // que não mudou de senha — e cujo hash pepperado ninguém consegue ler.
  for (const pepper of [passwordHash.pepper, passwordHash.previousPepper]) {
    if (pepper && !pepper.ok) {
      errors.push(pepper.error);
    }
  }

  // Validações obrigatórias
  if (environmentConfig.isProduction && !securityConfig.dashboardToken) {
    errors.push('SECURITY_DASHBOARD_TOKEN é obrigatório em produção');
  }

  if (environmentConfig.isProduction && securityConfig.dashboardToken && securityConfig.dashboardToken.length < 32) {
    errors.push('SECURITY_DASHBOARD_TOKEN deve ter pelo menos 32 caracteres em produção');
  }

  if (!databaseConfig.mongodb.uri) {
    errors.push('URI_MONGODB é obrigatório');
  }

  errors.push(...validateDependencyCredentials());

  // Validações de cluster
  if (serverConfig.cluster.workers < 1) {
    errors.push('CLUSTER_WORKERS deve ser pelo menos 1');
  }

  if (serverConfig.cluster.workers > serverConfig.cluster.maxWorkers) {
    errors.push('CLUSTER_WORKERS não pode ser maior que CLUSTER_MAX_WORKERS');
  }

  // Validações de SSL em produção
  if (environmentConfig.isProduction && !serverConfig.ssl.enabled) {
    logger.warn('⚠️ SSL não está habilitado em produção');
  }

  if (errors.length > 0) {
    throw new Error(`Configuração inválida:\n${errors.map(err => `- ${err}`).join('\n')}`);
  }

  return true;
}

/**
 * Pepper pronto para o adapter, ou `undefined` se não houver.
 *
 * A extração acontece aqui porque a validação de formato já ocorreu na leitura
 * (D17): o `validateConfiguration` recusa o arranque antes de este valor ser
 * usado, então o que sobra é sempre `{ version, secret }` ou nada.
 */
export function pepperConfigFor(
  value: ReturnType<typeof readPepper>
): { version: string; secret: string } | undefined {
  return value && value.ok ? { version: value.version, secret: value.secret } : undefined;
}

/**
 * Função para obter configuração completa
 */
export function getAppConfig() {
  return {
    server: serverConfig,
    database: databaseConfig,
    security: securityConfig,
    monitoring: monitoringConfig,
    environment: environmentConfig
  };
}

/**
 * Função para debug das configurações (sem dados sensíveis)
 */
export function getConfigSummary() {
  return {
    server: {
      port: serverConfig.port,
      host: serverConfig.host,
      nodeEnv: serverConfig.nodeEnv,
      ssl: serverConfig.ssl.enabled,
      cluster: {
        enabled: serverConfig.cluster.enabled,
        workers: serverConfig.cluster.workers
      }
    },
    database: {
      mongodb: !!databaseConfig.mongodb.uri,
      redis: databaseConfig.redis.enabled
    },
    security: {
      jwt: {
        algorithm: securityConfig.jwt.algorithm,
        kid: securityConfig.jwt.es256.kid,
        // `true` significa "existe segredo simétrico"; com ES256 o que importa
        // é haver chave assimétrica, e reportar `jwt: false` seria alarme falso.
        symmetricSecret: !!securityConfig.jwt.secret,
        refreshJwt: !!securityConfig.jwt.refreshSecret,
        es256: securityConfig.jwt.algorithm === 'ES256'
      },
      dashboardTokenConfigured: Boolean(securityConfig.dashboardToken),
      passwordHash: {
        algorithm: securityConfig.passwordHash.algorithm,
        argon2: securityConfig.passwordHash.argon2,
        pepperConfigured: Boolean(securityConfig.passwordHash.pepper),
        previousPepperConfigured: Boolean(securityConfig.passwordHash.previousPepper)
      }
    },
    session: {
      // false = fail-closed (recomendado em produção): sem Redis, operações
      // que dependem de revogação são negadas em vez de aceitas sem controle.
      failOpen: securityConfig.session.failOpen
    },
    features: environmentConfig.features
  };
}
