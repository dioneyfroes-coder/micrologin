import { describe, it, expect } from '@jest/globals';
import { User, LoginCredentials, AuthResult, DomainError } from '../../src/domain/index.js';

const HASH = '$2b$10$abcdefghijklmnopqrstuv';

describe('User - entidade de domínio', () => {
  it('cria usuário com dados básicos e timestamps padrão', () => {
    const user = new User(null, 'alice', HASH);
    expect(user.id).toBeNull();
    expect(user.username).toBe('alice');
    expect(user.hashedPassword).toBe(HASH);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('valida usuário com username e senha presentes', () => {
    const user = new User('u-1', 'alice', HASH);
    expect(user.isValid()).toBe(true);
  });

  it('rejeita usuário sem username ou sem senha', () => {
    expect(new User('u-1', '', HASH).isValid()).toBe(false);
    expect(new User('u-1', 'alice', '').isValid()).toBe(false);
  });

  it('aplica a política única de username', () => {
    const user = new User('u-1', 'valid_name-1', HASH);
    expect(user.isUsernameValid()).toBe(true);
    expect(user.isValidUsername('other_user')).toBe(true);
    expect(user.isValidUsername('invalido espaço')).toBe(false);
  });

  it('atualiza o username respeitando a política', () => {
    const user = new User('u-1', 'alice', HASH, new Date(2024, 0, 1), new Date(2024, 0, 1));
    user.updateUsername('alice2');
    expect(user.username).toBe('alice2');
    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(new Date(2024, 0, 1).getTime());
  });

  it('normaliza o username na criação e na atualização', () => {
    expect(new User(null, '  Alice  ', HASH).username).toBe('alice');

    const user = new User('u-1', 'alice', HASH);
    user.updateUsername('  BOB_2026  ');
    expect(user.username).toBe('bob_2026');
  });

  it('trata mudança apenas de caixa como o mesmo username', () => {
    const user = new User('u-1', 'alice', HASH);
    user.updateUsername('ALICE');
    expect(user.username).toBe('alice');
  });

  it('lança DomainError ao atualizar com username inválido', () => {
    const user = new User('u-1', 'alice', HASH);
    expect(() => user.updateUsername('bad name')).toThrow(DomainError);
    expect(() => user.updateUsername('bad name')).toThrow('Username inválido');
  });

  it('troca de senha guardando o hash anterior no histórico', () => {
    const user = new User('u-1', 'alice', HASH);
    const before = user.passwordChangedAt;

    user.changePassword('new-hash');

    expect(user.hashedPassword).toBe('new-hash');
    expect(user.passwordHistory).toEqual([HASH]);
    expect(user.passwordChangedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('limita o histórico às últimas senhas (FIFO)', () => {
    const user = new User('u-1', 'alice', 'hash-5', new Date(), new Date(), ['hash-0', 'hash-1', 'hash-2', 'hash-3', 'hash-4']);

    user.changePassword('hash-6');

    // Entra o hash atual e sai o mais antigo
    expect(user.passwordHistory).toEqual(['hash-1', 'hash-2', 'hash-3', 'hash-4', 'hash-5']);
    expect(user.passwordHistory).toHaveLength(5);
  });

  it('recusa troca de senha vazia', () => {
    const user = new User('u-1', 'alice', HASH);
    expect(() => user.changePassword('')).toThrow(DomainError);
    expect(user.hashedPassword).toBe(HASH);
  });

  it('não expõe histórico de senhas no objeto seguro', () => {
    const user = new User('u-1', 'alice', HASH, new Date(), new Date(), ['hash-antigo']);

    expect(Object.keys(user.toSafeObject())).not.toContain('passwordHistory');
    expect(user.toSafeObject()).not.toHaveProperty('hashedPassword');
  });

  it('expõe objeto seguro sem a senha', () => {
    const createdAt = new Date(2024, 0, 1);
    const updatedAt = new Date(2024, 0, 2);
    const user = new User('u-1', 'alice', HASH, createdAt, updatedAt);

    const safe = user.toSafeObject();

    expect(safe.id).toBe('u-1');
    expect(safe.username).toBe('alice');
    expect((safe as Record<string, unknown>).hashedPassword).toBeUndefined();
    expect(safe.createdAt).toBe(createdAt);
    expect(safe.updatedAt).toBe(updatedAt);
  });
});

describe('LoginCredentials - value object de credenciais', () => {
  it('aceita credenciais válidas', () => {
    const credentials = new LoginCredentials('alice', 'StrongPass123!');
    expect(credentials.username).toBe('alice');
    expect(credentials.plainPassword).toBe('StrongPass123!');
  });

  it('rejeita username curto', () => {
    expect(() => new LoginCredentials('ab', 'StrongPass123!')).toThrow(DomainError);
    expect(() => new LoginCredentials('ab', 'StrongPass123!')).toThrow('pelo menos 3 caracteres');
  });

  it('rejeita username com caracteres não permitidos', () => {
    expect(() => new LoginCredentials('alice@x', 'StrongPass123!')).toThrow('apenas letras, números, underscores e hífens');
  });

  it('rejeita senha curta', () => {
    expect(() => new LoginCredentials('alice', 'short')).toThrow(DomainError);
    expect(() => new LoginCredentials('alice', 'short')).toThrow('pelo menos 12 caracteres');
  });

  it('rejeita senha ausente', () => {
    expect(() => new LoginCredentials('alice', '')).toThrow(DomainError);
  });

  it('normaliza o username mas preserva a senha exatamente como recebida', () => {
    const credentials = new LoginCredentials('  Alice  ', '  Senha Com Espaço  ');
    expect(credentials.username).toBe('alice');
    // Senha é valor opaco: nenhuma normalização é aplicada.
    expect(credentials.plainPassword).toBe('  Senha Com Espaço  ');
  });

  it('valida o tamanho do username já normalizado', () => {
    // 4 caracteres com espaços, mas apenas 2 válidos.
    expect(() => new LoginCredentials(' ab ', 'StrongPass123!')).toThrow('pelo menos 3 caracteres');
    expect(new LoginCredentials(' abc ', 'StrongPass123!').username).toBe('abc');
  });
});

describe('AuthResult - resultado de autenticação', () => {
  const user = { id: 'u-1', username: 'alice', createdAt: new Date(), updatedAt: new Date() };
  const token = {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresIn: 900000,
    type: 'Bearer'
  };

  it('constrói sucesso com user e token', () => {
    const result = new AuthResult(user, token, true, null);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.user).toBe(user);
    expect(result.token).toBe(token);
  });

  it('constrói falha com erro', () => {
    const result = new AuthResult(null, null, false, 'Senha incorreta');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Senha incorreta');
  });

  it('factory success()', () => {
    const result = AuthResult.success(user, token);
    expect(result.success).toBe(true);
    expect(result.user).toBe(user);
    expect(result.token).toBe(token);
  });

  it('factory failure()', () => {
    const result = AuthResult.failure('Usuário não encontrado');
    expect(result.success).toBe(false);
    expect(result.user).toBeNull();
    expect(result.token).toBeNull();
    expect(result.error).toBe('Usuário não encontrado');
  });
});
