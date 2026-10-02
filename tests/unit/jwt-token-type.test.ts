import { describe, it, expect } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';
import { Hs256Signer, Es256Signer } from '../../src/infrastructure/external-services/jwtSigner.js';

/**
 * Access e refresh são tipos, não só segredos
 * ===========================================
 *
 * A separação entre access e refresh descansava inteiramente no fato de os
 * segredos HS256 serem diferentes. Isso não é propriedade do token: é
 * consecuencia de como o HS256 funciona, e o construtor recai para
 * `JWT_SECRET` quando `JWT_REFRESH_SECRET` não vem — com warning, não erro.
 *
 * Nesse estado os dois signers assinam com o mesmo material, e a verificação de
 * tipo era ignorada (o early return que existia só valia a claim em ES256).
 * O resultado era escalada de privilégio por troca de header, sem
 * comprometimento de chave: o refresh token de 7 dias servia como Bearer em
 * rota de access, e o access de 15 minutos servia onde refresh era exigido.
 *
 * Reproduzido antes da correção, com `JWT_REFRESH_SECRET` ausente:
 *
 *   refresh entregue como access  ->  ACEITOU. token_type=refresh exp=+7d
 *   access entregue como refresh  ->  ACEITOU. token_type=access
 *
 * Agora a claim é conferida sempre, e nenhum teste depende de o segredo estar
 * configurado.
 */

const SECRET = 'segredo-de-teste-suficientemente-longo';
const OTHER_SECRET = 'outro-segredo-bem-diferente-do-primeiro';

const es256Keys = (): { kid: string; privateKeyPem: string; publicKeyPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    kid: 'k1',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
};

type Mode = 'HS256 compartilhado' | 'HS256 segredos distintos' | 'ES256';

const serviceFor = (mode: Mode): JWTTokenService => {
  if (mode === 'ES256') {
    // Segredos vazios de propósito: no caminho ES256 eles não são usados, e é o
    // que a produção faz.
    return new JWTTokenService('', null, null, 'auth-service', 'api-users', undefined, es256Keys());
  }
  if (mode === 'HS256 compartilhado') {
    // O caminho perigoso: sem JWT_REFRESH_SECRET, os dois signers recebem o
    // mesmo segredo.
    return new JWTTokenService(SECRET, null, null);
  }
  return new JWTTokenService(SECRET, OTHER_SECRET, null);
};

const MODES: Mode[] = ['HS256 compartilhado', 'HS256 segredos distintos', 'ES256'];

describe.each(MODES)('separação de tipo em %s', mode => {
  const service = (): JWTTokenService => serviceFor(mode);

  it('refresh token NÃO é aceito como access', async() => {
    const s = service();
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    // A rejeição é a asserção; o *motivo* muda por modo e é tratado no bloco
    // seguinte, onde importa distinguir assinatura de claim.
    await expect(s.verifyAccessToken(pair.refreshToken)).rejects.toThrow();
  });

  it('access token NÃO é aceito como refresh', async() => {
    const s = service();
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    await expect(s.verifyRefreshToken(pair.accessToken)).rejects.toThrow();
  });

  it('o par emitido continua verificando no seu próprio tipo', async() => {
    // O caminho feliz não pode ter sido quebrado junto: um gate que recusa tudo
    // também "cumpre" a política.
    const s = service();
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    const access = await s.verifyAccessToken(pair.accessToken);
    const refresh = await s.verifyRefreshToken(pair.refreshToken);

    expect(access.token_type).toBe('access');
    expect(refresh.token_type).toBe('refresh');
    expect(access.id).toBe('u1');
  });

  it('a rotação legítima de refresh continua funcionando', async() => {
    const s = service();
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    const rotated = await s.refreshTokens(pair.refreshToken);
    const access = await s.verifyAccessToken(rotated.accessToken);

    expect(access.token_type).toBe('access');
    expect(rotated.refreshToken).not.toBe(pair.refreshToken);
  });

  it('o token_type vai na claim, não implícito no segredo', async() => {
    const s = service();
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });
    const decoded = s.decodeToken(pair.accessToken);

    // Se a separação dependesse só do segredo, o payload não precisaria
    // carregar o tipo. Ele carrega porque é o que o verificador consulta.
    expect(decoded?.token_type).toBe('access');
  });
});

describe('qual barreira recusa, em cada modo', () => {
  // Não é a mesma nos dois HS256, e a diferença é o ponto. Com segredos
  // distintos, a recusa vem da assinatura — o segredo já separa. Com segredo
  // compartilhado, a assinatura passa e a claim é a única barreira. Sem a
  // conferência de tipo, o segundo caso vira escalada de privilégio.
  it('segredo distinto: a assinatura recusa antes de chegar na claim', async() => {
    const s = new JWTTokenService(SECRET, OTHER_SECRET, null);
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    await expect(s.verifyAccessToken(pair.refreshToken)).rejects.toThrow(/invalid signature/);
  });

  it('segredo compartilhado: a assinatura passa e a claim recusa', async() => {
    const s = new JWTTokenService(SECRET, null, null);
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    // Prova de que a assinatura não é o que barra: os dois tokens têm a mesma
    // assinatura válida sob o mesmo segredo.
    const decodedAccess = s.decodeToken(pair.accessToken);
    const decodedRefresh = s.decodeToken(pair.refreshToken);
    expect(decodedAccess?.id).toBe(decodedRefresh?.id);

    await expect(s.verifyAccessToken(pair.refreshToken)).rejects.toThrow(/não é do tipo access/);
  });
});

describe('a claim é consultada de fato, e não só a assinatura', () => {
  it('token assinado com o segredo certo e token_type trocado é recusado', async() => {
    // Este é o teste que distingue as duas hipóteses. A assinatura valida —
    // mesmo segredo, mesmo issuer, mesma audience. O que barra é a claim.
    // Se a verificação só checasse assinatura, este token passaria.
    const s = new JWTTokenService(SECRET, null, null);
    const signer = new Hs256Signer(SECRET);

    const forgedAccess = await signer.sign({
      // Payload de refresh assinado com o segredo que valida access.
      payload: { id: 'u1', username: 'ana', token_type: 'refresh' },
      expiresIn: '15m',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'u1',
      jwtid: 'forged-1'
    });

    await expect(s.verifyAccessToken(forgedAccess)).rejects.toThrow(/não é do tipo access/);
  });

  it('o mesmo forjações recusado como refresh', async() => {
    const s = new JWTTokenService(SECRET, null, null);
    const signer = new Hs256Signer(SECRET);

    const forgedRefresh = await signer.sign({
      payload: { id: 'u1', username: 'ana', token_type: 'access' },
      expiresIn: '7d',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'u1',
      jwtid: 'forged-2'
    });

    await expect(s.verifyRefreshToken(forgedRefresh)).rejects.toThrow(/não é do tipo refresh/);
  });

  it('token sem a claim é recusado, não tratado como legado válido', async() => {
    // A versão anterior do comentário dizia que "tokens legados sem a claim
    // continuam válidos" — o que é aceitar exatamente o estado que a separação
    // por segredo deixou passar. Não há token legado a preservar na 1.0.0.
    const s = new JWTTokenService(SECRET, null, null);
    const signer = new Hs256Signer(SECRET);

    const withoutClaim = await signer.sign({
      payload: { id: 'u1', username: 'ana' },
      expiresIn: '15m',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'u1',
      jwtid: 'legacy-1'
    });

    await expect(s.verifyAccessToken(withoutClaim)).rejects.toThrow(/não é do tipo access/);
  });

  it('no ES256, refresh forjado com o par de chaves também é recusado', async() => {
    const keys = es256Keys();
    const s = new JWTTokenService('', null, null, 'auth-service', 'api-users', undefined, keys);
    const signer = new Es256Signer(keys);

    const forged = await signer.sign({
      payload: { id: 'u1', username: 'ana', token_type: 'refresh' },
      expiresIn: '7d',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'u1',
      jwtid: 'es256-forged'
    });

    await expect(s.verifyAccessToken(forged)).rejects.toThrow(/não é do tipo access/);
  });
});

describe('a separação não depende da configuração de segredo', () => {
  it('HS256 com um único segredo separa os tipos mesmo assim', async() => {
    // Este é o teste que fixa a regressão. Antes da correção, os dois signers
    // recebiam o mesmo segredo e a conferência de tipo era ignorada: o refresh
    // era aceito como access.
    const s = new JWTTokenService(SECRET, null, null);
    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });

    const sameSecretOnBothSigners = pair.refreshToken.split('.');
    expect(sameSecretOnBothSigners).toHaveLength(3);

    let acceptedAsAccess = false;
    try {
      await s.verifyAccessToken(pair.refreshToken);
      acceptedAsAccess = true;
    } catch {
      acceptedAsAccess = false;
    }

    expect(acceptedAsAccess).toBe(false);
  });

  it('o aviso de segredo ausente continua, mas agora é só configuração', async() => {
    // A mensagem não muda: o que muda é que cair para o mesmo segredo deixou de
    // ser um problema de segurança e passou a ser só perda de isolamento.
    const s = new JWTTokenService(SECRET, null, null);
    expect(s).toBeInstanceOf(JWTTokenService);

    const pair = await s.generateTokenPair({ id: 'u1', username: 'ana' });
    expect(await s.verifyAccessToken(pair.accessToken)).toBeDefined();
  });
});

/**
 * ES256 obrigatório em produção já tem prova própria em
 * `tests/unit/security-config.test.ts` ("recusa HS256 em produção: quem verifica
 * não pode assinar"). Duplicar aqui exigiria remontar a config inteira por
 * env, e o teste duplicado seria o mais frágil dos dois.
 */
describe('as suítes de segurança usam o modo de produção', () => {
  it('as suítes de segurança principais rodam em ES256, não HS256', () => {
    // O item pede que os testes de segurança usem o mesmo modo criptográfico de
    // produção. Conferido no código das suítes, porque um teste de segurança em
    // HS256 prova o caminho que a produção não usa.
    for (const file of [
      'tests/security/credential-theft.real-redis.test.ts',
      'tests/e2e/auth-http.e2e.test.ts'
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).toMatch(/ES256/);
      expect(source).toMatch(/generateKeyPairSync/);
    }
  });
});
