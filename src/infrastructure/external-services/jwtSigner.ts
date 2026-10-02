/**
 * @fileoverview Assinatura de JWT: HS256 (legado/dev) e ES256 (produção)
 *
 * A verificação de assinatura é um detalhe de infraestrutura, não de domínio.
 * Este módulo concentra as duas implementações atrás de uma interface, e o
 * `JWTTokenService` continua decidindo *quando* assinar/verificar, sobre quais
 * claims e como revogar.
 *
 * ## Por que ES256
 *
 * HS256 é simétrico: quem assina também verifica, então todo processo que
 * valida um token precisa do segredo de assinatura. Isso transforma cada
 * verificador em um emissor — e um segredo vazado passa a permitir forjar
 * token. Com ES256 (ECDSA P-256), a chave privada fica só em quem emite e a
 * pública (que não é segredo) verifica em qualquer lugar.
 *
 * ## Por que `kid`
 *
 * A rotação de chave assinatura é inevitável. Sem identificador no header, o
 * verificador não sabe qual das chaves é a boa e teria que testar todas — ou,
 * pior, aceitar a mais recente e derrubar os tokens ainda vivos de quem tinha
 * login antes da troca. O `kid` torna a rotação explícita: a chave nova assina,
 * a antiga continua verificando até o fim da janela.
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import { createPrivateKey } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI, decodeJwt, type CryptoKey } from 'jose';

/**
 * Claims que o serviço de autenticação emite. Espelha o payload que o
 * `JWTTokenService` já usava, sem carregar campos que a assinatura não usa.
 */
export interface TokenClaims {
  id: string;
  username: string;
  token_type?: 'access' | 'refresh';
  /** Versão de sessão: amarra o token ao contador de revogação do usuário. */
  sv?: number;
  iat?: number;
  exp?: number;
  jti?: string;
}

export interface SignRequest {
  payload: TokenClaims;
  /** Mesma sintaxe aceita pelo `jsonwebtoken` (`15m`, `7d`). */
  expiresIn: string;
  issuer: string;
  audience: string;
  subject: string;
  jwtid: string;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
}

/**
 * Contrato de assinatura. Duas implementações, uma escolha no bootstrap.
 */
export interface TokenSigner {
  readonly algorithm: string;
  /** Identificador da chave no header (`kid`). Ausente em HS256. */
  readonly kid: string | undefined;
  sign(request: SignRequest): Promise<string>;
  verify(token: string, options: VerifyOptions): Promise<TokenClaims>;
  /** Lê as claims SEM validar a assinatura (inspeção, não segurança). */
  decode(token: string): TokenClaims | null;
}

/**
 * Normaliza o erro de expiração para o nome que o `JWTTokenService` já mapeia.
 *
 * As duas bibliotecas usam nomes diferentes (`TokenExpiredError` no
 * `jsonwebtoken`, `JWTExpired` no `jose`). Traduzir aqui mantém o contrato HTTP
 * (`TOKEN_EXPIRED` / `REFRESH_TOKEN_EXPIRED`) igual nos dois caminhos, em vez
 * de espalhar a diferença pelo serviço.
 */
const asExpiredError = (error: unknown): unknown => {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ERR_JWT_EXPIRED') {
    const expired = new Error('Token expirado');
    expired.name = 'TokenExpiredError';
    return expired;
  }
  return error;
};

/**
 * HS256 — simétrico, mantido para dev/test e para os testes que fabricam token
 * legado. `algorithms: ['HS256']` é explícito: sem isso, a biblioteca aceita o
 * que vier no header, e um token sem assinatura (`alg: none`) seria aceito.
 */
export class Hs256Signer implements TokenSigner {
  readonly algorithm = 'HS256';
  readonly kid = undefined;

  constructor(private readonly secret: string) {}

  async sign({ payload, expiresIn, issuer, audience, subject, jwtid }: SignRequest): Promise<string> {
    return jwt.sign(payload, this.secret, {
      algorithm: 'HS256',
      expiresIn: expiresIn as SignOptions['expiresIn'],
      issuer,
      audience,
      subject,
      jwtid
    });
  }

  async verify(token: string, { issuer, audience }: VerifyOptions): Promise<TokenClaims> {
    return jwt.verify(token, this.secret, { algorithms: ['HS256'], issuer, audience }) as TokenClaims;
  }

  decode(token: string): TokenClaims | null {
    const decoded = jwt.decode(token);
    return decoded && typeof decoded === 'string' ? null : (decoded as TokenClaims | null);
  }
}

export interface Es256Keys {
  /** Identificador da chave que assina; vai no header do token. */
  kid: string;
  /** Chave privada PEM PKCS#8. Só o emissor a recebe. */
  privateKeyPem: string;
  /** Chave pública PEM SPKI correspondente. */
  publicKeyPem: string;
  /** Chave anterior, mantida só para verificação durante a rotação. */
  previousKid?: string;
  previousPublicKeyPem?: string;
}

/**
 * Importa a chave privada aceitando os dois formatos de PEM que aparecem no
 * mundo real para a mesma chave.
 *
 * PKCS#8 é o formato nativo do `jose` e o que a provisionação deve emitir. SEC1
 * (`BEGIN EC PRIVATE KEY`) é o que `openssl ecparam -genkey` produz, e o que
 * many KMS e operadores já têm em disco. Recusá-lo não é segurança: é o mesmo
 * par em outra embalagem, e a recusa cobra o preço no lugar errado — o par
 * passa pela conferência de quem provisionou, o processo sobe, e a assinatura
 * quebra no **primeiro login**, respondendo 401 de credencial inválida. Falha
 * de infraestrutura vestida de erro de usuário.
 *
 * A conversão usa o próprio `node:crypto` (que entende os dois formatos) para
 * reexportar em PKCS#8, sem depender do ASN.1 na mão.
 */
const importPrivateKey = async(pem: string): Promise<CryptoKey> => {
  try {
    return await importPKCS8(pem, 'ES256');
  } catch (error) {
    try {
      const reexported = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
      return await importPKCS8(reexported, 'ES256');
    } catch {
      // A exceção que interessa é a primeira, sobre a chave recebida: a segunda
      // é sobre a tentativa de conversão e não ajuda ninguém a corrigir.
      throw error;
    }
  }
};

/**
 * ES256 (ECDSA P-256).
 *
 * A chave de assinatura e as chaves de verificação são importadas uma vez e
 * reaproveitadas: importar PEM faz parse de ASN.1, e isso acontece no caminho
 * de login, não num inicializador.
 */
export class Es256Signer implements TokenSigner {
  readonly algorithm = 'ES256';

  private keys: { signing: CryptoKey; verification: Map<string, CryptoKey> } | null = null;
  private loading: Promise<{ signing: CryptoKey; verification: Map<string, CryptoKey> }> | null = null;

  constructor(private readonly config: Es256Keys) {}

  get kid(): string {
    return this.config.kid;
  }

  private async ready(): Promise<{ signing: CryptoKey; verification: Map<string, CryptoKey> }> {
    if (this.keys) {
      return this.keys;
    }
    if (!this.loading) {
      this.loading = this.importKeys().then((keys) => {
        this.keys = keys;
        return keys;
      });
    }
    return this.loading;
  }

  private async importKeys(): Promise<{ signing: CryptoKey; verification: Map<string, CryptoKey> }> {
    const verification = new Map<string, CryptoKey>();
    verification.set(this.config.kid, await importSPKI(this.config.publicKeyPem, 'ES256'));

    // Janela de rotação: a chave anterior continua verificando tokens que ainda
    // estão vivos. Sem ela, trocar a chave derrubaria todo mundo logado.
    if (this.config.previousKid && this.config.previousPublicKeyPem) {
      verification.set(this.config.previousKid, await importSPKI(this.config.previousPublicKeyPem, 'ES256'));
    }

    const signing = await importPrivateKey(this.config.privateKeyPem);
    return { signing, verification };
  }

  async sign({ payload, expiresIn, issuer, audience, subject, jwtid }: SignRequest): Promise<string> {
    const { signing } = await this.ready();

    return new SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'ES256', kid: this.config.kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setJti(jwtid)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(signing);
  }

  async verify(token: string, { issuer, audience }: VerifyOptions): Promise<TokenClaims> {
    const { verification } = await this.ready();

    try {
      const { payload } = await jwtVerify(
        token,
        header => {
          // `kid` ausente não é "use a primeira": é token de origem desconhecida.
          // Aceitar seria devolver ao "teste todas as chaves" e reabrir a porta
          // que o `kid` fechou.
          const kid = header.kid;
          if (!kid) {
            throw new Error('Token sem kid não é aceito');
          }
          const key = verification.get(kid);
          if (!key) {
            throw new Error(`Chave desconhecida: ${kid}`);
          }
          return key;
        },
        { issuer, audience, algorithms: ['ES256'] }
      );
      // `jose` devolve `JWTPayload` (claims soltas, index signature aberta);
      // quem consome é este serviço, que conhece o payload que emitiu.
      return payload as unknown as TokenClaims;
    } catch (error) {
      throw asExpiredError(error);
    }
  }

  decode(token: string): TokenClaims | null {
    try {
      return decodeJwt(token) as TokenClaims;
    } catch {
      return null;
    }
  }
}
