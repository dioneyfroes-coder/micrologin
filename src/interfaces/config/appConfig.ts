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
import { DEFAULT_ARGON2_CONCURRENCY, DEFAULT_ARGON2_QUEUE } from '../../shared/utils/argon2Limiter.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Se o processo é gerenciado por um PROCESS MANAGER (PM2), e por quantos.
 *
 * PM2 injeta `pm_id` (e `NODE_APP_INSTANCE`) em cada processo que ele gerencia.
 * O app nunca define nenhuma das duas, então a presença é a assinatura — não
 * há como um app "parecer" gerenciado sem estar.
 *
 * Isto existe para a exclusão mútua: quem gerencia os processos E quem os
 * multiplica não podem ser dois. Com os dois ativos, cada instância do PM2
 * ainda forka os N workers do cluster module: PM2_instances × workers
 * processos, cada um com os ~392.9 MB de RSS medidos no pico do `/login`. Com
 * os defaults (4 instâncias, 4 workers) são 16 processos — 4× o teto de 1 GiB
 * do container, e o PM2 reiniciando o que morre de falta de memória, em ciclo.
 * A garantia não pode ser "está no .env.prod": o `.env` é sobrescrito e o
 * `ecosystem.config.cjs` pode ser editado sem que nada reclame. Precisa ser o
 * processo recusando o arranque.
 */
const detectProcessManager = (): { manager: 'pm2' | 'node'; instances: number } => {
  // `pm_id` sozinho já basta e é o mais confiável. As outras duas entradas
  // cobrem o `exec_mode: 'fork'` do PM2 e o invocation direto, onde o app pode
  // ser filho de um PM2 sem pm_id no ambiente herdado do bootstrap.
  const underPm2 = process.env.pm_id !== undefined
    || process.env.NODE_APP_INSTANCE !== undefined
    || process.env.pm_exec_path !== undefined;

  // `NODE_APP_INSTANCE` é o ÍNDICE da instância (0-based), não a contagem. Com
  // PM2_INSTANCES=4, a última instância tem NODE_APP_INSTANCE=3 — tratar o
  // índice como contagem subestimaria o total, e a mensagem de erro prometeria
  // "3 processos" onde existem 4 (× os workers). `PM2_INSTANCES` é a contagem
  // que o operador digitou; o índice só confirma que o PM2 está no comando.
  return {
    manager: underPm2 ? 'pm2' : 'node',
    instances: underPm2
      ? Math.max(1, parseEnvNumber(process.env.PM2_INSTANCES, 0)
        || parseEnvNumber(process.env.NODE_APP_INSTANCE, 0) + 1
        || 1)
      : 0
  };
};

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
    // Quem está no comando de multiplicar processos. `pm2` significa que o
    // cluster module NÃO pode ser o multiplicador (ver `clusterConflict`).
    processManager: detectProcessManager().manager,
    processManagerInstances: detectProcessManager().instances,
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
    listenBacklog: parsePositiveEnvNumber(process.env.HTTP_LISTEN_BACKLOG, 1024),
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
 * Teto de operações argon2id SIMULTÂNEAS por processo.
 *
 * Este número não é mais uma constante decorativa: ele é o limite que
 * `src/shared/utils/argon2Limiter.ts` IMPÕE em tempo de execução, e é também o
 * multiplicador da conta de memória abaixo. Antes eram duas verdades — uma
 * imposta (nenhuma) e outra orçada (esta) — e a diferença entre elas era
 * exatamente o buraco que um burst de login atravessava.
 *
 * O default é 8 por medição, não por dogma: é a concorrência que o serviço
 * entrega sem fila perceptível (ver `docs/metricas.md`), e com `m=64MiB` são
 * 512 MiB dos 768 MiB do orçamento do container.
 */
const ARGON2_MAX_CONCURRENCY = parseEnvNumber(
  process.env.ARGON2_MAX_CONCURRENCY,
  DEFAULT_ARGON2_CONCURRENCY
);

/**
 * Profundidade da fila de espera do semáforo argon2id.
 */
const ARGON2_MAX_QUEUE = parseEnvNumber(
  process.env.ARGON2_MAX_QUEUE,
  DEFAULT_ARGON2_QUEUE
);

/**
 * Memória disponível para hashes do argon2id, em KiB.
 *
 * 1 GiB (`mem_limit` do compose) menos 256 MiB de folga para o runtime Node,
 * conexões, buffer de request e o que o /health considera estrutura do
 * processo. Medido: em repouso o serviço fica em ~52 MiB, e 8 logins com
 * `m=64MiB` sobem para ~512 MiB.
 *
 * O orçamento conta `memoryCost × ARGON2_MAX_CONCURRENCY` porque é exatamente
 * o que o semáforo permite acontecer ao mesmo tempo. Se a conta usasse um
 * número maior que o aplicado, ela continuaria "verde" com a máquina estourando
 * o container; se usasse um menor, ela derrubaria arranjos que rodam folgados.
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
// Em produção o fail-open é recusado na validação (`SESSION_FAIL_OPEN=true`
// derruba o arranque): a política é fail-closed por construção, não por default.
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
    previousPepper: readPepper('PASSWORD_PEPPER_PREVIOUS', 'PASSWORD_PEPPER_PREVIOUS_VERSION'),

    /**
     * Limite de execução do argon2id (`argon2Limiter`), e não do HTTP.
     *
     * Fica dentro de `passwordHash` porque é orçamento DE MEMÓRIA do argon2id:
     * é este número que a validação de arranque multiplica por `memoryCost` para
     * decidir se o container aguenta. `serverConfig.inFlight` é outro teto, de
     * outro recurso, e os dois ficam de pé ao mesmo tempo.
     */
    concurrency: {
      limit: ARGON2_MAX_CONCURRENCY,
      maxQueue: ARGON2_MAX_QUEUE
    }
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
/**
 * Conflito entre PM2 e cluster module, ou `undefined` quando não há.
 *
 * Fonte única da verdade da exclusão mútua: tanto o `validateConfiguration`
 * quanto o ponto de forking do `app.ts` consultam ISTO. A alternativa — cada um
 * refazendo a conta — é como os dois passaram a divergir, e o ponto de forking
 * é justamente o que roda primeiro quando o cluster está ligado: o primary
 * forka sem nunca construir o `AuthService`, logo o `validateConfiguration` não
 * roda nesse caminho. Um guard só no `validateConfiguration` passaria verde
 * enquanto o processo multiplicava 16 vezes.
 */
export function clusterConflict(): string | undefined {
  const { manager, instances } = detectProcessManager();

  if (manager === 'pm2' && serverConfig.cluster.enabled) {
    return 'PM2 e cluster module não podem estar ativos ao mesmo tempo: '
      + `o PM2 já gerencia ${instances} processo(s) e cada um ainda forkaria `
      + `${serverConfig.cluster.workers} worker(s) do cluster module, dando `
      + `${instances * serverConfig.cluster.workers} processos no total. `
      + 'Escolha um dos dois multiplicadores — com PM2, mantenha '
      + 'CLUSTER_ENABLED=false; sem PM2, rode `node dist/app.js` e deixe o '
      + 'cluster module fazer o fork.';
  }

  return undefined;
}

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
  //
  // `concurrency.max` é o mesmo valor que `argon2Limiter` IMPÕE: se a conta
  // usasse um número diferente do aplicado, ela validaria um orçamento que a
  // máquina não respeita.
  const argon2Concurrency = passwordHash.concurrency.limit;

  if (argon2Concurrency < 1) {
    errors.push('ARGON2_MAX_CONCURRENCY deve ser pelo menos 1: com 0 o argon2id não tem teto e o orçamento de memória abaixo não descreve nada');
  }
  if (passwordHash.concurrency.maxQueue < 0) {
    errors.push('ARGON2_MAX_QUEUE não pode ser negativo');
  }

  if (memoryCost * argon2Concurrency > ARGON2_MEMORY_BUDGET_KIB) {
    errors.push(
      `ARGON2_MEMORY_COST/ARGON2_PARALLELISM altos demais: ${argon2Concurrency} logins ` +
      `simultâneos pediriam ${(memoryCost * argon2Concurrency / 1024).toFixed(0)} MiB, ` +
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

  // --- Política de revogação ---------------------------------------------------
  // Produção é fail-closed por construção, não por default. `SESSION_FAIL_OPEN=true`
  // desliga a única barreira entre um Redis fora do ar e aceitação de token
  // revogado, e um default que protege não adianta se um valor explícito
  // desliga a proteção sem custo. Quem precisa de fail-open é dev/teste, onde
  // ele já é o default.
  if (environmentConfig.isProduction && securityConfig.session.failOpen) {
    errors.push('SESSION_FAIL_OPEN=true não é permitido em produção: a política é fail-closed (remova a variável ou use SESSION_FAIL_OPEN=false)');
  }

  if (!databaseConfig.mongodb.uri) {
    errors.push('URI_MONGODB é obrigatório');
  }

  errors.push(...validateDependencyCredentials());

  // Validações de cluster
  // Exclusão mútua PM2 × cluster module. Recusa, e não aviso: os dois juntos
  // multiplicam processos sem limite superior conhecido, e o sintoma (OOM e
  // restart-loop) aparece longe da causa.
  const conflict = clusterConflict();
  if (conflict) {
    errors.push(conflict);
  }

  if (serverConfig.cluster.workers < 1) {
    errors.push('CLUSTER_WORKERS deve ser pelo menos 1');
  }

  if (serverConfig.cluster.workers > serverConfig.cluster.maxWorkers) {
    errors.push('CLUSTER_WORKERS não pode ser maior que CLUSTER_MAX_WORKERS');
  }

  // --- Confiança em cabeçalhos de proxy ---------------------------------------
  // `TRUST_PROXY=true` faz o Express aceitar `X-Forwarded-For` de qualquer
  // origem. Só é seguro quando existe um proxy reverso que **reescreve** o
  // cabeçalho com o IP real — e essa é uma propriedade da topologia, não do
  // processo: nada dentro do app consegue verificá-la. Um `logger.warn` some no
  // ruído do arranque e o serviço segue no ar com o rate limit por IP inútil
  // (um `X-Forwarded-For` novo por requisição = um orçamento novo).
  //
  // Por isso em produção a confiança irrestrita é recusada, e quem realmente a
  // quiser precisa dizer que a topologia sustenta a afirmação. O opt-in é
  // separado do valor de propósito: um deploy com `true` já configurado não
  // pode ser justificado por um default que muda sozinho.
  if (environmentConfig.isProduction && serverConfig.proxy.trustProxy === true) {
    const allowUnrestricted = (process.env.TRUST_PROXY_ALLOW_UNRESTRICTED ?? '').trim().toLowerCase() === 'true';

    if (!allowUnrestricted) {
      errors.push(
        'TRUST_PROXY=true é recusado em produção: use o número de saltos (TRUST_PROXY=1) ou a faixa CIDR do proxy. ' +
        'Só com um proxy reverso que reescreva X-Forwarded-For e nenhum outro caminho até o app, ' +
        'defina TRUST_PROXY_ALLOW_UNRESTRICTED=true para assumir essa responsabilidade.'
      );
    }
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
        // O limite real de hash, publicado para que o valor observado em
        // runtime possa ser conferido contra o valor que o orçamento orçou.
        argon2MaxConcurrency: securityConfig.passwordHash.concurrency.limit,
        argon2MaxQueue: securityConfig.passwordHash.concurrency.maxQueue,
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
