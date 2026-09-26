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

const runChainWithBody = async(chain: ReturnType<typeof validateLogin>, body: Record<string, unknown>) => {
  const req = { body };
  for (const middleware of chain) {
    await middleware.run(req);
  }
  return { result: validationResult(req), body: req.body };
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

describe('validation middleware - normalização de username', () => {
  it('normaliza o username no login (trim + lowercase)', async() => {
    const { result, body } = await runChainWithBody(validateLogin, {
      user: '  AlIcE  ',
      password: 'some-password'
    });

    expect(result.isEmpty()).toBe(true);
    expect(body.user).toBe('alice');
  });

  it('normaliza o username no registro', async() => {
    const { result, body } = await runChainWithBody(validateRegister, {
      user: ' Alice_01 ',
      password: 'Str0ng!Passw0rd'
    });

    expect(result.isEmpty()).toBe(true);
    expect(body.user).toBe('alice_01');
  });

  it('normaliza o username na atualização', async() => {
    const { result, body } = await runChainWithBody(validateUpdate, { user: '  BOB-2026 ' });

    expect(result.isEmpty()).toBe(true);
    expect(body.user).toBe('bob-2026');
  });

  it('valida o tamanho do username já normalizado', async() => {
    const result = await runChain(validateRegister, { user: '  ab  ', password: 'Str0ng!Passw0rd' });
    expect(result.isEmpty()).toBe(false);
  });

  it('não altera a senha (valor opaco)', async() => {
    const password = '  Str0ng!Passw0rd  ';
    const { result, body } = await runChainWithBody(validateLogin, { user: 'alice', password });

    expect(result.isEmpty()).toBe(true);
    expect(body.password).toBe(password);
  });

  it('rejeita username não string sem quebrar a cadeia', async() => {
    const result = await runChain(validateRegister, { user: 123, password: 'Str0ng!Passw0rd' });
    expect(result.isEmpty()).toBe(false);
  });
});
