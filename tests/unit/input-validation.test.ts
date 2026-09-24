import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { inputValidator } from '../../src/application/middleware/inputValidation.js';
import { HttpError } from '../../src/shared/utils/errorHandler.js';

describe('InputValidator - validateSchema', () => {
  it('valida payload de login válido', () => {
    const result = inputValidator.validateSchema('login', {
      username: 'alice',
      password: 'StrongPass123!'
    });
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('acumula erros de schema inválido', () => {
    const result = inputValidator.validateSchema('login', {
      username: 'a@!',
      password: 'short'
    });
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every(e => e.field && e.message)).toBe(true);
  });

  it('lança erro para schema desconhecido', () => {
    expect(() => inputValidator.validateSchema('nope', {})).toThrow('não encontrado');
  });

  it('registra novos schemas via addSchema', () => {
    const validator = inputValidator;
    validator.addSchema('custom', {
      validate: () => ({ error: null, value: { ok: true } })
    } as never);
    const result = validator.validateSchema('custom', { anything: 1 });
    expect(result.isValid).toBe(true);
  });
});

describe('InputValidator - validateCharacters', () => {
  it('valida username com a política de classificação', () => {
    expect(inputValidator.validateCharacters('alice_01', 'username').isValid).toBe(true);
    expect(inputValidator.validateCharacters('alice space', 'username').isValid).toBe(false);
  });

  it('valida email com a política do contexto', () => {
    expect(inputValidator.validateCharacters('a@b.com', 'email').isValid).toBe(true);
    expect(inputValidator.validateCharacters('not-an-email', 'email').isValid).toBe(false);
  });

  it('valida senha com a política de caracteres', () => {
    expect(inputValidator.validateCharacters('StrongPass123!', 'password').isValid).toBe(true);
    expect(inputValidator.validateCharacters('senha inválida', 'password').isValid).toBe(false);
  });

  it('rejeita valor não-string', () => {
    const result = inputValidator.validateCharacters(123 as never, 'general');
    expect(result.isValid).toBe(false);
    expect(result.message).toBe('Valor deve ser string');
  });

  it('lança erro para política desconhecida', () => {
    expect(() => inputValidator.validateCharacters('x', 'unknown')).toThrow('não encontrada');
  });

  it('rejeita política inválida no addCharacterWhitelist', () => {
    const validator = inputValidator;
    expect(() => validator.addCharacterWhitelist('bad', {} as never)).toThrow(TypeError);
  });
});

describe('InputValidator - validatePayloadSize', () => {
  it('aceita payload dentro do limite do contexto', () => {
    const result = inputValidator.validatePayloadSize({ username: 'alice' }, 'login');
    expect(result.isValid).toBe(true);
    expect(result.maxSize).toBe(1024);
  });

  it('rejeita payload acima do limite', () => {
    const big = { data: 'x'.repeat(5000) };
    const result = inputValidator.validatePayloadSize(big, 'login');
    expect(result.isValid).toBe(false);
    expect(result.message).toContain('Payload muito grande');
  });

  it('usa limite default quando o contexto é desconhecido', () => {
    const result = inputValidator.validatePayloadSize({});
    expect(result.maxSize).toBe(10240);
  });

  it('atualiza limite via updatePayloadSizeLimit', () => {
    const validator = inputValidator;
    validator.updatePayloadSizeLimit('login', 10);
    const result = validator.validatePayloadSize({ username: 'alice' }, 'login');
    expect(result.isValid).toBe(false);
  });
});

describe('InputValidator - validateComplete', () => {
  beforeEach(() => {
    inputValidator.updatePayloadSizeLimit('login', 1024);
  });

  it('valida em cascata tamanho, schema e caracteres (sucesso)', () => {
    const result = inputValidator.validateComplete('login', {
      username: 'alice',
      password: 'StrongPass123!'
    });
    expect(result.isValid).toBe(true);
  });

  it('captura erro de tamanho primeiro', () => {
    const big = { username: 'alice', password: 'x'.repeat(100000) };
    const result = inputValidator.validateComplete('register', big);
    expect(result.isValid).toBe(false);
    expect(result.errors[0].field).toBe('payload');
  });

  it('captura erros de caracteres mesmo quando o schema passa', () => {
    const result = inputValidator.validateComplete('login', {
      username: 'alice\u0000',
      password: 'StrongPass123!'
    });
    expect(result.isValid).toBe(false);
  });
});

describe('InputValidator - middleware Express', () => {
  beforeEach(() => {
    inputValidator.updatePayloadSizeLimit('login', 1024);
  });

  it('segue para next quando a validação passa e reescreve req.body', async() => {
    const req = { body: { username: 'alice', password: 'StrongPass123!' } };
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      inputValidator.createValidationMiddleware('login')(req as never, {} as never, (err?: unknown) => {
        next(err);
        resolve();
      });
    });

    expect(next).toHaveBeenCalledWith(undefined);
    expect((req.body as Record<string, unknown>).username).toBe('alice');
    expect((req.body as Record<string, unknown>).password).toBe('StrongPass123!');
  });

  it('passa HttpError de VALIDATION_ERROR quando a validação falha', async() => {
    const req = { body: { username: 'a', password: 'short' } };
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      inputValidator.createValidationMiddleware('login')(req as never, {} as never, (err?: unknown) => {
        next(err);
        resolve();
      });
    });

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});
