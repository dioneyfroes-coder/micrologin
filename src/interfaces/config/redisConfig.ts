/**
 * @fileoverview FONTE ÚNICA de configuração de REDIS.
 *
 * Resolve a conexão a partir de REDIS_URL (forma preferida, igual à
 * URI_MONGODB) ou, no fallback, das variáveis individuais REDIS_HOST/
 * REDIS_PORT/REDIS_PASSWORD/REDIS_DB. Assim os consumers (connection.js,
 * appConfig, rateLimitConfig) leem sempre os mesmos valores.
 *
 * Na Fase 1.3 entrou a parte que faltava para o Redis exigir credencial:
 * `REDIS_USERNAME` (usuário de ACL, para o login ser atribuível a alguém e
 * rotacionável sem derrubar quem está logado), `REDIS_PASSWORD_PATH` (senha em
 * arquivo, sem passar por `docker inspect`) e `REDIS_TLS`.
 *
 * Precedência de credencial: o que está dentro da `REDIS_URL` ganha, porque é
 * dela que o `node-redis` monta o `credentialsProvider` (medido em
 * `node_modules/@redis/client/dist/lib/client/index.js`, `#initiateOptions`).
 * As variáveis separadas só entram quando a URL não traz credencial. Ter as duas
 * é recusado na validação, não resolvido em silêncio.
 *
 * ⚠️ Não importa módulos do projeto para evitar ciclos de dependência.
 */

import { readSecret } from './secret.js';
import type { RedisClientOptions } from 'redis';

interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Usuário de ACL. `undefined` = usuário `default` do Redis. */
  username?: string;
  password?: string;
  /** Erro de leitura do segredo, quando há. */
  passwordError?: string;
  /** `true` quando a URL já traz usuário/senha. */
  urlHasCredentials: boolean;
  /** `true` quando a URL traz credencial E as variáveis separadas também. */
  credentialsConflict: boolean;
  tls: boolean;
  db: number;
  ttl: number;
  url: string | null;
}

/**
 * Converte string para número com fallback
 * @param value - Valor do .env
 * @param defaultValue - Valor padrão
 */
export const parseRedisEnvNumber = (value: string | undefined, defaultValue: number): number => {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Detecta usuário/senha dentro da URL do Redis.
 */
const redisUrlHasCredentials = (url: string | null): boolean => {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    // URL inválida é problema do `node-redis`, que recusa com mensagem melhor.
    return /^[a-z]+:\/\/[^/@]+:[^/@]*@/i.test(url);
  }
};

/**
 * Obtém configuração Redis atual lendo process.env no momento da chamada.
 */
export const getRedisConfig = (): RedisConfig => {
  const env = process.env;
  const host = env.REDIS_HOST || 'localhost';
  const port = parseRedisEnvNumber(env.REDIS_PORT, 6379);
  const passwordSecret = readSecret('REDIS_PASSWORD');
  const password = passwordSecret?.ok === true ? passwordSecret.value : undefined;
  const username = env.REDIS_USERNAME?.trim() || undefined;
  const url = env.REDIS_URL || null;
  const urlHasCredentials = redisUrlHasCredentials(url);

  return {
    enabled: env.REDIS_ENABLED !== 'false',
    host,
    port,
    username,
    password,
    passwordError: passwordSecret && !passwordSecret.ok ? passwordSecret.error : undefined,
    urlHasCredentials,
    credentialsConflict: urlHasCredentials && Boolean(username || password),
    // `rediss://` já liga TLS no driver; `REDIS_TLS` cobre o caso de URL
    // `redis://` apontando para um endpoint que já fala TLS.
    tls: url?.startsWith('rediss:') === true || env.REDIS_TLS === 'true',
    db: parseRedisEnvNumber(env.REDIS_DB, 0),
    ttl: parseRedisEnvNumber(env.REDIS_TTL, 3600),
    url
  };
};

export interface RedisConnectionOptions {
  url?: string;
  socket?: RedisClientOptions['socket'];
  username?: string;
  password?: string;
  database?: number;
}

/**
 * Monta as opções de conexão para o cliente node-redis (Redis 5.x).
 *
 * O tipo de retorno é o do próprio driver, e não um `{ tls?: boolean }`
 * genérico: a união de socket do `node-redis` exige `tls: true` (com `host`)
 * quando há TLS, e um booleano opcional não fecha com ela — o compilador
 * apontou isso. Montar o literal certo é mais honesto que um cast.
 * @returns Opções aceitas por redis.createClient()
 */
export const getRedisClientOptions = (): RedisClientOptions => {
  const config = getRedisConfig();

  const credentials: Pick<RedisClientOptions, 'username' | 'password'> = {};
  if (config.username) {
    credentials.username = config.username;
  }
  if (config.password) {
    credentials.password = config.password;
  }

  if (config.url) {
    // A URL e as variáveis separadas se completam: a URL traz host/porta/db
    // (e credencial, se tiver), o resto entra por cima. Antes isso devolvia só
    // `{ url }` e o `REDIS_PASSWORD` do host era descartado na mão do cliente —
    // a variável estava no .env e a senha nunca chegava ao servidor.
    //
    // O socket só é anexado quando o TLS precisa ser ligado por fora do esquema
    // (`redis://` + REDIS_TLS=true). Em `rediss://` o próprio driver liga, e um
    // host padrão aqui seria sobrescrito pelo host da URL de qualquer forma.
    return {
      url: config.url,
      ...credentials,
      ...(config.tls && { socket: { tls: true, host: config.host } })
    };
  }

  return {
    socket: config.tls
      ? { tls: true, host: config.host, port: config.port }
      : { host: config.host, port: config.port },
    ...credentials,
    database: config.db
  };
};
