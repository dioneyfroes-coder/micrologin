/**
 * @fileoverview Configuração de Cache com Redis
 *
 * Implementa conexão segura ao Redis com:
 * - Health check automático
 * - Fallback para memória se Redis não estiver disponível
 * - Reconexão automática
 * - Proteção de erros
 */

import redis, { RedisClientType, RedisDefaultModules, RedisClientOptions } from 'redis';
import { getRedisClientOptions, RedisConnectionOptions } from '../../interfaces/config/redisConfig.js';
import { logger } from '../../shared/utils/logger.js';

export type RedisClient = RedisClientType<RedisDefaultModules>;

let client: RedisClient | null = null;
let isHealthy = false;

/** Backoff de reconexão: 100ms dobrando, com teto de 5s. */
const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 5000;

/**
 * Inicializa conexão com Redis
 * @returns Cliente Redis ou null se falhar
 */
export const initRedis = async(): Promise<RedisClient | null> => {
  if (client && client.isReady) {
    return client;
  }

  // Cliente aberto e ainda reconectando: a estratégia abaixo já está cuidando
  // disso. Criar outro agora duplicaria a tentativa (e o log de erro) sem
  // adiantar a reconexão.
  if (client && client.isOpen) {
    return null;
  }

  try {
    const baseOptions: RedisConnectionOptions = getRedisClientOptions();

    const redisConfig: RedisClientOptions = {
      ...baseOptions,
      socket: {
        ...(baseOptions.socket || {}),
        // Reconecta para sempre, com backoff limitado a 5s.
        //
        // Desistir é o pior desfecho possível aqui: a política de revogação é
        // fail-closed, então um cliente morto com `isReady === false` deixa o
        // serviço inteiro devolvendo 503 até alguém reiniciar o processo. Bastava
        // uma queda de meio segundo para travar a autenticação de forma
        // permanente, e o único sinal disso era uma linha de log.
        // Quem tem prazo de vida para desistir é o processo, não a conexão.
        reconnectStrategy: (retries: number) => {
          const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** retries,
            RECONNECT_MAX_DELAY_MS
          );
          if (retries === 0) {
            logger.warn('⚠️ Redis desconectado, tentando reconectar');
          } else if (retries % 10 === 0) {
            logger.warn(`⚠️ Redis ainda indisponível após ${retries} tentativas (nova em ${delay}ms)`);
          }
          return delay;
        },
        connectTimeout: 10000
      }
    };

    const newClient: RedisClient = redis.createClient(redisConfig) as RedisClient;
    client = newClient;

    // `ready` também dispara na conexão inicial, não só nas reconexões. O
    // health check do `ready` roda em paralelo com o que `initRedis` faz logo
    // abaixo, e quem terminasse por último escreveria `isHealthy` — inclusive
    // sobrescrevendo um `true` válido com `false`, só porque o PING do handler
    // perdeu a corrida. A marca separa os dois momentos: enquanto a conexão
    // inicial não se assentou, quem responde por `isHealthy` é o `connect()`
    // abaixo.
    let initialConnectSettled = false;

    // Event handlers
    newClient.on('error', (err: Error) => {
      isHealthy = false;
      logger.error('❌ Redis Error', err);
    });

    newClient.on('end', () => {
      isHealthy = false;
      logger.warn('⚠️ Redis desconectado');
    });

    // Reconexão bem-sucedida: `isHealthy` foi zerado no `error`/`end` da queda e
    // nada o religava. Sem isto, o serviço voltava a funcionar mas continuava
    // reportando Redis degradado para sempre - e o rate limiter, que só promove
    // os limiters quando a conexão está utilizável, nunca voltava ao
    // armazenamento global.
    newClient.on('ready', () => {
      if (!initialConnectSettled) {
        return;
      }
      void performHealthCheck(newClient)
        .then((healthy) => {
          isHealthy = healthy;
          if (healthy) {
            logger.info('✅ Redis reconectado');
          } else {
            logger.warn('⚠️ Redis reconectou, mas o health check falhou');
          }
        })
        .catch((error: unknown) => {
          isHealthy = false;
          logger.error('❌ Redis reconectado com falha no health check', error);
        });
    });

    // Conectar ao Redis
    await newClient.connect();

    // ✅ HEALTH CHECK: Verificar conexão com PING
    const pingResult = await performHealthCheck(newClient);
    isHealthy = pingResult;
    initialConnectSettled = true;

    if (!isHealthy) {
      logger.warn('⚠️ Redis conectado mas health check falhou');
      client = null;
      return null;
    }

    return client;
  } catch (error) {
    isHealthy = false;
    logger.warn('⚠️ Redis não disponível, operando sem cache', error);
    logger.warn('   Funcionalidade de cache e rate limiting baseado em Redis será desabilitada');
    client = null;
    return null;
  }
};

let healthProbeSeq = 0;

/**
 * Realiza health check no Redis
 * @param redisClient - Cliente Redis
 * @returns True se healthy
 *
 * ## A sonda de escrita/leitura precisa de chave exclusiva
 *
 * A chave precisa ser EXCLUSIVA de cada sonda. Com uma chave fixa
 * (`__health_check__`), duas sondas concorrentes se atropelam: a sonda A escreve
 * o valor A, a sonda B sobrescreve com o valor B, a sonda A lê B e conclui que o
 * Redis "não responde a leitura/escrita". Isso foi medido, não suposto — sob
 * concorrência o `/health` respondia 503 em ~58% das chamadas (300 requisições
 * simultâneas: 173 em 503) com o Redis perfeitamente de pé, e o relatório dizia
 * "Redis conectado, mas não responde a leitura/escrita".
 *
 * Um health check que se sabota com a própria concorrência é pior do que um
 * health check ausente: ele derruba o container no orquestrador e/ou manda o
 * deploy reverter uma versão boa, por causa da própria medição.
 *
 * O sufixo é `pid` + contador, e não aleatório: dois processos nunca colidem
 * (o `pid` já basta entre processos) e, dentro de um processo, o contador
 * garante unicidade mesmo sob chamadas concorrentes. As chaves morrem sozinhas
 * pelo TTL, então o volume é limitado pela janela de TTL e não pelo total de
 * chamadas.
 */
export const performHealthCheck = async(redisClient: RedisClient): Promise<boolean> => {
  try {
    // PING é a forma mais básica de verificar conectividade
    const pongResponse = await redisClient.ping();

    if (pongResponse === 'PONG') {
      // Verificar adicionalmente se conseguimos ler/escrever
      const seq = healthProbeSeq++;
      const testKey = `__health_check__:${process.pid}:${seq}`;
      // O valor também carrega o número da sonda, e não só o relógio: com
      // `Date.now()` sozinho, duas sondas dentro do mesmo milissegundo teriam o
      // mesmo valor e a colisão passaria despercebida — inclusive num teste.
      const testValue = `${Date.now()}:${seq}`;

      await redisClient.setEx(testKey, 10, testValue);
      const retrieved = await redisClient.get(testKey);
      await redisClient.del(testKey);

      if (retrieved === testValue) {
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('❌ Redis health check falhou', error);
    return false;
  }
};

interface RedisStatus {
  isConnected: boolean;
  isHealthy: boolean;
  status: string;
  message: string;
}

/**
 * Obtém status do Redis
 */
export const getRedisStatus = (): RedisStatus => {
  return {
    isConnected: !!(client && client.isReady),
    isHealthy: isHealthy,
    status: client
      ? (client.isReady ? 'connected' : 'disconnecting')
      : 'disconnected',
    message: isHealthy ? '✅ Redis operacional' : '⚠️ Redis indisponível - usando fallback'
  };
};

/**
 * Valida se Redis está disponível e saudável
 */
export const isRedisAvailable = (): boolean => {
  return isHealthy && !!(client && client.isReady);
};

/**
 * Cache JWT Token com TTL automático
 * @param token - Token JWT
 * @param userData - Dados do usuário
 * @param ttl - Time to live em segundos (padrão: 3600)
 */
export const cacheJWT = async(token: string, userData: unknown, ttl = 3600): Promise<void> => {
  if (!isRedisAvailable() || !client) {
    return; // Fallback silencioso se Redis não estiver disponível
  }

  try {
    await client.setEx(
      `jwt:${token}`,
      ttl,
      JSON.stringify(userData)
    );
  } catch (error) {
    logger.error('❌ Erro ao salvar JWT em cache', error);
    // Continuar mesmo se falhar
  }
};

/**
 * Recupera JWT cacheado
 * @param token - Token JWT
 */
export const getCachedJWT = async(token: string): Promise<unknown | null> => {
  if (!isRedisAvailable() || !client) {
    return null;
  }

  try {
    const cached = await client.get(`jwt:${token}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.error('❌ Erro ao buscar JWT em cache', error);
    return null;
  }
};

/**
 * Limpa cache (chave específica ou tudo)
 * @param key - Chave a remover (null = limpar tudo)
 */
export const clearCache = async(key: string | null = null): Promise<void> => {
  if (!isRedisAvailable() || !client) {
    return;
  }

  try {
    if (key) {
      await client.del(key);
    } else {
      await client.flushDb();
    }
  } catch (error) {
    logger.error('❌ Erro ao limpar cache', error);
  }
};

/**
 * Desconecta do Redis
 *
 * Encerrar é o espelho de "nunca desistir": enquanto o processo vive, a
 * reconexão é tentada indefinidamente; quando ele vai embora, o cliente em
 * reconexão precisa perder o timer, ou o processo fica preso no event loop
 * esperando um Redis que não responde mais.
 */
export const disconnectRedis = async(): Promise<void> => {
  if (!client) {
    return;
  }

  // A referência sai antes do encerramento: um cliente que não respondeu ao
  // pedido de saída não pode continuar sendo considerado o cliente do processo.
  const current = client;
  client = null;
  isHealthy = false;

  if (!current.isOpen) {
    return;
  }

  try {
    if (current.isReady) {
      await current.quit();
    } else {
      // Socket em reconexão: `quit()` manda um comando que ninguém vai atender.
      // `destroy()` fecha na hora e cancela a reconexão pendente.
      current.destroy();
    }
  } catch (error) {
    logger.error('❌ Erro ao desconectar Redis', error);
    // Último recurso: sem isto, um `quit()` que falha deixa o timer de
    // reconexão vivo e o processo não encerra.
    try {
      current.destroy();
    } catch {
      // Cliente já destruído: nada a fazer.
    }
  }
};

/**
 * Retorna o cliente Redis
 */
export const getRedisClient = (): RedisClient | null => {
  return isRedisAvailable() ? client : null;
};
