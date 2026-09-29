/**
 * @fileoverview FONTE ÚNICA de configuração do MONGODB.
 *
 * Resolve a conexão a partir de `URI_MONGODB` mais as variáveis de credencial
 * `MONGODB_USER` / `MONGODB_PASSWORD` (ou `MONGODB_PASSWORD_PATH`), em vez de
 * exigir a senha embutida na URL. A diferença não é de conforto:
 *
 *   - a URI é logada. O driver inclui a credencial na mensagem de erro de
 *     autenticação e ela aparece em qualquer log de conexão;
 *   - o caminho do arquivo permite montar a senha como secret (modo 600), sem
 *     passar por `docker inspect`.
 *
 * O usuário é o mesmo para todas as requisições e recebe, no Mongo, papel de
 * menor privilégio sobre o banco da aplicação (Fase 1.3): um dump do processo
 * não entrega um `root` do banco.
 *
 * ⚠️ Não importa módulos do projeto para evitar ciclos de dependência.
 */

import { parseEnvNumber } from './rateLimitConfig.js';
import { readSecret } from './secret.js';

export interface MongoAuth {
  username: string;
  password: string;
  source: string;
}

export interface MongoConfig {
  uri: string | null;
  /** Credenciais vindas das variáveis separadas. */
  auth?: MongoAuth;
  /** `true` quando a própria URI já carrega usuário/senha. */
  uriHasCredentials: boolean;
  /** `true` quando a URI carrega credencial E as variáveis também. */
  credentialsConflict: boolean;
  /** Erro de leitura do segredo, quando há. */
  authError?: string;
  tls: boolean;
  maxPoolSize: number;
  serverSelectionTimeoutMS: number;
  socketTimeoutMS: number;
}

export interface MongoClientOptions {
  uri: string;
  options: Record<string, unknown>;
}

/**
 * Detecta usuário/senha dentro da URI sem exigir que ela seja válida.
 *
 * O driver aceita a credencial na URL e também no campo `auth`; quando as duas
 * vêm, quem vence é decidido dentro do driver, não por esta configuração. A
 * validação de produção recusa a ambiguidade em vez de escolher um lado.
 */
export const mongoUriHasCredentials = (uri: string | undefined | null): boolean => {
  if (!uri) {
    return false;
  }

  try {
    const parsed = new URL(uri);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    // URI que o Node não entende é problema do driver, que vai reclamar com
    // mensagem melhor. Aqui a pergunta é só se há credencial embutida.
    return /^[a-z+]+:\/\/[^/@]+:[^/@]*@/i.test(uri);
  }
};

/**
 * `mongodb+srv://` implica TLS por definição (é o que o Atlas exige); para os
 * demais casos quem decide é `MONGODB_TLS`.
 */
const isTlsByScheme = (uri: string | undefined | null): boolean => uri?.startsWith('mongodb+srv:') === true;

export const getMongoConfig = (): MongoConfig => {
  const env = process.env;
  const uri = env.URI_MONGODB || null;
  const uriHasCredentials = mongoUriHasCredentials(uri);

  const username = env.MONGODB_USER?.trim() || undefined;
  const passwordSecret = readSecret('MONGODB_PASSWORD');
  const password = passwordSecret?.ok === true ? passwordSecret.value : undefined;
  const authError = passwordSecret && !passwordSecret.ok ? passwordSecret.error : undefined;

  return {
    uri,
    auth: username && password
      ? { username, password, source: env.MONGODB_AUTH_SOURCE?.trim() || 'admin' }
      : undefined,
    uriHasCredentials,
    // Duas fontes de credencial ao mesmo tempo não é redundância: é a chance de
    // o operador rotacionar uma e o app continuar com a outra.
    credentialsConflict: uriHasCredentials && Boolean(username || password),
    authError,
    tls: isTlsByScheme(uri) || env.MONGODB_TLS === 'true',
    maxPoolSize: parseEnvNumber(env.MONGODB_MAX_POOL_SIZE, 10),
    serverSelectionTimeoutMS: parseEnvNumber(env.MONGODB_TIMEOUT, 5000),
    socketTimeoutMS: parseEnvNumber(env.MONGODB_SOCKET_TIMEOUT, 45000)
  };
};

/**
 * Monta o par (uri, opções) que o `mongoose.connect` recebe.
 *
 * As opções carregam o que `databaseConfig.mongodb.options` já declarava e não
 * era usado: pool e timeouts configurados e nunca aplicados eram configuração
 * morta, e `MONGODB_MAX_POOL_SIZE=25` em produção não fazia nada.
 */
export const getMongoClientOptions = (): MongoClientOptions => {
  const config = getMongoConfig();

  if (!config.uri) {
    return {
      uri: '',
      options: {}
    };
  }

  return {
    uri: config.uri,
    options: {
      maxPoolSize: config.maxPoolSize,
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
      socketTimeoutMS: config.socketTimeoutMS,
      ...(config.auth && {
        auth: { username: config.auth.username, password: config.auth.password },
        authSource: config.auth.source
      }),
      ...(config.tls && { tls: true })
    }
  };
};
