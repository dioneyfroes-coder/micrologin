import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProtectedHeader } from 'jose';
import { Es256Signer } from '../../src/infrastructure/external-services/jwtSigner.js';

/**
 * Prova que a chave que a provisionação entrega é a chave que o emissor lê.
 *
 * These testes vivem separados de propósito. `jwt-signer.test.ts` gera o par
 * com `generateKeyPairSync` e por isso passava verde com a aplicação inteira
 * quebrada em produção: o formato PKCS#8 do Node é o que o `jose` quer, e o
 * `scripts/generate-jwt-keys.sh` entregava SEC1 (`BEGIN EC PRIVATE KEY`, o
 * formato do `openssl ecparam -genkey`). O par estava correto — a pública
 * conferia com a privada, o script se autoconferia e o container subia — e a
 * assinatura quebrava no primeiro login, respondendo 401 de credencial
 * inválida. Duas suítes que nunca se encontram provam duas metades que não
 * formam um sistema.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(ROOT, 'scripts/generate-jwt-keys.sh');

const runGenerator = (args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
};

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'jwt-keys-'));

describe('provisionamento do par ES256', () => {
  it('entrega uma chave que o Es256Signer consegue assinar', async() => {
    const dir = freshDir();
    const result = runGenerator([dir, 'script-teste']);

    // Sem openssl o script nem roda. Falhar aqui diz a verdade; pular o teste
    // diria que a provisionação foi verificada quando ninguém a verificou.
    expect(result.status).toBe(0);

    const privateKeyPem = readFileSync(join(dir, 'jwt-es256-private.pem'), 'utf8');
    const publicKeyPem = readFileSync(join(dir, 'jwt-es256-public.pem'), 'utf8');

    const signer = new Es256Signer({ kid: 'script-teste', privateKeyPem, publicKeyPem });
    const token = await signer.sign({
      payload: { id: 'user-1', username: 'ana', token_type: 'access' },
      expiresIn: '15m',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'user-1',
      jwtid: 'jti-1'
    });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('script-teste');

    const claims = await signer.verify(token, { issuer: 'auth-service', audience: 'api-users' });
    expect(claims.username).toBe('ana');
  });

  it('entrega a privada em PKCS#8, que é o que o jose importa', () => {
    const dir = freshDir();
    expect(runGenerator([dir, 'formato']).status).toBe(0);

    const privateKeyPem = readFileSync(join(dir, 'jwt-es256-private.pem'), 'utf8');

    // SEC1 (`BEGIN EC PRIVATE KEY`) é a mesma chave em outra embalagem, e
    // quebraria a assinatura. A conferência é do cabeçalho porque o erro
    // apareceria em produção como 401 de credencial inválida.
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(privateKeyPem).not.toContain('BEGIN EC PRIVATE KEY');
  });

  it('entrega a privada em modo 600 e a pública legível', () => {
    const dir = freshDir();
    expect(runGenerator([dir, 'permissoes']).status).toBe(0);

    const privateStats = statSync(join(dir, 'jwt-es256-private.pem'));
    const publicStats = statSync(join(dir, 'jwt-es256-public.pem'));
    // Windows não tem permissões POSIX: o `stat().mode` reflete 0o666
    // independentemente do `chmod`. O guard de 0o600/0o644 é verificado no CI
    // (Linux); aqui a existência e a leitura dos artefatos seguem valendo.
    if (process.platform !== 'win32') {
      expect(privateStats.mode & 0o777).toBe(0o600);
      expect(publicStats.mode & 0o777).toBe(0o644);
    }
  });

  it('recusa sobrescrever um par existente: rotacionar é deliberado', () => {
    const dir = freshDir();
    expect(runGenerator([dir, 'primeiro']).status).toBe(0);

    const second = runGenerator([dir, 'segundo']);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('ja existe');
  });

  it('recusa um argumento desconhecido em vez de gerar material pela metade', () => {
    const dir = freshDir();
    const result = runGenerator([dir, 'kid', '--inventado']);

    expect(result.status).toBe(2);
    expect(() => statSync(join(dir, 'jwt-es256-private.pem'))).toThrow();
  });
});

describe('o emissor aceita o par em SEC1, que já está em uso em ambientes reais', () => {
  it('assina com chave privada exportada em SEC1', async() => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // O mesmo par do script antigo, no formato do `openssl ecparam -genkey` e
    // de boa parte dos KMS. Recusá-lo não protege nada: cobra no lugar errado,
    // no primeiro login de quem já tinha o material provisionado.
    // A volta por PEM é real: sob `jest --experimental-vm-modules` o KeyObject
    // sai de outro realm e `createPrivateKey` o rejeita por instanceof.
    const sec1Pem = createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
      .export({ type: 'sec1', format: 'pem' })
      .toString();

    const signer = new Es256Signer({
      kid: 'sec1',
      privateKeyPem: sec1Pem,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });

    const token = await signer.sign({
      payload: { id: 'user-1', username: 'ana', token_type: 'access' },
      expiresIn: '15m',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'user-1',
      jwtid: 'jti-1'
    });

    const claims = await signer.verify(token, { issuer: 'auth-service', audience: 'api-users' });
    expect(claims.id).toBe('user-1');
  });

  it('ainda recusa material que não é chave EC', async() => {
    const dir = freshDir();
    // Chave RSA: o par é válido, a curva não é a do header `alg: ES256`.
    execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', join(dir, 'rsa.pem')]);
    const rsaPem = readFileSync(join(dir, 'rsa.pem'), 'utf8');
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    const signer = new Es256Signer({
      kid: 'rsa',
      privateKeyPem: rsaPem,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });

    await expect(signer.sign({
      payload: { id: 'user-1', username: 'ana' },
      expiresIn: '15m',
      issuer: 'auth-service',
      audience: 'api-users',
      subject: 'user-1',
      jwtid: 'jti-1'
    })).rejects.toThrow();
  });
});

describe('o uid da chave acompanha o usuário da imagem', () => {
  it('o APP_UID padrão do script é o mesmo nodeuser do Dockerfile', () => {
    // O `--for-container` entrega a chave para o uid que roda o app dentro da
    // imagem. Se o Dockerfile mudar de uid e o script não acompanhar, o chown
    // deixa de ser o motivo e o app volta a recusar arrancar por permissão —
    // outra falha que só aparece no container, nunca no teste.
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    const uid = /adduser\s+-S\s+\S+\s+-u\s+(\d+)/.exec(dockerfile)?.[1];

    expect(uid).toBeDefined();
    expect(readFileSync(SCRIPT, 'utf8')).toContain('JWT_KEYS_APP_UID:-' + uid);
  });

  it('a imagem base do chown é a mesma que a imagem da aplicação', () => {
    // `docker run` de uma imagem que não existe baixa na hora; a imagem base do
    // Dockerfile já está local em quem construiu o serviço.
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');
    const base = /^FROM\s+(\S+)\s+AS\s+base/m.exec(dockerfile)?.[1];

    expect(base).toBeDefined();
    expect(readFileSync(SCRIPT, 'utf8')).toContain(`JWT_KEYS_CHOWN_IMAGE:-${base}`);
  });
});
