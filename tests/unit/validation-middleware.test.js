import { describe, it, expect } from '@jest/globals';
import expressValidator from 'express-validator';
import { validateLogin, validateRegister, validateUpdate } from '../../src/application/middleware/validation.js';

const { validationResult } = expressValidator;

const runChain = async(chain, body) => {
  const req = { body };
  for (const middleware of chain) {
    await middleware.run(req);
  }
  return validationResult(req);
};

const errorsOf = (result) => result.array().map(e => e.msg);

describe('validation middleware - login', () => {
  it('accepts a valid login payload', async() => {
    const result = await runChain(validateLogin, { user: 'alice', password: 'some-password' });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects a login with a short username', async() => {
    const result = await runChain(validateLogin, { user: 'ab', password: 'some-password' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('3 caracteres')]));
  });

  it('rejects a login without a password', async() => {
    const result = await runChain(validateLogin, { user: 'alice' });
    expect(result.isEmpty()).toBe(false);
  });
});

describe('validation middleware - register', () => {
  it('accepts a valid strong credential pair', async() => {
    const result = await runChain(validateRegister, {
      user: 'alice_01',
      password: 'Str0ng!Passw0rd'
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects a username with invalid characters', async() => {
    const result = await runChain(validateRegister, { user: 'alice@x', password: 'Str0ng!Passw0rd' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('apenas letras, números')]));
  });

  it('rejects a username longer than 30 characters', async() => {
    const result = await runChain(validateRegister, {
      user: 'x'.repeat(31),
      password: 'Str0ng!Passw0rd'
    });
    expect(result.isEmpty()).toBe(false);
  });

  it('rejects a weak password', async() => {
    const result = await runChain(validateRegister, { user: 'alice', password: 'short' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('Senha')]));
  });

  it('rejects a common password', async() => {
    const result = await runChain(validateRegister, { user: 'alice', password: 'Password123!' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('comum')]));
  });
});

describe('validation middleware - update', () => {
  it('accepts an empty update payload', async() => {
    const result = await runChain(validateUpdate, {});
    expect(result.isEmpty()).toBe(true);
  });

  it('accepts a valid optional update', async() => {
    const result = await runChain(validateUpdate, { user: 'bob_2' });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects an invalid optional username', async() => {
    const result = await runChain(validateUpdate, { user: 'b b' });
    expect(result.isEmpty()).toBe(false);
  });

  it('rejects an empty optional password', async() => {
    const result = await runChain(validateUpdate, { password: '' });
    expect(errorsOf(result)).toEqual(expect.arrayContaining([expect.stringContaining('vazia')]));
  });
});
