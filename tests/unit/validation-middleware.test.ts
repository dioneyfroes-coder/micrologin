import { describe, it, expect } from '@jest/globals';
import expressValidator from 'express-validator';
import { validateLogin, validateRegister, validateUpdate, validateRefresh } from '../../src/application/middleware/validation.js';

const { validationResult } = expressValidator;

const runChain = async(chain: ReturnType<typeof validateLogin>, body: Record<string, unknown>) => {
  const req = { body };
  for (const middleware of chain) {
    await middleware.run(req);
  }
  return validationResult(req);
};

const errorsOf = (result: { array: () => { msg: string }[] }) => result.array().map(e => e.msg);

describe('validation middleware - login', () => {
  it('aceita payload válido', async() => {
    const result = await runChain(validateLogin, { user: 'alice', password: 'some-password' });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejeita username curto', async() => {
    const result = await runChain(validateLogin, { user: 'ab', password: 'some-password' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('3 caracteres')]));
  });

  it('rejeita ausência de senha', async() => {
    const result = await runChain(validateLogin, { user: 'alice' });
    expect(result.isEmpty()).toBe(false);
  });
});

describe('validation middleware - register', () => {
  it('aceita credenciais fortes', async() => {
    const result = await runChain(validateRegister, { user: 'alice_01', password: 'Str0ng!Passw0rd' });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejeita username com caracteres inválidos', async() => {
    const result = await runChain(validateRegister, { user: 'alice@x', password: 'Str0ng!Passw0rd' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('apenas letras, números')]));
  });

  it('rejeita username com mais de 30 caracteres', async() => {
    const result = await runChain(validateRegister, { user: 'x'.repeat(31), password: 'Str0ng!Passw0rd' });
    expect(result.isEmpty()).toBe(false);
  });

  it('rejeita senha fraca', async() => {
    const result = await runChain(validateRegister, { user: 'alice', password: 'short' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('Senha')]));
  });

  it('rejeita senha comum', async() => {
    const result = await runChain(validateRegister, { user: 'alice', password: 'password123' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('muito comum')]));
  });
});

describe('validation middleware - update', () => {
  it('aceita payload vazio (tudo opcional)', async() => {
    const result = await runChain(validateUpdate, {});
    expect(result.isEmpty()).toBe(true);
  });

  it('valida username quando fornecido', async() => {
    const result = await runChain(validateUpdate, { user: 'bad name' });
    expect(result.isEmpty()).toBe(false);
  });

  it('valida senha quando fornecida', async() => {
    const result = await runChain(validateUpdate, { password: 'fraca' });
    expect(result.isEmpty()).toBe(false);
  });
});

describe('validation middleware - refresh', () => {
  it('aceita refreshToken presente', async() => {
    const result = await runChain(validateRefresh, { refreshToken: 'abc' });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejeita refreshToken ausente', async() => {
    const result = await runChain(validateRefresh, {});
    expect(result.isEmpty()).toBe(false);
  });
});
