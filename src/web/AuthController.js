/**
 * CONTROLADOR WEB - Interface HTTP para o núcleo da aplicação
 *
 * Este é apenas um adapter que traduz requisições HTTP para chamadas do CORE.
 * Não contém lógica de negócio, apenas orquestração.
 */

import { validationResult } from 'express-validator';
import { securityAuditLogger } from '../middleware/securityAudit.js';

export class AuthWebController {
  constructor(authenticationService) {
    // Recebe o serviço do CORE via injeção de dependência
    this.authService = authenticationService;
  }

  /**
   * POST /login - Endpoint de autenticação
   */
  login = async(req, res) => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { user: username, password } = req.body;

      // Delegar para o CORE
      const result = await this.authService.authenticateUser(username, password);

      // Registrar tentativa de login no sistema de auditoria
      securityAuditLogger.logLoginAttempt(
        username,
        req.ip,
        req.get('User-Agent'),
        result.success
      );

      if (result.success) {
        return res.json({
          success: true,
          message: 'Login realizado com sucesso',
          data: {
            user: result.user,
            token: result.token
          }
        });
      } else {
        return res.status(401).json({
          success: false,
          message: result.error
        });
      }

    } catch {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };

  /**
   * POST /register - Endpoint de registro
   */
  register = async(req, res) => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { user: username, password } = req.body;

      // Delegar para o CORE
      const result = await this.authService.registerUser(username, password);

      if (result.success) {
        return res.status(201).json({
          success: true,
          message: 'Usuário registrado com sucesso',
          data: {
            user: result.user
          }
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

    } catch {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };

  /**
   * GET /profile - Endpoint para obter perfil
   */
  getProfile = async(req, res) => {
    try {
      const userId = req.user.id;

      // Delegar para o CORE
      const result = await this.authService.getUserProfile(userId);

      if (result.success) {
        return res.json({
          success: true,
          data: {
            user: result.user
          }
        });
      } else {
        return res.status(404).json({
          success: false,
          message: result.error
        });
      }

    } catch {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };

  /**
   * PUT /update - Endpoint para atualizar perfil
   */
  updateProfile = async(req, res) => {
    try {
      // Validar entrada HTTP
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const { user: newUsername, password: newPassword } = req.body;

      // Delegar para o CORE
      const result = await this.authService.updateUserProfile(
        userId,
        newUsername,
        newPassword
      );

      if (result.success) {
        return res.json({
          success: true,
          message: 'Perfil atualizado com sucesso',
          data: {
            user: result.user
          }
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

    } catch {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };

  /**
   * DELETE /delete - Endpoint para deletar perfil
   */
  deleteProfile = async(req, res) => {
    try {
      const userId = req.user.id;

      // Delegar para o CORE
      const result = await this.authService.deleteUser(userId);

      if (result.success) {
        return res.json({
          success: true,
          message: 'Perfil deletado com sucesso'
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

    } catch {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };
}
