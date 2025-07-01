import jwt from 'jsonwebtoken';
import { getCachedJWT, cacheJWT } from '../config/cache.js';

/**
 * Middleware para autenticação JWT
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
export const authenticateJWT = async(req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'Token não fornecido.' });
  }

  const token = authHeader.split(' ')[1];

  // Tenta buscar no cache primeiro
  const cachedUser = await getCachedJWT(token);
  if (cachedUser) {
    req.user = cachedUser;
    return next();
  }

  // Se não estiver no cache, verifica JWT
  jwt.verify(token, process.env.JWT_SECRET, async(err, user) => {
    if (err) {
      return res.status(401).json({ message: 'Token inválido ou expirado.' });
    }

    // Salva no cache para próximas requisições
    await cacheJWT(token, user);
    req.user = user;
    next();
  });
};
