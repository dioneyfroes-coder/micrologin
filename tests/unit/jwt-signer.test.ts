import { describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { Es256Signer, Hs256Signer, type Es256Keys } from '../../src/infrastructure/external-services/jwtSigner.js';
import { JWTTokenService } from '../../src/infrastructure/external-services/jwtTokenService.js';

const pair = (): Es256Keys => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    kid: 'v1',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
};

const claim = { issuer: 'auth-service', audience: 'api-users', subject: 'user-1', jwtid: 'jti-1' };

describe('Es256Signer', () => {
  it('assina e verifica preservando as claims', async() => {
    const keys = pair();
    const signer = new Es256Signer(keys);

    const token = await signer.sign({
      payload: { id: 'user-1', username: 'ana', token_type: 'access' },
      expiresIn: '15m',
      ...claim
    });
    const claims = await signer.verify(token, { issuer: claim.issuer, audience: claim.audience });

    expect(claims.id).toBe('user-1');
    expect(claims.username).toBe('ana');
    expect(claims.token_type).toBe('access');
    expect(claims.jti).toBe('jti-1');
    expect(signer.algorithm).toBe('ES256');
    expect(signer.kid).toBe('v1');
  });

  it('publica o kid da chave de assinatura no header', async() => {
    const signer = new Es256Signer({ ...pair(), kid: '2026-q3' });

    const token = await signer.sign({
      payload: { id: 'u', username: 'ana' },
      expiresIn: '15m',
      ...claim
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: '2026-q3', typ: 'JWT' });
  });

  it('rejeita token assinado por outra chave', async() => {
    const signer = new Es256Signer(pair());
    const impostor = new Es256Signer({ ...pair(), kid: 'v1' });

    const token = await impostor.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

    await expect(signer.verify(token, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow();
  });

  it('rejeita HS256: algoritmo do header não escolhe a chave', async() => {
    const keys = pair();
    const signer = new Es256Signer(keys);
    const hs256 = new Hs256Signer('a'.repeat(32));

    const token = await hs256.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

    await expect(signer.verify(token, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow();
  });

  it('rejeita token sem assinatura (alg: none)', async() => {
    const keys = pair();
    const signer = new Es256Signer(keys);

    // Token montado à mão com a claims e header de um token real, mas sem
    // assinatura: é o ataque que a allowlist `algorithms` existe para barrar.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${
      Buffer.from(JSON.stringify({ id: 'u', username: 'ana', iss: claim.issuer, aud: claim.audience })).toString('base64url')
    }.`;

    await expect(signer.verify(unsigned, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow();
  });

  it('rejeita token sem kid: origem desconhecida não é "use a primeira chave"', async() => {
    const keys = pair();
    const signer = new Es256Signer(keys);
    // Outro par declarando o mesmo `kid`: o verificador não pode confiar no
    // header, e sim na assinatura.
    const other = new Es256Signer({ ...pair(), kid: 'v1' });
    const token = await other.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

    const noKid = token
      .split('.')
      .map((part, index) => {
        if (index !== 0) {
          return part;
        }
        const header = JSON.parse(Buffer.from(part, 'base64url').toString());
        delete header.kid;
        return Buffer.from(JSON.stringify(header)).toString('base64url');
      })
      .join('.');

    await expect(signer.verify(noKid, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow(/kid/);
    expect(keys.publicKeyPem).toBeDefined();
  });

  it('rejeita kid desconhecido', async() => {
    const signer = new Es256Signer({ ...pair(), kid: 'v2' });

    const token = await new Es256Signer({ ...pair(), kid: 'v1' }).sign({
      payload: { id: 'u', username: 'ana' },
      expiresIn: '15m',
      ...claim
    });

    await expect(signer.verify(token, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow(/v1/);
  });

  it('rejeita issuer ou audience divergentes', async() => {
    const signer = new Es256Signer(pair());
    const token = await signer.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

    await expect(signer.verify(token, { issuer: 'outro-servico', audience: claim.audience })).rejects.toThrow();
    await expect(signer.verify(token, { issuer: claim.issuer, audience: 'outra-api' })).rejects.toThrow();
  });

  it('traduz expiração para TokenExpiredError, mantendo o contrato HTTP', async() => {
    const signer = new Es256Signer(pair());
    const token = await signer.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '-1s', ...claim });

    await expect(signer.verify(token, { issuer: claim.issuer, audience: claim.audience }))
      .rejects.toMatchObject({ name: 'TokenExpiredError' });
  });

  describe('rotação de chave', () => {
    it('mantém tokens da chave anterior válidos enquanto a nova assina', async() => {
      const previous = pair();
      const rotated = new Es256Signer({
        ...pair(),
        kid: 'v2',
        previousKid: previous.kid,
        previousPublicKeyPem: previous.publicKeyPem
      });

      const antigoDoV1 = await new Es256Signer(previous).sign({
        payload: { id: 'u', username: 'ana' },
        expiresIn: '15m',
        ...claim
      });
      const novoDoV2 = await rotated.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

      expect(decodeProtectedHeader(antigoDoV1).kid).toBe('v1');
      expect(decodeProtectedHeader(novoDoV2).kid).toBe('v2');
      // A janela de rotação existe para não derrubar quem já estava logado.
      await expect(rotated.verify(antigoDoV1, { issuer: claim.issuer, audience: claim.audience })).resolves.toBeTruthy();
      await expect(rotated.verify(novoDoV2, { issuer: claim.issuer, audience: claim.audience })).resolves.toBeTruthy();
    });

    it('encerra a janela quando a chave anterior é removida', async() => {
      const previous = pair();
      const tokenDoV1 = await new Es256Signer(previous).sign({
        payload: { id: 'u', username: 'ana' },
        expiresIn: '15m',
        ...claim
      });

      const semJanela = new Es256Signer({ ...pair(), kid: 'v2' });

      await expect(semJanela.verify(tokenDoV1, { issuer: claim.issuer, audience: claim.audience })).rejects.toThrow(/v1/);
    });

    it('assina sempre com a chave nova, nunca com a anterior', async() => {
      const previous = pair();
      const rotated = new Es256Signer({
        ...pair(),
        kid: 'v2',
        previousKid: previous.kid,
        previousPublicKeyPem: previous.publicKeyPem
      });

      const token = await rotated.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

      expect(decodeProtectedHeader(token).kid).toBe('v2');
    });
  });

  it('decodifica sem verificar, e devolve null em token ilegível', async() => {
    const signer = new Es256Signer(pair());
    const token = await signer.sign({ payload: { id: 'u', username: 'ana' }, expiresIn: '15m', ...claim });

    expect(signer.decode(token)).toMatchObject({ id: 'u', username: 'ana' });
    expect(signer.decode('não-é-um-jwt')).toBeNull();
  });
});

describe('JWTTokenService com ES256', () => {
  const service = () => new JWTTokenService('', null, null, 'auth-service', 'api-users', { failOpen: true }, pair());

  it('gera par com access e refresh assinados pela mesma chave, mas claims distintas', async() => {
    const tokenService = service();

    const { accessToken, refreshToken, type, expiresIn } = await tokenService.generateTokenPair({
      id: 'user-1',
      username: 'ana'
    });

    expect(type).toBe('Bearer');
    expect(expiresIn).toBeGreaterThan(0);
    expect(accessToken).not.toBe(refreshToken);
    expect(decodeJwt(accessToken).token_type).toBe('access');
    expect(decodeJwt(refreshToken).token_type).toBe('refresh');
    expect(decodeProtectedHeader(accessToken)).toMatchObject({ alg: 'ES256', kid: 'v1' });
  });

  it('não aceita refresh token como access: sem isso, o logout não encerra a sessão', async() => {
    const tokenService = service();
    const { refreshToken } = await tokenService.generateTokenPair({ id: 'user-1', username: 'ana' });

    await expect(tokenService.verifyAccessToken(refreshToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(tokenService.verifyRefreshToken(refreshToken)).resolves.toMatchObject({ id: 'user-1' });
  });

  it('não aceita access token como refresh: renovar não pode virar prolongar sessão', async() => {
    const tokenService = service();
    const { accessToken } = await tokenService.generateTokenPair({ id: 'user-1', username: 'ana' });

    await expect(tokenService.verifyRefreshToken(accessToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_INVALID'
    });
  });

  it('mantém a separação por segredo no caminho HS256, sem exigir a claim', async() => {
    // Compatibilidade: tokens legados de HS256 não têm `token_type`, e o par de
    // segredos já impede a troca. A checagem da claim é específica do ES256.
    const legacy = new JWTTokenService('a'.repeat(32), 'b'.repeat(32));
    const { accessToken } = await legacy.generateTokenPair({ id: 'user-1', username: 'ana' });

    expect(decodeProtectedHeader(accessToken)).toMatchObject({ alg: 'HS256' });
    await expect(legacy.verifyAccessToken(accessToken)).resolves.toMatchObject({ id: 'user-1' });
  });

  it('recusa token assinado por outro par de chaves', async() => {
    const tokenService = service();
    const outro = new JWTTokenService('', null, null, 'auth-service', 'api-users', { failOpen: true }, pair());

    const { accessToken } = await outro.generateTokenPair({ id: 'user-1', username: 'ana' });

    await expect(tokenService.verifyAccessToken(accessToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('continua usando jti e sv para revogação em ambos os caminhos', async() => {
    const tokenService = service();
    const { accessToken, refreshToken } = await tokenService.generateTokenPair({ id: 'user-1', username: 'ana' });

    expect(decodeJwt(accessToken).jti).toBeTruthy();
    expect(decodeJwt(refreshToken).jti).toBeTruthy();
    // jti distintos: revogar o refresh não pode derrubar o access da mesma
    // operação.
    expect(decodeJwt(accessToken).jti).not.toBe(decodeJwt(refreshToken).jti);
  });

  it('recusa segredo vazio sem material ES256', () => {
    expect(() => new JWTTokenService('')).toThrow(/JWT_SECRET é obrigatório/);
  });

  it('gera token com SignJWT compatível com o que o verificador exige', async() => {
    const keys = pair();
    const signer = new Es256Signer(keys);
    const manual = await new SignJWT({ id: 'u', username: 'ana', token_type: 'access' })
      .setProtectedHeader({ alg: 'ES256', kid: 'v1' })
      .setIssuer(claim.issuer)
      .setAudience(claim.audience)
      .setSubject('user-1')
      .setJti('manual')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(await import('jose').then(({ importPKCS8 }) => importPKCS8(keys.privateKeyPem, 'ES256')));

    await expect(signer.verify(manual, { issuer: claim.issuer, audience: claim.audience })).resolves.toMatchObject({
      id: 'u'
    });
  });
});
