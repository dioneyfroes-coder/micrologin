/**
 * @fileoverview Serviço de Gerenciamento de Tokens JWT
 *
 * Implementa:
 * - Access Token (curta vida: 15 minutos)
 * - Refresh Token (longa vida: 7 dias)
 * - Revogação de tokens (blacklist em Redis)
 * - Renovação de tokens
 *
 * A assinatura em si vive em `jwtSigner.ts` (HS256 para dev/test, ES256 em
 * produção). Este serviço cuida do que é sessão: *quando* emitir, quais
 * claims, e como revogar.
 *
 * Segue as melhores práticas de segurança:
 * - RFC 6750: OAuth 2.0 Bearer Token Usage
 * - RFC 7519: JSON Web Token (JWT)
 */

import { createHash, randomUUID } from 'crypto';
import type { RedisClient } from '../cache/connection.js';
import type { TokenGenerationOptions, TokenPair, TokenService } from '../../domain/index.js';
import { REVOCATION_UNAVAILABLE_CODE } from '../../domain/index.js';
import { logger } from '../../shared/utils/logger.js';
import {
  Es256Signer,
  Hs256Signer,
  type Es256Keys,
  type TokenClaims,
  type TokenSigner
} from './jwtSigner.js';

type JwtIssuedPayload = TokenClaims;

/** Material de assinatura assimétrica injetado pelo bootstrap em produção. */
export type Es256KeyMaterial = Es256Keys;

/**
 * Prefixo da blacklist. A chave é derivada do `jti` do token (identificador
 * aleatório do próprio JWT), nunca do token completo: o segredo não vira chave
 * de armazenamento. Tokens legados sem `jti` caem para o hash SHA-256 do token.
 */
const BLACKLIST_PREFIX = 'token_blacklist:';
const BLACKLIST_ROTATED_VALUE = 'rotated';
const BLACKLIST_REVOKED_VALUE = 'revoked';
const USER_SESSION_VERSION_PREFIX = 'user_session_version:';

/**
 * Chave da marca de revogação por usuário, para tokens emitidos antes do `sv`.
 *
 * Constante porque é escrita e lida em pontos diferentes do arquivo. Se as duas
 * pontas divergissem, `isUserRevoked` não acharia a marca e devolveria `false` —
 * ou seja, um token revogado passaria a ser aceito, sem erro em lugar nenhum.
 * É o tipo de divergência que nenhum teste de integração pega, porque as duas
 * pontas usam a mesma constante errada.
 */
const USER_TOKENS_REVOKED_PREFIX = 'user_tokens_revoked:';

/**
 * Política de revogação quando o armazenamento (Redis) não está disponível.
 * - `failOpen: true`  → degrada para disponibilidade (tokens revogados podem
 *                        ser aceitos). Aceitável em dev/test.
 * - `failOpen: false` → fail-closed: operações que dependem de revogação são
 *                        negadas. Padrão recomendado em produção.
 */
export interface SessionPolicy {
  failOpen: boolean;
}

export { REVOCATION_UNAVAILABLE_CODE };

const revocationUnavailableError = (): Error => {
  const error = new Error('Revogação de tokens indisponível');
  (error as Error & { code?: string }).code = REVOCATION_UNAVAILABLE_CODE;
  return error;
};

/**
 * Serviço de gerenciamento de tokens JWT com refresh token strategy
 */
export class JWTTokenService implements TokenService {
  private secret: string;
  // Segredo separado para refresh token; obrigatório e distinto em produção
  private refreshSecret: string;
  private redisClient: RedisClient | null; // Opcional, para blacklist de tokens
  private issuer: string;
  private audience: string;
  private sessionPolicy: SessionPolicy;
  private accessSigner: TokenSigner;
  private refreshSigner: TokenSigner;

  constructor(
    secret: string,
    refreshSecret: string | null = null,
    redisClient: RedisClient | null = null,
    issuer = 'auth-service',
    audience = 'api-users',
    // Padrão fail-open: seguro para unit/integration tests. Em produção, o
    // bootstrap injeta a política de `securityConfig.session`.
    sessionPolicy: SessionPolicy = { failOpen: true },
    /**
     * Assinatura assimétrica (ES256). Quando ausente, cai para HS256 com os
     * segredos — o caminho de dev/test e dos testes que fabricam token legado.
     */
    es256: Es256KeyMaterial | null = null
  ) {
    // ES256: uma única instância serve a access e refresh. Importar o mesmo PEM
    // duas vezes faria parse de ASN.1 redundante no caminho de login.
    const es256Signer = es256 ? new Es256Signer(es256) : null;
    this.accessSigner = es256Signer ?? new Hs256Signer(secret);
    this.refreshSigner = es256Signer ?? new Hs256Signer(refreshSecret ?? secret);

    // No caminho ES256 os segredos simétricos não são usados: exigir ou avisar
    // sobre eles seria pedir configuração que não protege nada.
    if (!es256 && !secret) {
      throw new Error('JWT_SECRET é obrigatório');
    }

    this.secret = secret;
    if (refreshSecret) {
      this.refreshSecret = refreshSecret;
    } else {
      if (!es256) {
        logger.warn('⚠️ JWT_REFRESH_SECRET não definido: usando JWT_SECRET para refresh tokens');
      }
      this.refreshSecret = secret;
    }
    this.redisClient = redisClient;
    this.issuer = issuer;
    this.audience = audience;
    this.sessionPolicy = sessionPolicy;
  }

  /**
   * Conecta o serviço ao Redis após a inicialização da infraestrutura
   * @param redisClient - Cliente Redis pronto para uso
   */
  setRedisClient(redisClient: RedisClient): void {
    this.redisClient = redisClient;
  }

  /**
   * Informa se o armazenamento de revogação está utilizável.
   * Clientes de teste podem não expor `isReady`; nesse caso consideramos pronto.
   */
  private isRevocationStoreReady(): boolean {
    return !!this.redisClient && this.redisClient.isReady !== false;
  }

  /**
   * Garante que a revogação está disponível quando a política é fail-closed.
   * Em fail-open, apenas registra e deixa a operação seguir.
   *
   * Vale para *emitir* tanto quanto para *verificar*. Sem armazenamento, um token
   * novo sai sem a claim `sv` e sem como ser revogado depois: o
   * serviço aceitaria a própria credencial que não tem como cassar. Emitir
   * nesse estado é a mesma falha que aceitar, vista pelo outro lado.
   */
  private assertRevocationAvailable(): void {
    if (this.isRevocationStoreReady() || this.sessionPolicy.failOpen) {
      return;
    }

    logger.error('Revogação indisponível: armazenamento fora do ar (fail-closed)');
    throw revocationUnavailableError();
  }

  /**
   * Trata falha ao acessar o armazenamento de revogação conforme a política.
   * - fail-closed: propaga o erro (a requisição é negada)
   * - fail-open: registra e devolve `false` (degrada a proteção)
   */
  private handleRevocationError(context: string, error: unknown): false {
    logger.error(`Erro ao ${context}`, error);
    if (!this.sessionPolicy.failOpen) {
      throw revocationUnavailableError();
    }
    return false;
  }

  /**
   * Impede que um refresh token seja usado como access (e vice-versa).
   *
   * Com HS256 isso é redundante: os segredos já são diferentes, e tokens
   * legados sem a claim continuam válidos. Com ES256 é obrigatório — o par de
   * chaves é o mesmo, e aceitar um refresh como access entregaria 7 dias de
   * sessão a quem só tem o refresh, inclusive depois de um logout.
   */
  private assertTokenType(payload: JwtIssuedPayload, expected: 'access' | 'refresh'): void {
    if (!this.accessSigner.reliesOnTokenType) {
      return;
    }
    if (payload.token_type !== expected) {
      throw new Error(`Token não é do tipo ${expected}`);
    }
  }

  /**
   * Extrai o `jti` (identificador único do JWT) sem validar a assinatura.
   * @returns O jti ou null para tokens sem jti/ilegíveis
   */
  private extractJti(token: string): string | null {
    const decoded = this.accessSigner.decode(token);
    if (typeof decoded?.jti !== 'string' || !decoded.jti) {
      return null;
    }
    return decoded.jti;
  }

  /**
   * Deriva a chave de blacklist a partir do token.
   *
   * Preferência: `token_blacklist:jti:<jti>` (o segredo não é usado como chave).
   * Fallback para tokens sem `jti` (ex.: emitidos por versão anterior):
   * `token_blacklist:sha256:<hash>` — determinístico, sem expor o token.
   */
  private blacklistKey(token: string): string {
    const jti = this.extractJti(token);
    if (jti) {
      return `${BLACKLIST_PREFIX}jti:${jti}`;
    }

    const hash = createHash('sha256').update(token).digest('hex');
    return `${BLACKLIST_PREFIX}sha256:${hash}`;
  }

  /**
   * Converte TTL restante (em segundos) em um valor válido para o Redis.
   */
  private toTtlSeconds(expiresIn: number): number {
    return Math.max(1, Math.ceil(expiresIn / 1000));
  }

  /**
   * Calcula o tempo restante de um token verificado.
   */
  private remainingTtlSeconds(payload: JwtIssuedPayload): number {
    const expiresAtMs = (payload.exp ?? Math.floor(Date.now() / 1000)) * 1000;
    return this.toTtlSeconds(expiresAtMs - Date.now());
  }

  /**
   * TTL da entrada de blacklist: o menor entre o solicitado e o que sobra de
   * vida do próprio token. A entrada nunca sobrevive ao token que aponta -
   * depois que ele expira, a assinatura já o rejeita.
   */
  private blacklistTtlSeconds(token: string, requestedExpiresIn: number): number {
    const requested = this.toTtlSeconds(requestedExpiresIn);

    const payload = this.accessSigner.decode(token);

    if (!payload || typeof payload.exp !== 'number') {
      return requested;
    }

    return Math.min(requested, this.remainingTtlSeconds(payload));
  }

  /**
   * Versão de sessão atual do usuário (0 quando nunca houve revogação em massa).
   *
   * A versão é um contador, não um relógio: comparação por timestamp tem
   * granularidade de segundo e rejeitaria tokens emitidos no mesmo segundo da
   * revogação - o que acontece sempre que o usuário troca a senha e faz login
   * de imediato. O token morreria no instante em que nasceu.
   */
  private async currentSessionVersion(userId: string): Promise<number | null> {
    if (!this.redisClient) {
      return null;
    }

    try {
      const stored = await this.redisClient.get(`${USER_SESSION_VERSION_PREFIX}${userId}`);
      if (stored === null) {
        return 0;
      }
      const parsed = parseInt(stored as string, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    } catch (error) {
      this.handleRevocationError('ler versão de sessão', error);
      return null;
    }
  }

  /**
   * Carrega a versão de sessão para embutir no token. Devolve `null` quando não
   * há como lê-la: o token sai sem a claim e a verificação cai para a comparação
   * por timestamp, em vez de nascer com uma versão falsificada.
   */
  private async sessionVersionClaim(userId: string): Promise<{ sv?: number }> {
    const version = await this.currentSessionVersion(userId);
    return version === null ? {} : { sv: version };
  }

  /**
   * Gera um par de tokens (access + refresh)
   * @param payload - Dados do usuário (id, username, etc)
   * @param options - Opções adicionais
   * @returns { accessToken, refreshToken, expiresIn }
   */
  async generateTokenPair(payload: { id: string; username: string }, options: TokenGenerationOptions = {}): Promise<TokenPair> {
    return this.generateTokenPairAtSessionVersion(payload, options);
  }

  private async generateTokenPairAtSessionVersion(
    payload: { id: string; username: string },
    options: TokenGenerationOptions,
    sessionVersion?: number
  ): Promise<TokenPair> {
    try {
      // Emitir exige o mesmo que verificar: o armazenamento de revogação tem de
      // estar utilizável, senão o token nasce sem como morrer.
      this.assertRevocationAvailable();

      const {
        issuer = this.issuer,
        audience = this.audience,
        accessExpiresIn = '15m',
        refreshExpiresIn = '7d'
      } = options;

      // A claim `sv` amarra o token à versão de sessão do usuário: logout em
      // massa (ou troca de senha) incrementa a versão e derruba todos os
      // tokens emitidos antes, sem depender da precisão do relógio.
      const sessionClaim = sessionVersion === undefined
        ? await this.sessionVersionClaim(payload.id)
        : { sv: sessionVersion };

      // ✅ Access Token (curta vida)
      // `jti` único por token: é a chave de revogação e o que torna dois
      // tokens emitidos no mesmo segundo (iat em segundos) distintos.
      const accessToken = await this.accessSigner.sign({
        payload: { ...payload, ...sessionClaim, token_type: 'access' },
        expiresIn: accessExpiresIn,
        issuer,
        audience,
        subject: payload.id,
        jwtid: randomUUID()
      });

      // ✅ Refresh Token (longa vida) - jti PRÓPRIO, para revogar apenas o
      // refresh sem derrubar o access emitido na mesma operação.
      const refreshToken = await this.refreshSigner.sign({
        payload: { id: payload.id, username: payload.username, ...sessionClaim, token_type: 'refresh' },
        expiresIn: refreshExpiresIn,
        issuer,
        audience,
        subject: payload.id,
        jwtid: randomUUID()
      });

      // Decodificar para obter tempo de expiração
      const decoded = this.accessSigner.decode(accessToken) as JwtIssuedPayload;

      return {
        accessToken,
        refreshToken,
        expiresIn: (decoded.exp ?? Date.now()) * 1000 - Date.now(), // em milissegundos
        type: 'Bearer'
      };
    } catch (error) {
      // REVOCATION_UNAVAILABLE precisa chegar ao error handler com o código
      // intacto: ele decide entre 503 e 400.
      if ((error as Error & { code?: string }).code === REVOCATION_UNAVAILABLE_CODE) {
        throw error;
      }
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
      this.assertRevocationAvailable();
      const sessionClaim = await this.sessionVersionClaim(payload.id);
      return this.accessSigner.sign({
        payload: { ...payload, ...sessionClaim, token_type: 'access' },
        expiresIn,
        issuer: this.issuer,
        audience: this.audience,
        subject: payload.id,
        jwtid: randomUUID()
      });
    } catch (error) {
      if ((error as Error & { code?: string }).code === REVOCATION_UNAVAILABLE_CODE) {
        throw error;
      }
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
      // Em fail-closed, sem armazenamento de revogação não há como garantir
      // que o token não foi revogado: a operação é negada.
      this.assertRevocationAvailable();

      // Verificar se o token está na blacklist
      if (this.redisClient) {
        const isBlacklisted = await this.isTokenBlacklisted(token);
        if (isBlacklisted) {
          throw new Error('Token foi revogado');
        }
      }

      const payload = await this.accessSigner.verify(token, {
        issuer: this.issuer,
        audience: this.audience
      });
      this.assertTokenType(payload, 'access');

      // Verificar revogação em nível de usuário (ex: logout/logout-all)
      if (await this.isUserRevoked(payload)) {
        const tokenError = new Error('Token foi revogado');
        (tokenError as Error & { code?: string }).code = 'TOKEN_INVALID';
        throw tokenError;
      }

      return payload;
    } catch (error) {
      if ((error as Error & { code?: string }).code === REVOCATION_UNAVAILABLE_CODE) {
        throw error;
      }
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
      this.assertRevocationAvailable();

      const payload = await this.refreshSigner.verify(token, {
        issuer: this.issuer,
        audience: this.audience
      });
      this.assertTokenType(payload, 'refresh');

      // Verificar revogação em nível de usuário (ex: logout/logout-all)
      if (await this.isUserRevoked(payload)) {
        const tokenError = new Error('Refresh token foi revogado');
        (tokenError as Error & { code?: string }).code = 'REFRESH_TOKEN_INVALID';
        throw tokenError;
      }

      if (this.redisClient && await this.isTokenBlacklisted(token)) {
        const reason = await this.redisClient.get(this.blacklistKey(token));
        if (reason === BLACKLIST_ROTATED_VALUE) {
          const tokenError = new Error('Refresh token já utilizado - possível reuso de token');
          (tokenError as Error & { code?: string; userId?: string }).code = 'REFRESH_TOKEN_REUSED';
          (tokenError as Error & { code?: string; userId?: string }).userId = payload.id;
          throw tokenError;
        }
        throw new Error('Refresh token foi revogado');
      }

      return payload;
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === REVOCATION_UNAVAILABLE_CODE || code === 'REFRESH_TOKEN_REUSED') {
        throw error;
      }
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
   * Verifica se o token foi invalidado em nível de usuário
   *
   * Duas regras, na ordem de preferência:
   *
   * 1. **Versão de sessão** (`sv`): comparo contra o contador atual. Sem
   *    problema de precisão de relógio, e é o caminho dos tokens emitidos hoje.
   * 2. **Timestamp** (`user_tokens_revoked`), para tokens emitidos antes da
   *    existência da claim. Grain de segundo: Conservative por natureza, porque
   *    o token perde o mesmo segundo em que a revogação aconteceu.
   *
   * @param payload - Payload decodificado do token
   * @returns true se o token foi invalidado
   */
  async isUserRevoked(payload: JwtIssuedPayload): Promise<boolean> {
    const userId = payload.id;
    if (!this.redisClient || !userId) {
      return false;
    }

    try {
      if (typeof payload.sv === 'number') {
        const current = await this.redisClient.get(`${USER_SESSION_VERSION_PREFIX}${userId}`);
        const version = current === null ? 0 : parseInt(current as string, 10);
        return payload.sv < (Number.isNaN(version) ? 0 : version);
      }

      if (!payload.iat) {
        return false;
      }

      const revokedAt = await this.redisClient.get(`${USER_TOKENS_REVOKED_PREFIX}${userId}`);
      if (!revokedAt) {
        return false;
      }
      return payload.iat * 1000 < parseInt(revokedAt as string, 10);
    } catch (error) {
      return this.handleRevocationError('verificar revogação do usuário', error);
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

      // Consumo único ATÔMICO antes de emitir o novo par: o marcador entra na
      // blacklist com SET NX, então das N requisições simultâneas com o mesmo
      // refresh token apenas uma ganha o direito de rotacionar. As demais caem
      // em 401, fechando a janela de corrida entre "verificar" e "revogar".
      await this.consumeRefreshToken(refreshToken, decoded);

      // Gerar novo par de tokens
      const newTokens = await this.generateTokenPairAtSessionVersion(
        { id: decoded.id, username: decoded.username },
        options,
        decoded.sv ?? 0
      );

      return newTokens;
    } catch (error) {
      // Preservar códigos de erro de token (expirado/inválido/reusado)
      if ((error as Error & { code?: string }).code) {
        throw error;
      }
      throw new Error(`Erro ao renovar tokens: ${(error as Error).message}`);
    }
  }

  /**
   * Marca o refresh token como consumido de forma atômica (SET NX).
   *
   * O marcador é a própria entrada de blacklist (`rotated`), com TTL igual ao
   * tempo de vida restante do token - a blacklist não precisa crescer além da
   * expiração natural do token.
   * @param token - Refresh token verificado
   * @param payload - Payload decodificado do token
   * @throws REFRESH_TOKEN_REUSED quando o token já foi rotacionado
   * @throws REFRESH_TOKEN_INVALID quando o token já havia sido revogado
   */
  private async consumeRefreshToken(token: string, payload: JwtIssuedPayload): Promise<void> {
    if (!this.redisClient) {
      // fail-open: sem armazenamento não é possível garantir consumo único.
      logger.warn('Rotação sem controle de consumo único (fail-open): refresh token NÃO invalidado');
      return;
    }

    const key = this.blacklistKey(token);
    const ttlSeconds = this.remainingTtlSeconds(payload);

    try {
      // NX: só a primeira requisição escreve. null = alguém já consumiu.
      const claimed = await this.redisClient.set(key, BLACKLIST_ROTATED_VALUE, { NX: true, EX: ttlSeconds });
      if (claimed !== null) {
        return;
      }

      const reason = await this.redisClient.get(key);
      const reused = reason === BLACKLIST_ROTATED_VALUE;
      const error = new Error(
        reused
          ? 'Refresh token já utilizado - possível reuso de token'
          : 'Refresh token foi revogado'
      );
      (error as Error & { code?: string }).code = reused ? 'REFRESH_TOKEN_REUSED' : 'REFRESH_TOKEN_INVALID';
      if (reused) {
        (error as Error & { userId?: string }).userId = payload.id;
      }
      throw error;
    } catch (error) {
      if ((error as Error & { code?: string }).code) {
        throw error;
      }
      this.handleRevocationError('rotacionar refresh token', error);
    }
  }

  /**
   * Revoga um token adicionando-o à blacklist
   * @param token - Token a revogar
   * @param expiresIn - Tempo até expiração (ms)
   * @returns Sucesso da operação
   */
  async revokeToken(token: string, expiresIn = 3600000): Promise<boolean> {
    this.assertRevocationAvailable();

    if (!this.redisClient) {
      logger.warn('Redis não disponível para revogação de tokens (fail-open): token NÃO revogado');
      return false;
    }

    try {
      await this.redisClient.setEx(
        this.blacklistKey(token),
        this.blacklistTtlSeconds(token, expiresIn),
        BLACKLIST_REVOKED_VALUE
      );
      return true;
    } catch (error) {
      return this.handleRevocationError('revogar token', error);
    }
  }

  /**
   * Revoga todos os tokens de um usuário
   *
   * Incrementa a versão de sessão (caminho usado pelos tokens atuais) e
   * mantém o timestamp (para tokens antigos, sem a claim `sv`).
   *
   * @param userId - ID do usuário
   * @param expiresIn - Tempo de validade da revogação (ms)
   * @returns Sucesso da operação
   */
  async revokeUserTokens(userId: string, expiresIn = 604800000): Promise<boolean> {
    this.assertRevocationAvailable();

    if (!this.redisClient) {
      logger.warn('Redis não disponível para revogação de tokens do usuário (fail-open): tokens NÃO revogados');
      return false;
    }

    try {
      const ttlSeconds = this.toTtlSeconds(expiresIn);
      const versionKey = `${USER_SESSION_VERSION_PREFIX}${userId}`;

      await this.redisClient.incr(versionKey);
      await this.redisClient.expire(versionKey, ttlSeconds);
      await this.redisClient.setEx(`${USER_TOKENS_REVOKED_PREFIX}${userId}`, ttlSeconds, Date.now().toString());
      return true;
    } catch (error) {
      return this.handleRevocationError('revogar tokens do usuário', error);
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
      const result = await this.redisClient.get(this.blacklistKey(token));
      if (result !== null) {
        return true;
      }

      // Transição: tokens emitidos antes da adoption do `jti` eram gravados com
      // o token completo como chave. Só tokens sem `jti` pagam essa segunda
      // leitura, e eles expiram sozinhos em no máximo 7 dias.
      if (this.extractJti(token)) {
        return false;
      }

      const legacy = await this.redisClient.get(`${BLACKLIST_PREFIX}${token}`);
      return legacy !== null;
    } catch (error) {
      return this.handleRevocationError('verificar blacklist', error);
    }
  }

  /**
   * Decodifica um token SEM validar a assinatura
   * Útil apenas para inspeção, não use para segurança
   * @param token - Token a decodificar
   * @returns Payload decodificado
   */
  decodeToken(token: string): JwtIssuedPayload | null {
    return this.accessSigner.decode(token);
  }
}
