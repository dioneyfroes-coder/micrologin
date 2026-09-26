import { describe, it, expect, jest } from '@jest/globals';
import { normalizeInput } from '../../src/application/middleware/inputNormalization.js';

describe('normalizeInput - normalização de entrada', () => {
  it('remove caracteres de controle Unicode', () => {
    const req = { body: { username: 'ali\u0000ce' } };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.body.username).toBe('alice');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('normaliza objetos aninhados recursivamente', () => {
    const req = {
      body: { profile: { bio: 'hello\u0007 world', city: 'Sao Paulo' } }
    };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.body.profile.bio).toBe('hello world');
    expect(req.body.profile.city).toBe('Sao Paulo');
  });

  it('normaliza query strings', () => {
    const req = { body: {}, query: { q: 'termo\u0007' }, params: {} };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.query.q).toBe('termo');
  });

  it('normaliza params', () => {
    const req = { body: {}, query: {}, params: { id: 'abc\u0000def' } };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.params.id).toBe('abcdef');
  });

  it('segue para next mesmo sem corpo', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeInput - credenciais são valores opacos', () => {
  it('não transforma a senha enviada pelo cliente', () => {
    const password = 'A&B<C>"\u0007 Senha Com espaços  ';
    const req = { body: { user: 'alice', password } };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    // O valor precisa chegar intacto ao bcrypt: escapar ou "sanitizar" a senha
    // faria o hash de uma senha diferente da digitada pelo usuário.
    expect(req.body.password).toBe(password);
  });

  it('não transforma refreshToken (a chave de blacklist depende do valor exato)', () => {
    const refreshToken = 'header.payload&signature=<>';
    const req = { body: { refreshToken } };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.body.refreshToken).toBe(refreshToken);
  });

  it('preserva credenciais em qualquer caixa do nome do campo', () => {
    const req = {
      body: {
        user: 'alice',
        Password: '  senha\u0000x  ',
        newPassword: 'outra\u0007senha',
        refreshToken: 'token&x'
      }
    };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    expect(req.body.Password).toBe('  senha\u0000x  ');
    expect(req.body.newPassword).toBe('outra\u0007senha');
    expect(req.body.refreshToken).toBe('token&x');
    // Campos não sensíveis continuam normalizados
    expect(req.body.user).toBe('alice');
  });

  it('não faz HTML escaping na entrada (a API responde JSON)', () => {
    const req = { body: { bio: '<script>alert(1)</script>' } };
    const next = jest.fn();

    normalizeInput(req, {} as never, next);

    // Não escapamos a entrada: escaping pertence à camada de saída, no ponto
    // em que o dado é renderizado. A API serve JSON.
    expect(req.body.bio).toBe('<script>alert(1)</script>');
  });
});
