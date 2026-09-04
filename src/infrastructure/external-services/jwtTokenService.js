/**
 * @fileoverview Serviço de Gerenciamento de Tokens JWT
 *
 * Implementa:
 * - Access Token (curta vida: 15 minutos)
 * - Refresh Token (longa vida: 7 dias)
 * - Revogação de tokens (blacklist em Redis)
 * - Renovação de tokens
 *
 * Segue as melhores práticas de segurança:
 * - RFC 6750: OAuth 2.0 Bearer Token Usage
 * - RFC 7519: JSON Web Token (JWT)
 */

import jwt from 'jsonwebtoken';

/**
 * Serviço de gerenciamento de tokens JWT com refresh token strategy
 */
export class JWTTokenService {
  constructor(secret, refreshSecret = null, redisClient = null) {
    if (!secret) {
      throw new Error('JWT_SECRET é obrigatório');
    }

    this.secret = secret;
    // Usar segredo separado para refresh token para maior segurança
    this.refreshSecret = refreshSecret || secret;
    this.redisClient = redisClient; // Opcional, para blacklist de tokens
  }

  /**
   * Gera um par de tokens (access + refresh)
   * @param {Object} payload - Dados do usuário (id, username, etc)
   * @param {Object} options - Opções adicionais
   * @returns {Promise<Object>} { accessToken, refreshToken, expiresIn }
   */
  async generateTokenPair(payload, options = {}) {
    try {
      const {
        issuer = 'micrologin-auth',
        audience = 'micrologin-api',
        accessExpiresIn = '15m',
        refreshExpiresIn = '7d'
      } = options;

      // ✅ Access Token (curta vida)
      const accessToken = jwt.sign(payload, this.secret, {
        expiresIn: accessExpiresIn,
        issuer,
        audience,
        subject: payload.id,
        type: 'access'
      });

      // ✅ Refresh Token (longa vida)
      const refreshToken = jwt.sign(
        { id: payload.id, username: payload.username },
        this.refreshSecret,
        {
          expiresIn: refreshExpiresIn,
          issuer,
          audience,
          subject: payload.id,
          type: 'refresh'
        }
      );

      // Decodificar para obter tempo de expiração
      const decoded = jwt.decode(accessToken);

      return {
        accessToken,
        refreshToken,
        expiresIn: decoded.exp * 1000 - Date.now(), // em milissegundos
        type: 'Bearer'
      };
    } catch (error) {
      throw new Error(`Erro ao gerar tokens: ${error.message}`);
    }
  }

  /**
   * Gera apenas um access token (sem refresh)
   * Útil para uso interno ou serviços
   * @param {Object} payload - Dados do token
   * @param {string} expiresIn - Tempo de expiração
   * @returns {Promise<string>} Access token
   */
  async generateAccessToken(payload, expiresIn = '15m') {
    try {
      return jwt.sign(payload, this.secret, {
        expiresIn,
        issuer: 'micrologin-auth',
        audience: 'micrologin-api',
        subject: payload.id,
        type: 'access'
      });
    } catch (error) {
      throw new Error(`Erro ao gerar access token: ${error.message}`);
    }
  }

  /**
   * Verifica e decodifica um access token
   * @param {string} token - Token a verificar
   * @returns {Promise<Object>} Payload decodificado
   */
  async verifyAccessToken(token) {
    try {
      // Verificar se o token está na blacklist
      if (this.redisClient) {
        const isBlacklisted = await this.isTokenBlacklisted(token);
        if (isBlacklisted) {
          throw new Error('Token foi revogado');
        }
      }

      return jwt.verify(token, this.secret, {
        issuer: 'micrologin-auth',
        audience: 'micrologin-api'
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        const tokenError = new Error('Access token expirado - use refresh token para renovar');
        tokenError.code = 'TOKEN_EXPIRED';
        throw tokenError;
      }
      const tokenError = new Error(`Token inválido: ${error.message}`);
      tokenError.code = 'TOKEN_INVALID';
      throw tokenError;
    }
  }

  /**
   * Verifica um refresh token
   * @param {string} token - Refresh token a verificar
   * @returns {Promise<Object>} Payload decodificado
   */
  async verifyRefreshToken(token) {
    try {
      if (this.redisClient) {
        const isBlacklisted = await this.isTokenBlacklisted(token);
        if (isBlacklisted) {
          throw new Error('Refresh token foi revogado');
        }
      }

      return jwt.verify(token, this.refreshSecret, {
        issuer: 'micrologin-auth',
        audience: 'micrologin-api'
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        const tokenError = new Error('Refresh token expirado - necessário fazer login novamente');
        tokenError.code = 'REFRESH_TOKEN_EXPIRED';
        throw tokenError;
      }
      const tokenError = new Error(`Refresh token inválido: ${error.message}`);
      tokenError.code = 'REFRESH_TOKEN_INVALID';
      throw tokenError;
    }
  }

  /**
   * Renova um token usando refresh token
   * @param {string} refreshToken - Refresh token válido
   * @param {Object} options - Opções adicionais
   * @returns {Promise<Object>} Novo par de tokens
   */
  async refreshTokens(refreshToken, options = {}) {
    try {
      // Verificar refresh token
      const decoded = await this.verifyRefreshToken(refreshToken);

      // Gerar novo par de tokens
      const newTokens = await this.generateTokenPair(
        { id: decoded.id, username: decoded.username },
        options
      );

      // Revogar o refresh token antigo (opcional, para maior segurança)
      if (this.redisClient) {
        const expiresIn = decoded.exp * 1000 - Date.now();
        await this.blacklistToken(refreshToken, expiresIn);
      }

      return newTokens;
    } catch (error) {
      throw new Error(`Erro ao renovar tokens: ${error.message}`);
    }
  }

  /**
   * Revoga um token adicionando-o à blacklist
   * @param {string} token - Token a revogar
   * @param {number} expiresIn - Tempo até expiração (ms)
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async revokeToken(token, expiresIn = 3600000) {
    if (!this.redisClient) {
      console.warn('Redis não disponível para revogação de tokens');
      return false;
    }

    try {
      const key = `token_blacklist:${token}`;
      const ttlSeconds = Math.ceil(expiresIn / 1000);

      await this.redisClient.setex(key, ttlSeconds, 'true');
      return true;
    } catch (error) {
      console.error('Erro ao revogar token:', error);
      return false;
    }
  }

  /**
   * Revoga todos os tokens de um usuário
   * @param {string} userId - ID do usuário
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async revokeUserTokens(userId) {
    if (!this.redisClient) {
      console.warn('Redis não disponível para revogação de tokens');
      return false;
    }

    try {
      const key = `user_tokens_revoked:${userId}`;
      await this.redisClient.set(key, Date.now().toString());
      return true;
    } catch (error) {
      console.error('Erro ao revogar tokens do usuário:', error);
      return false;
    }
  }

  /**
   * Verifica se um token está na blacklist
   * @param {string} token - Token a verificar
   * @returns {Promise<boolean>} True se está blacklistado
   */
  async isTokenBlacklisted(token) {
    if (!this.redisClient) {
      return false;
    }

    try {
      const key = `token_blacklist:${token}`;
      const result = await this.redisClient.get(key);
      return result !== null;
    } catch (error) {
      console.error('Erro ao verificar blacklist:', error);
      return false;
    }
  }

  /**
   * Decodifica um token SEM validar a assinatura
   * Útil apenas para inspeção, não use para segurança
   * @param {string} token - Token a decodificar
   * @returns {Object} Payload decodificado
   */
  decodeToken(token) {
    try {
      return jwt.decode(token);
    } catch (error) {
      throw new Error(`Erro ao decodificar token: ${error.message}`);
    }
  }
}

