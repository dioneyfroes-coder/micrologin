import { describe, it, expect, jest } from '@jest/globals';
import {
  validatePasswordStrength,
  getPasswordRequirements,
  isCommonPassword,
  wasPasswordUsedBefore,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH
} from '../../src/shared/utils/passwordValidator.js';

describe('validatePasswordStrength - política de senha forte', () => {
  it('aceita senha que atende todos os requisitos', () => {
    const result = validatePasswordStrength('StrongPass123!');
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejeita senha obrigatória ausente', () => {
    const result = validatePasswordStrength('');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Senha é obrigatória');
  });

  it('rejeita senha curta demais', () => {
    const result = validatePasswordStrength('Ab1!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(`Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  });

  it('rejeita senha longa demais (prevenção de DoS)', () => {
    const long = `A1!${'a'.repeat(PASSWORD_MAX_LENGTH)}`;
    const result = validatePasswordStrength(long);
    expect(result.errors).toContain(`Senha não pode ter mais de ${PASSWORD_MAX_LENGTH} caracteres`);
  });

  it('exige letra maiúscula', () => {
    const result = validatePasswordStrength('lowercase123!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Senha deve conter pelo menos uma letra maiúscula');
  });

  it('exige letra minúscula', () => {
    const result = validatePasswordStrength('UPPERCASE123!');
    expect(result.errors).toContain('Senha deve conter pelo menos uma letra minúscula');
  });

  it('exige número', () => {
    const result = validatePasswordStrength('NumbersAccount!');
    expect(result.errors).toContain('Senha deve conter pelo menos um número');
  });

  it('exige caractere especial', () => {
    const result = validatePasswordStrength('NoSpecial123456');
    expect(result.errors).toContain('Senha deve conter pelo menos um caractere especial (!@#$%^&*-_=+)');
  });

  it('acumula múltiplos erros em uma única validação', () => {
    const result = validatePasswordStrength('short');
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('getPasswordRequirements - mensagem amigável', () => {
  it('menciona o mínimo de caracteres e as classes exigidas', () => {
    const message = getPasswordRequirements();
    expect(message).toContain(`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`);
    expect(message).toContain('letra maiúscula');
    expect(message).toContain('letra minúscula');
    expect(message).toContain('número');
    expect(message).toContain('caractere especial');
  });
});

describe('isCommonPassword - lista de senhas comuns', () => {
  it.each(['password', 'password123', 'admin', '123456', 'qwerty'])('detecta %s como comum', (password) => {
    expect(isCommonPassword(password)).toBe(true);
  });

  it('aceita senha fora da lista de comuns', () => {
    expect(isCommonPassword('CloudyBlueSky42')).toBe(false);
  });
});

describe('wasPasswordUsedBefore - histórico de senhas', () => {
  const bcryptCompareTrue = async() => true;
  const bcryptCompareFalse = async() => false;

  it('retorna false quando não há histórico', async() => {
    expect(await wasPasswordUsedBefore('StrongPass123!', null, bcryptCompareTrue)).toBe(false);
    expect(await wasPasswordUsedBefore('StrongPass123!', undefined, bcryptCompareTrue)).toBe(false);
    expect(await wasPasswordUsedBefore('StrongPass123!', [], bcryptCompareTrue)).toBe(false);
  });

  it('retorna true quando uma senha do histórico coincide', async() => {
    const result = await wasPasswordUsedBefore(
      'StrongPass123!',
      ['hash-antigo'],
      bcryptCompareTrue
    );
    expect(result).toBe(true);
  });

  it('retorna false quando nenhuma senha do histórico coincide', async() => {
    const result = await wasPasswordUsedBefore(
      'StrongPass123!',
      ['hash-1', 'hash-2'],
      bcryptCompareFalse
    );
    expect(result).toBe(false);
  });

  it('ignora erros de comparação e continua avaliando o histórico', async() => {
    const compare = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(false);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await wasPasswordUsedBefore('StrongPass123!', ['hash-1', 'hash-2'], compare);

    expect(result).toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});
