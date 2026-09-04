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

/**
 * Converte string para número com fallback
 * @param {string} value - Valor do .env
 * @param {number} defaultValue - Valor padrão
 * @returns {number}
 */
export const parseRedisEnvNumber = (value, defaultValue) => {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Obtém configuração Redis atual lendo process.env no momento da chamada.
 * @returns {Object} Configuração resolvida
 */
export const getRedisConfig = () => {
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

/**
 * Monta as opções de conexão para o cliente node-redis.
 * @returns {Object} Opções aceitas por redis.createClient()
 */
export const getRedisClientOptions = () => {
  const config = getRedisConfig();

  if (config.url) {
    return { url: config.url };
  }

  return {
    host: config.host,
    port: config.port,
    ...(config.password && { password: config.password }),
    db: config.db
  };
};
