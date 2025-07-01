// Em config/cache.js
import redis from 'redis';

let client;

export const initRedis = async() => {
  if (client && client.isReady) {
    return client; // ✅ Retornar se já conectado
  }

  client = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  });

  client.on('error', (err) => {
    console.error('❌ Erro no Redis:', err);
  });

  client.on('connect', () => {
    console.log('✅ Conectado ao Redis!');
  });

  try {
    await client.connect();
    return client; // ✅ RETORNAR o client
  } catch (error) {
    console.warn('⚠️ Redis não disponível, cache desabilitado:', error.message);
    return null; // ✅ RETORNAR null em caso de erro
  }
};

export const cacheJWT = async(token, userData) => {
  if (!client || !client.isReady) {
    return;
  } // Proteção se Redis não estiver disponível
  try {
    await client.setEx(`jwt:${token}`, 3600, JSON.stringify(userData));
  } catch (error) {
    console.error('Erro ao salvar no cache:', error);
  }
};

export const getCachedJWT = async(token) => {
  if (!client || !client.isReady) {
    return null;
  } // Proteção se Redis não estiver disponível
  try {
    const cached = await client.get(`jwt:${token}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Erro ao buscar no cache:', error);
    return null;
  }
};
