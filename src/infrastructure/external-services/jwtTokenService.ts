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

import jwt, { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { RedisClient } from '../cache/connection.js';
import type { TokenGenerationOptions, TokenPair, TokenService } from '../../domain/index.js';
import { logger } from '../../shared/utils/logger.js';

interface JwtIssuedPayload {
  id: string;
  username: string;
  token_type?: string;
  iat?: number;
  exp?: number;
  jti?: string;
}

/**
 * Serviço de gerenciamento de tokens JWT com refresh token strategy
 */
export class JWTTokenService implements TokenService {
  private secret: string;
  // Usar segredo separado para refresh token para maior segurança
  private refreshSecret: string;
  private redisClient: RedisClient | null; // Opcional, para blacklist de tokens
  private issuer: string;
  private audience: string;

  constructor(
    secret: string,
    refreshSecret: string | null = null,
    redisClient: RedisClient | null = null,
    issuer = 'auth-service',
    audience = 'api-users'
  ) {
    if (!secret) {
      throw new Error('JWT_SECRET é obrigatório');
    }

    this.secret = secret;
    this.refreshSecret = refreshSecret || secret;
    this.redisClient = redisClient;
    this.issuer = issuer;
    this.audience = audience;
  }

  /**
   * Conecta o serviço ao Redis após a inicialização da infraestrutura
   * @param redisClient - Cliente Redis pronto para uso
   */
  setRedisClient(redisClient: RedisClient): void {
    this.redisClient = redisClient;
  }

  /**
   * Gera um par de tokens (access + refresh)
   * @param payload - Dados do usuário (id, username, etc)
   * @param options - Opções adicionais
   * @returns { accessToken, refreshToken, expiresIn }
   */
  async generateTokenPair(payload: { id: string; username: string }, options: TokenGenerationOptions = {}): Promise<TokenPair> {
    try {
      const {
        issuer = this.issuer,
        audience = this.audience,
        accessExpiresIn = '15m',
        refreshExpiresIn = '7d'
      } = options;

      const signOptions: SignOptions = {
        issuer,
        audience,
        subject: payload.id,
        // nonce único: evita que tokens emitidos no mesmo segundo (iat em segundos)
        // sejam byte-idênticos e que o "novo" refresh coincida com o revogado
        jwtid: randomUUID()
      };

      // ✅ Access Token (curta vida)
      const accessToken = jwt.sign(
        { ...payload, token_type: 'access' },
        this.secret,
        {
          ...signOptions,
          expiresIn: accessExpiresIn as SignOptions['expiresIn']
        }
      );

      // ✅ Refresh Token (longa vida)
      const refreshToken = jwt.sign(
        { id: payload.id, username: payload.username, token_type: 'refresh' },
        this.refreshSecret,
        {
          ...signOptions,
          expiresIn: refreshExpiresIn as SignOptions['expiresIn']
        }
      );

      // Decodificar para obter tempo de expiração
      const decoded = jwt.decode(accessToken) as JwtIssuedPayload;

      return {
        accessToken,
        refreshToken,
        expiresIn: (decoded.exp ?? Date.now()) * 1000 - Date.now(), // em milissegundos
        type: 'Bearer'
      };
    } catch (error) {
      throw new Error(`Erro ao gerar tokens: ${(error as Error).message}`);
    }
  }

  /**
   * Gera apenas um access token (sem refresh)
   * Útil para uso interno ou serviços
   * @param payload - Dados do token
   * @param expiresIn - Tempo de expiração
   * @returns Access token
   */
  async generateAccessToken(payload: { id: string; username: string }, expiresIn = '15m'): Promise<string> {
    try {
      return jwt.sign({ ...payload, token_type: 'access' }, this.secret, {
        expiresIn: expiresIn as SignOptions['expiresIn'],
        issuer: this.issuer,
        audience: this.audience,
        subject: payload.id
      });
    } catch (error) {
      throw new Error(`Erro ao gerar access token: ${(error as Error).message}`);
    }
  }

  /**
   * Verifica e decodifica um access token
   * @param token - Token a verificar
   * @returns Payload decodificado
   */
  async verifyAccessToken(token: string): Promise<JwtIssuedPayload> {
    try {
      // Verificar se o token está na blacklist
      if (this.redisClient) {
        const isBlacklisted = await this.isTokenBlacklisted(token);
        if (isBlacklisted) {
          throw new Error('Token foi revogado');
        }
      }

      const payload = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience
      }) as JwtIssuedPayload;

      // Verificar revogação em nível de usuário (ex: logout/logout-all)
      if (await this.isUserRevoked(payload.id, payload.iat)) {
        const tokenError = new Error('Token foi revogado');
        (tokenError as Error & { code?: string }).code = 'TOKEN_INVALID';
        throw tokenError;
      }

      return payload;
    } catch (error) {
      if ((error as Error).name === 'TokenExpiredError') {
        const tokenError = new Error('Access token expirado - use refresh token para renovar');
        (tokenError as Error & { code?: string }).code = 'TOKEN_EXPIRED';
        throw tokenError;
      }
      const tokenError = new Error(`Token inválido: ${(error as Error).message}`);
      (tokenError as Error & { code?: string }).code = 'TOKEN_INVALID';
      throw tokenError;
    }
  }

  /**
   * Verifica um refresh token
   * @param token - Refresh token a verificar
   * @returns Payload decodificado
   */
  async verifyRefreshToken(token: string): Promise<JwtIssuedPayload> {
    try {
      if (this.redisClient) {
        const isBlacklisted = await this.isTokenBlacklisted(token);
        if (isBlacklisted) {
          throw new Error('Refresh token foi revogado');
        }
      }

      const payload = jwt.verify(token, this.refreshSecret, {
        issuer: this.issuer,
        audience: this.audience
      }) as JwtIssuedPayload;

      // Verificar revogação em nível de usuário (ex: logout/logout-all)
      if (await this.isUserRevoked(payload.id, payload.iat)) {
        const tokenError = new Error('Refresh token foi revogado');
        (tokenError as Error & { code?: string }).code = 'REFRESH_TOKEN_INVALID';
        throw tokenError;
      }

      return payload;
    } catch (error) {
      if ((error as Error).name === 'TokenExpiredError') {
        const tokenError = new Error('Refresh token expirado - necessário fazer login novamente');
        (tokenError as Error & { code?: string }).code = 'REFRESH_TOKEN_EXPIRED';
        throw tokenError;
      }
      const tokenError = new Error(`Refresh token inválido: ${(error as Error).message}`);
      (tokenError as Error & { code?: string }).code = 'REFRESH_TOKEN_INVALID';
      throw tokenError;
    }
  }

  /**
   * Verifica se o usuário teve todos os tokens revogados após a emissão do token
   * @param userId - ID do usuário
   * @param issuedAtSec - Timestamp de emissão do token (iat, em segundos)
   * @returns True se o token foi emitido antes da revogação
   */
  async isUserRevoked(userId: string, issuedAtSec?: number): Promise<boolean> {
    if (!this.redisClient || !userId || !issuedAtSec) {
      return false;
    }

    try {
      const revokedAt = await this.redisClient.get(`user_tokens_revoked:${userId}`);
      if (!revokedAt) {
        return false;
      }
      return issuedAtSec * 1000 < parseInt(revokedAt as string, 10);
    } catch (error) {
      logger.error('Erro ao verificar revogação do usuário', error);
      return false;
    }
  }

  /**
   * Renova um token usando refresh token
   * @param refreshToken - Refresh token válido
   * @param options - Opções adicionais
   * @returns Novo par de tokens
   */
  async refreshTokens(refreshToken: string, options: TokenGenerationOptions = {}): Promise<TokenPair> {
    try {
      // Verificar refresh token
      const decoded = await this.verifyRefreshToken(refreshToken);

      // Gerar novo par de tokens
      const newTokens = await this.generateTokenPair(
        { id: decoded.id, username: decoded.username },
        options
      );

      // Revogar o refresh token antigo (maior segurança: rotação de tokens)
      if (this.redisClient) {
        const expiresIn = (decoded.exp ?? Date.now()) * 1000 - Date.now();
        await this.revokeToken(refreshToken, expiresIn);
      }

      return newTokens;
    } catch (error) {
      // Preservar códigos de erro de token (expirado/inválido)
      if ((error as Error & { code?: string }).code) {
        throw error;
      }
      throw new Error(`Erro ao renovar tokens: ${(error as Error).message}`);
    }
  }

  /**
   * Revoga um token adicionando-o à blacklist
   * @param token - Token a revogar
   * @param expiresIn - Tempo até expiração (ms)
   * @returns Sucesso da operação
   */
  async revokeToken(token: string, expiresIn = 3600000): Promise<boolean> {
    if (!this.redisClient) {
      logger.warn('Redis não disponível para revogação de tokens');
      return false;
    }

    try {
      const key = `token_blacklist:${token}`;
      const ttlSeconds = Math.ceil(expiresIn / 1000);

      await this.redisClient.setEx(key, ttlSeconds, 'true');
      return true;
    } catch (error) {
      logger.error('Erro ao revogar token', error);
      return false;
    }
  }

  /**
   * Revoga todos os tokens de um usuário
   * @param userId - ID do usuário
   * @param expiresIn - Tempo de validade da revogação (ms)
   * @returns Sucesso da operação
   */
  async revokeUserTokens(userId: string, expiresIn = 604800000): Promise<boolean> {
    if (!this.redisClient) {
      logger.warn('Redis não disponível para revogação de tokens');
      return false;
    }

    try {
      const key = `user_tokens_revoked:${userId}`;
      const ttlSeconds = Math.ceil(expiresIn / 1000);
      await this.redisClient.setEx(key, ttlSeconds, Date.now().toString());
      return true;
    } catch (error) {
      logger.error('Erro ao revogar tokens do usuário', error);
      return false;
    }
  }

  /**
   * Verifica se um token está na blacklist
   * @param token - Token a verificar
   * @returns True se está blacklistado
   */
  async isTokenBlacklisted(token: string): Promise<boolean> {
    if (!this.redisClient) {
      return false;
    }

    try {
      const key = `token_blacklist:${token}`;
      const result = await this.redisClient.get(key);
      return result !== null;
    } catch (error) {
      logger.error('Erro ao verificar blacklist', error);
      return false;
    }
  }

  /**
   * Decodifica um token SEM validar a assinatura
   * Útil apenas para inspeção, não use para segurança
   * @param token - Token a decodificar
   * @returns Payload decodificado
   */
  decodeToken(token: string): jwt.JwtPayload | string | null {
    try {
      return jwt.decode(token);
    } catch (error) {
      throw new Error(`Erro ao decodificar token: ${(error as Error).message}`);
    }
  }
}
