/**
 * MIDDLEWARE DE AUTENTICAÇÃO - Adapter para verificação de tokens
 *
 * Middleware que traduz tokens HTTP em contexto de usuário.
 * Usa o TokenPort para verificação.
 */

import { HttpError } from '../../shared/utils/errorHandler.js';

export class AuthWebMiddleware {
  constructor(tokenAdapter, userRepository, logger) {
    this.tokenAdapter = tokenAdapter;
    this.userRepository = userRepository;
    this.logger = logger;
  }

  /**
   * Middleware para autenticação obrigatória
   */
  authenticate = async(req, res, next) => {
    try {
      // Extrair token do header
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return next(new HttpError(401, 'TOKEN_REQUIRED', 'Token de acesso requerido'));
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      // Verificar token usando o adapter
      const decoded = await this.tokenAdapter.verifyAccessToken(token);

      // Verificar se usuário ainda existe
      const user = await this.userRepository.findById(decoded.id);
      if (!user) {
        return next(new HttpError(401, 'USER_NOT_FOUND', 'Usuário não encontrado'));
      }

      // Adicionar contexto do usuário à requisição
      req.user = {
        id: decoded.id,
        username: decoded.username
      };

      next();

    } catch (error) {
      this.logger.error('Erro na autenticação', error);

      if (error.code === 'TOKEN_EXPIRED') {
        return next(new HttpError(401, 'TOKEN_EXPIRED', 'Token expirado'));
      }

      if (error.code === 'TOKEN_INVALID') {
        return next(new HttpError(401, 'TOKEN_INVALID', 'Token inválido'));
      }

      return next(error);
    }
  };

  /**
   * Middleware para autenticação opcional
   */
  optionalAuth = async(req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        req.user = null;
        return next();
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      try {
        const decoded = await this.tokenAdapter.verifyAccessToken(token);
        const user = await this.userRepository.findById(decoded.id);

        req.user = user ? {
          id: decoded.id,
          username: decoded.username
        } : null;
      } catch {
        req.user = null;
      }

      next();

    } catch (error) {
      this.logger.error('Erro na autenticação opcional', error);
      req.user = null;
      next();
    }
  };
}
