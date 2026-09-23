/**
 * @fileoverview FONTE ÚNICA de configuração de REDIS.
 *
 * Resolve a conexão a partir de REDIS_URL (forma preferida, igual à
 * URI_MONGODB) ou, no fallback, das variáveis individuais REDIS_HOST/
 * REDIS_PORT/REDIS_PASSWORD/REDIS_DB. Assim os consumers (connection.js,
 * appConfig, rateLimitConfig) leem sempre os mesmos valores.
 *
 * ⚠️ Não importa módulos do projeto para evitar ciclos de dependência.
 */

interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  password?: string;
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
 * Obtém configuração Redis atual lendo process.env no momento da chamada.
 */
export const getRedisConfig = (): RedisConfig => {
  const env = process.env;
  const host = env.REDIS_HOST || 'localhost';
  const port = parseRedisEnvNumber(env.REDIS_PORT, 6379);
  const password = env.REDIS_PASSWORD || undefined;
  const db = parseRedisEnvNumber(env.REDIS_DB, 0);

  return {
    enabled: env.REDIS_ENABLED !== 'false',
    host,
    port,
    password,
    db,
    ttl: parseRedisEnvNumber(env.REDIS_TTL, 3600),
    url: env.REDIS_URL || null
  };
};

export interface RedisConnectionOptions {
  url?: string;
  socket?: {
    host?: string;
    port?: number;
  };
  password?: string;
  database?: number;
}

/**
 * Monta as opções de conexão para o cliente node-redis (Redis 5.x).
 * Usa URL quando disponível; senão monta via socket.host/socket.port.
 * @returns Opções aceitas por redis.createClient()
 */
export const getRedisClientOptions = (): RedisConnectionOptions => {
  const config = getRedisConfig();

  if (config.url) {
    return { url: config.url };
  }

  return {
    socket: {
      host: config.host,
      port: config.port
    },
    ...(config.password && { password: config.password }),
    database: config.db
  };
};
