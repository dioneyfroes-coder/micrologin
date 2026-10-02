import { describe, it, expect, jest } from '@jest/globals';
import { AuthService, User, REVOCATION_UNAVAILABLE_CODE } from '../../src/domain/index.js';

/**
 * A troca de senha e a exclusão de conta terminam sessões. A pergunta que este
 * arquivo responde é sempre a mesma: **e quando o armazenamento de revogação
 * falha?**
 *
 * A ordem do código é a garantia de segurança, e a ordem errada produz um
 * estado que ninguém consegue desfazer:
 *
 *     gravar senha nova  -> sucesso
 *     revogar sessões    -> falha (silenciosamente, porque o boolean
 *                            devolvido não era checado)
 *
 * Nesse estado a senha mudou, as sessões antigas seguem válidas, o usuário
 * recebe 200 e não existe registro de que algo deu errado. Todo o resto do
 * caso de uso pode falhar sem consequência de segurança; esta sequência, não.
 *
 * Por isso os testes verificam a ORDEM (revogar antes de gravar/remover) e não
 * apenas o desfecho. Um teste que só olhasse `success === true` passaria com as
 * duas implementações.
 */

const makeLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

const CURRENT = 'SenhaAtual#1aA';
const NEXT = 'Poente#Sereno19x';

const HASH_ATUAL = 'hash-da-senha-atual';
const HASH_NOVO = 'hash-da-senha-nova';

/**
 * Entidade real, não um objeto de mentira: a troca de senha passa por
 * `user.changePassword()`, e um duplo sem esse método faria o teste cair no
 * `catch` externo — verde por acidente, sem exercitar a ordem que importa.
 */
const makeUser = (id = 'u-1') =>
  new User(id, 'alice', HASH_ATUAL, new Date('2024-01-01'), new Date('2024-01-01'));

/**
 * Crypto que compara de verdade contra um "banco" de dois hashes. O detalhe que
 * importa: `compare` precisa responder `false` para a senha nova, senão o
 * caso de uso entende que ela é um reuso da atual e recusa antes de chegar à
 * revogação — o teste passaria sem nunca exercitar a ordem.
 */
const crypto = {
  hash: jest.fn(async() => HASH_NOVO),
  compare: jest.fn(async(plain: string, stored: string) =>
    (plain === CURRENT && stored === HASH_ATUAL) || (plain === NEXT && stored === HASH_NOVO))
};

const callOrder = (mock: { mock: { invocationCallOrder: number[] } }): number =>
  mock.mock.invocationCallOrder[0];

describe('troca de senha - ordem entre revogação e gravação', () => {
  it('revoga ANTES de gravar a nova senha', async() => {
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      save: jest.fn().mockImplementation(async(u: unknown) => u)
    };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(true);
    expect(tokens.revokeUserTokens).toHaveBeenCalledWith('u-1');
    expect(callOrder(tokens.revokeUserTokens)).toBeLessThan(callOrder(repo.save));
  });

  it('revogação que lança exceção -> senha NÃO muda', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()), save: jest.fn() };
    const tokens = { revokeUserTokens: jest.fn().mockRejectedValue(new Error('Redis fora do ar')) };

    const result = await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(false);
    // O ponto inteiro: nada foi gravado.
    expect(repo.save).not.toHaveBeenCalled();
    expect(result.code).toBeDefined();
  });

  it('revogação que devolve false -> senha NÃO muda', async() => {
    // Este é o caso que o boolean ignorado deixava passar. `revokeUserTokens`
    // devolvia `false` (fail-open, ou fila cheia) e o código antigo seguia em
    // frente como se a revogação tivesse acontecido.
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()), save: jest.fn() };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(false) };

    const result = await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(false);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('revogação indisponível não acusa a senha atual do usuário', async() => {
    // A senha está certa; o que falhou foi o armazenamento de revogação. Uma
    // mensagem que falasse com "senha atual incorreta" mandaria o usuário
    // conferir uma senha que ele acertou, e o 401 resultante faria o cliente
    // parar de repetir em vez de tentar de novo.
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()), save: jest.fn() };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(false) };

    const service = new AuthService(repo as never, crypto as never, tokens as never, logger);
    const result = await service.changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(false);
    expect(result.code).toBe(REVOCATION_UNAVAILABLE_CODE);
    expect(result.error).not.toMatch(/senha atual/i);
    expect(result.error).toMatch(/não foi possível encerrar as sessões/i);
  });

  it('revogação confirmada + save() com sucesso -> senha muda e sessões encerradas', async() => {
    const logger = makeLogger();
    // A entidade de volta, não `{ ...user }`: o spread de uma instância de
    // classe descarta o protótipo, e `toSafeObject()` sumiria — o teste
    // falharia por um motivo que não tem nada a ver com revogação.
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      save: jest.fn().mockImplementation(async(u: unknown) => u)
    };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(true);
    expect(result.user).toBeDefined();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(tokens.revokeUserTokens).toHaveBeenCalledTimes(1);
  });

  it('revogação confirmada + save() com falha -> nenhuma sessão antiga continua válida', async() => {
    // O estado aceito pela ordem escolhida: sessões encerradas, senha antiga
    // valendo. Seguro e registrado; o inverso (senha trocada com sessão viva) é
    // o que a ordem evita.
    const logger = makeLogger();
    const repo = {
      findById: jest.fn().mockResolvedValue(makeUser()),
      save: jest.fn().mockRejectedValue(new Error('Mongo fora do ar'))
    };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(result.success).toBe(false);
    expect(result.code).toBe('PASSWORD_CHANGE_NOT_PERSISTED');
    // A revogação aconteceu: foi ela que impediu o estado perigoso.
    expect(tokens.revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/sessões foram encerradas/i);
    // O erro não é engolido em silêncio.
    expect(logger.error).toHaveBeenCalled();
  });

  it('registra o cenário de revogação falha antes de gravar', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()), save: jest.fn() };
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(false) };

    await new AuthService(repo as never, crypto as never, tokens as never, logger).changePassword('u-1', CURRENT, NEXT);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('revogação não confirmada'),
      expect.objectContaining({ userId: 'u-1' })
    );
  });
});

describe('exclusão de conta - ordem entre revogação e remoção', () => {
  const repoFor = (overrides: Record<string, unknown> = {}) => ({
    findById: jest.fn().mockResolvedValue(makeUser()),
    delete: jest.fn().mockResolvedValue(undefined),
    ...overrides
  });

  it('revoga ANTES de remover o usuário', async() => {
    const logger = makeLogger();
    const repo = repoFor();
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).deleteUser('u-1');

    expect(result.success).toBe(true);
    expect(callOrder(tokens.revokeUserTokens)).toBeLessThan(callOrder(repo.delete));
  });

  it('revogação indisponível -> usuário permanece', async() => {
    const logger = makeLogger();
    const repo = repoFor();
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(false) };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).deleteUser('u-1');

    expect(result.success).toBe(false);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(result.code).toBeDefined();
  });

  it('revogação lança exceção -> usuário permanece', async() => {
    const logger = makeLogger();
    const repo = repoFor();
    const tokens = { revokeUserTokens: jest.fn().mockRejectedValue(new Error('Redis fora do ar')) };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).deleteUser('u-1');

    expect(result.success).toBe(false);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('revogação ok + delete() falha -> conta preservada e sessões encerradas', async() => {
    const logger = makeLogger();
    const repo = repoFor({ delete: jest.fn().mockRejectedValue(new Error('Mongo fora do ar')) });
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).deleteUser('u-1');

    expect(result.success).toBe(false);
    expect(result.code).toBe('USER_DELETE_NOT_PERSISTED');
    expect(tokens.revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('usuário inexistente -> recusa sem tocar na revogação', async() => {
    const logger = makeLogger();
    const repo = repoFor({ findById: jest.fn().mockResolvedValue(null) });
    const tokens = { revokeUserTokens: jest.fn().mockResolvedValue(true) };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).deleteUser('missing');

    expect(result.success).toBe(false);
    expect(result.code).toBe('USER_NOT_FOUND');
    expect(repo.delete).not.toHaveBeenCalled();
    expect(tokens.revokeUserTokens).not.toHaveBeenCalled();
  });
});

describe('renovação - o usuário precisa continuar existindo', () => {
  const refreshToken = 'refresh-token-de-usuario-apagado';

  it('refresh token de usuário removido não emite par novo', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(null) };
    const tokens = {
      verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
      refreshTokens: jest.fn().mockResolvedValue({ accessToken: 'novo', refreshToken: 'novo', expiresIn: 1, type: 'Bearer' }),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).refreshUserTokens(refreshToken);

    expect(result.success).toBe(false);
    expect(result.code).toBe('USER_NOT_FOUND');
    // Nenhum par novo emitido para uma conta apagada.
    expect(tokens.refreshTokens).not.toHaveBeenCalled();
    // E o token órfão é revogado, para não permitir nova tentativa em ciclo.
    expect(tokens.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });

  it('não consome o token do usuário apagado: a rotação nem chega a acontecer', async() => {
    // Se a checagem viesse depois da rotação, o token do usuário apagado teria
    // sido consumido — gastando a única credencial de renovação que ele tinha —
    // para então a emissão ser recusada.
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(null) };
    const tokens = {
      verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
      refreshTokens: jest.fn().mockResolvedValue({ accessToken: 'novo', refreshToken: 'novo', expiresIn: 1, type: 'Bearer' }),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };

    await new AuthService(repo as never, {} as never, tokens as never, logger).refreshUserTokens(refreshToken);

    expect(tokens.verifyRefreshToken).toHaveBeenCalledTimes(1);
    expect(tokens.refreshTokens).not.toHaveBeenCalled();
  });

  it('usuário existente renova normalmente', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()) };
    const pair = { accessToken: 'novo', refreshToken: 'novo', expiresIn: 1, type: 'Bearer' };
    const tokens = {
      verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
      refreshTokens: jest.fn().mockResolvedValue(pair),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).refreshUserTokens(refreshToken);

    expect(result.success).toBe(true);
    expect(result.token).toEqual(pair);
  });

  it('reuso de refresh de usuário existente continua sendo tratado como comprometimento', async() => {
    // A checagem de existência não pode engolir o caminho de reuso: ele é
    // um compromisso de segurança e precisa revogar as sessões do usuário.
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()) };
    const reuseError = Object.assign(new Error('reuso'), { code: 'REFRESH_TOKEN_REUSED', userId: 'u-1' });
    const tokens = {
      verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
      refreshTokens: jest.fn().mockRejectedValue(reuseError),
      revokeUserTokens: jest.fn().mockResolvedValue(true)
    };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).refreshUserTokens(refreshToken);

    expect(result.success).toBe(false);
    expect(result.code).toBe('REFRESH_TOKEN_REUSED');
    expect(tokens.revokeUserTokens).toHaveBeenCalledWith('u-1');
  });

  it('revogação de reuso não confirmada continua sendo indisponibilidade, não recusa de credencial', async() => {
    const logger = makeLogger();
    const repo = { findById: jest.fn().mockResolvedValue(makeUser()) };
    const reuseError = Object.assign(new Error('reuso'), { code: 'REFRESH_TOKEN_REUSED', userId: 'u-1' });
    const tokens = {
      verifyRefreshToken: jest.fn().mockResolvedValue({ id: 'u-1', username: 'alice' }),
      refreshTokens: jest.fn().mockRejectedValue(reuseError),
      revokeUserTokens: jest.fn().mockResolvedValue(false)
    };

    const result = await new AuthService(repo as never, {} as never, tokens as never, logger).refreshUserTokens(refreshToken);

    expect(result.code).toBe(REVOCATION_UNAVAILABLE_CODE);
  });
});
