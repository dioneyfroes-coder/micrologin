/**
 * CONTROLADOR WEB - Interface HTTP para o núcleo da aplicação
 *
 * Este é apenas um adapter que traduz requisições HTTP para chamadas do CORE.
 * Não contém lógica de negócio, apenas orquestração.
 */

import type { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { securityAuditLogger } from '../middleware/securityAudit.js';
import { HttpError } from '../../shared/utils/errorHandler.js';
import { recordTokenRefresh } from '../observability/authEventSink.js';
import type { AuthService } from '../../domain/index.js';
import { REVOCATION_UNAVAILABLE_CODE } from '../../domain/index.js';

export class AuthWebController {
  private authService: AuthService;

  constructor(authenticationService: AuthService) {
    // Recebe o serviço do CORE via injeção de dependência
    this.authService = authenticationService;
  }

  /**
   * POST /login - Endpoint de autenticação
   */
  login = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos', errors.array()));
        return;
      }

      const { user: username, password } = req.body;

      // Delegar para o CORE
      const result = await this.authService.authenticateUser(username, password);

      // Um registro só: a auditoria e o evento publicado saem do mesmo desfecho,
      // traduzido uma vez dentro do audit logger.
      securityAuditLogger.logLoginAttempt(
        username,
        req.ip || 'unknown',
        req.get('User-Agent') || 'unknown',
        // Credencial recusada é uma coisa só, por design, para não enumerar
        // contas. O código entra só quando a recusa *não* é de credencial.
        result.success ? 'success' : (result.code ?? 'failure'),
        result.error ?? undefined
      );

      if (result.success && result.user && result.token) {
        res.json({
          success: true,
          message: 'Login realizado com sucesso',
          data: {
            user: result.user,
            accessToken: result.token.accessToken,
            refreshToken: result.token.refreshToken,
            tokenType: result.token.type,
            expiresIn: result.token.expiresIn
          }
        });
      } else if (result.code === REVOCATION_UNAVAILABLE_CODE) {
        // Fail-closed: sem armazenamento de revogação não há token a emitir, e
        // 401 seria mentira - diria que a senha está errada. O corpo continua
        // genérico, o status diz que a culpa é nossa.
        next(new HttpError(503, REVOCATION_UNAVAILABLE_CODE, 'Autenticação temporariamente indisponível'));
      } else {
        next(new HttpError(401, 'AUTHENTICATION_FAILED', 'Credenciais inválidas'));
      }

    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /register - Endpoint de registro
   */
  register = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos', errors.array()));
        return;
      }

      const { user: username, password } = req.body;

      // Delegar para o CORE
      const result = await this.authService.registerUser(username, password);

      if (result.success) {
        res.status(201).json({
          success: true,
          message: 'Usuário registrado com sucesso',
          data: {
            user: result.user
          }
        });
      } else {
        next(new HttpError(400, 'REGISTRATION_FAILED', 'Não foi possível criar a conta'));
      }

    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /refresh - Endpoint para renovar tokens usando refresh token
   */
  refresh = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos', errors.array()));
        return;
      }

      const { refreshToken } = req.body;
      if (!refreshToken || typeof refreshToken !== 'string') {
        next(new HttpError(400, 'REFRESH_TOKEN_REQUIRED', 'refreshToken é obrigatório'));
        return;
      }

      // Delegar para o CORE (realiza rotação e revoga o refresh antigo)
      const result = await this.authService.refreshUserTokens(refreshToken);
      // O código do domínio (`REFRESH_TOKEN_REUSED`, `REVOCATION_UNAVAILABLE`,
      // ...) é traduzido em rótulo pelo vocabulário único. Passar o código
      // cru era o que fazia todo desfecho virar `error`.
      recordTokenRefresh(result.success ? 'success' : result.code);

      if (result.success && result.token) {
        res.json({
          success: true,
          message: 'Tokens renovados com sucesso',
          data: {
            accessToken: result.token.accessToken,
            refreshToken: result.token.refreshToken,
            tokenType: result.token.type,
            expiresIn: result.token.expiresIn
          }
        });
        return;
      }

      // 401 para refresh inválido/expirado/reusado, 400 para demais falhas
      const statusCode = result.code === 'REFRESH_TOKEN_EXPIRED' ||
                         result.code === 'REFRESH_TOKEN_INVALID' ||
                         result.code === 'REFRESH_TOKEN_REUSED' ? 401 : 400;
      next(new HttpError(statusCode, result.code || 'REFRESH_TOKEN_INVALID', result.error || 'Falha ao renovar tokens'));

    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /logout - Endpoint para revogar tokens e encerrar a sessão
   *
   * O refresh token apresentado já identifica a sessão (ver `AuthService.endSession`),
   * então o logout funciona sem o access token no header - e mesmo assim derruba
   * tudo que aquela sessão emitiu, não apenas o par apresentado.
   */
  logout = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = req.headers.authorization;
      const accessToken = authorization && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : null;
      const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;

      const result = await this.authService.endSession({
        accessToken,
        refreshToken,
        authenticatedUserId: req.user?.id ?? null
      });

      // Falha de infraestrutura na revogação (ex.: Redis fora em modo
      // fail-closed) não é erro do cliente: a sessão NÃO foi encerrada.
      if (result.code === REVOCATION_UNAVAILABLE_CODE) {
        next(new HttpError(503, REVOCATION_UNAVAILABLE_CODE, 'Encerramento de sessão temporariamente indisponível'));
        return;
      }

      if (!result.success) {
        next(new HttpError(400, 'REVOCATION_FAILED', 'Nenhum token foi revogado'));
        return;
      }

      res.json({
        success: true,
        message: 'Logout realizado com sucesso'
      });

    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /profile - Endpoint para obter perfil
   */
  getProfile = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.id;

      // Delegar para o CORE
      const result = await this.authService.getUserProfile(userId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            user: result.user
          }
        });
      } else {
        next(new HttpError(404, 'USER_NOT_FOUND', result.error || 'Usuário não encontrado'));
      }

    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /update - Endpoint para atualizar perfil
   */
  updateProfile = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos', errors.array()));
        return;
      }

      const userId = req.user!.id;
      const { user: newUsername } = req.body;

      // Delegar para o CORE
      const result = await this.authService.updateUserProfile(userId, newUsername);

      if (result.success) {
        res.json({
          success: true,
          message: 'Perfil atualizado com sucesso',
          data: {
            user: result.user
          }
        });
      } else {
        next(new HttpError(400, 'PROFILE_UPDATE_FAILED', result.error || 'Falha ao atualizar perfil'));
      }

    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /password - Endpoint para trocar a senha
   *
   * Exige a senha atual (step-up) e encerra todas as sessões do usuário: os
   * tokens emitidos antes da troca deixam de valer.
   */
  changePassword = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos', errors.array()));
        return;
      }

      const userId = req.user!.id;
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };

      const result = await this.authService.changePassword(userId, currentPassword, newPassword);

      // Idem no login: um registro, um desfecho.
      securityAuditLogger.logPasswordChange(
        userId,
        req.ip || 'unknown',
        result.success ? 'success' : result.code,
        result.success ? undefined : result.error
      );

      if (result.success) {
        res.json({
          success: true,
          message: 'Senha alterada com sucesso. Faça login novamente: as sessões anteriores foram encerradas.'
        });
        return;
      }

      // 401 = a senha que ele disse estar usando está errada; 503 = o serviço
      // não conseguiu responder, e o cliente precisa poder repetir. Um 400 aqui
      // faria o usuário acreditar que a senha nova era o problema.
      const statusCode = result.code === 'CURRENT_PASSWORD_INVALID'
        ? 401
        : result.code === 'PASSWORD_HISTORY_UNAVAILABLE'
          ? 503
          : 400;
      next(new HttpError(statusCode, result.code || 'PASSWORD_CHANGE_FAILED', result.error || 'Falha ao alterar a senha'));

    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /delete - Endpoint para deletar perfil
   */
  deleteProfile = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.id;

      // Delegar para o CORE
      const result = await this.authService.deleteUser(userId);

      if (result.success) {
        res.json({
          success: true,
          message: 'Perfil deletado com sucesso'
        });
      } else {
        next(new HttpError(400, 'PROFILE_DELETE_FAILED', result.error || 'Falha ao deletar perfil'));
      }

    } catch (error) {
      next(error);
    }
  };
}
