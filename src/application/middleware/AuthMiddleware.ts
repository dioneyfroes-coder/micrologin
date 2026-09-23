/**
 * MIDDLEWARE DE AUTENTICAÇÃO - Adapter para verificação de tokens
 *
 * Middleware que traduz tokens HTTP em contexto de usuário.
 * Usa o TokenPort para verificação.
 */

import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../shared/utils/errorHandler.js';
import type { TokenService, UserRepository, Logger } from '../../domain/index.js';

export class AuthWebMiddleware {
  private tokenAdapter: TokenService;
  private userRepository: UserRepository;
  private logger: Logger;

  constructor(tokenAdapter: TokenService, userRepository: UserRepository, logger: Logger) {
    this.tokenAdapter = tokenAdapter;
    this.userRepository = userRepository;
    this.logger = logger;
  }

  /**
   * Middleware para autenticação obrigatória
   */
  authenticate = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Extrair token do header
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        next(new HttpError(401, 'TOKEN_REQUIRED', 'Token de acesso requerido'));
        return;
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      // Verificar token usando o adapter
      if (!this.tokenAdapter.verifyAccessToken) {
        next(new HttpError(500, 'TOKEN_SERVICE_ERROR', 'TokenService não implementa verifyAccessToken'));
        return;
      }

      const decoded = await this.tokenAdapter.verifyAccessToken(token) as { id: string; username: string };

      // Verificar se usuário ainda existe
      const user = await this.userRepository.findById(decoded.id);
      if (!user) {
        next(new HttpError(401, 'USER_NOT_FOUND', 'Usuário não encontrado'));
        return;
      }

      // Adicionar contexto do usuário à requisição
      req.user = {
        id: decoded.id,
        username: decoded.username
      };

      next();

    } catch (error) {
      this.logger.error('Erro na autenticação', error);

      const err = error as Error & { code?: string };

      if (err.code === 'TOKEN_EXPIRED') {
        next(new HttpError(401, 'TOKEN_EXPIRED', 'Token expirado'));
        return;
      }

      if (err.code === 'TOKEN_INVALID') {
        next(new HttpError(401, 'TOKEN_INVALID', 'Token inválido'));
        return;
      }

      next(error);
    }
  };

  /**
   * Middleware para autenticação opcional
   */
  optionalAuth = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        req.user = null;
        next();
        return;
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      try {
        if (this.tokenAdapter.verifyAccessToken) {
          const decoded = await this.tokenAdapter.verifyAccessToken(token) as { id: string; username: string };
          const user = await this.userRepository.findById(decoded.id);

          req.user = user ? {
            id: decoded.id,
            username: decoded.username
          } : null;
        }
      } catch {
        req.user = null;
      }

      next();

    } catch {
      req.user = null;
      next();
    }
  };
}
