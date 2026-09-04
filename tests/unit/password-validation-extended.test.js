import { describe, it, expect, jest } from '@jest/globals';
import { validatePasswordStrength, isCommonPassword, PASSWORD_MIN_LENGTH, getPasswordRequirements, wasPasswordUsedBefore } from '../../src/shared/utils/passwordValidator.js';

describe('Password policy - comprehensive rules', () => {
  it('exposes the documented minimum length', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
  });

  it('requires all complexity classes (upper, lower, digit, special)', () => {
    const result = validatePasswordStrength('A1b!cdefghij');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a password without an uppercase letter', () => {
    const result = validatePasswordStrength('alllower1!');
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('maiúscula'))).toBe(true);
  });

  it('rejects a password without a digit', () => {
    const result = validatePasswordStrength('StrongPwd!!!');
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('número')) || result.errors.some(e => e.toLowerCase().includes('numéro'))).toBe(true);
  });

  it('rejects a password without a special character', () => {
    const result = validatePasswordStrength('StrongPassword123');
    expect(result.isValid).toBe(false);
  });

  it('rejects a password above the maximum length', () => {
    const result = validatePasswordStrength('A1!' + 'x'.repeat(130));
    expect(result.isValid).toBe(false);
  });

  it('detects common passwords regardless of case', () => {
    expect(isCommonPassword('password123!')).toBe(true);
    expect(isCommonPassword('qwertyuiop12')).toBe(true);
    expect(isCommonPassword('123456789012')).toBe(true);
  });

  it('does not flag a unique strong password as common', () => {
    expect(isCommonPassword('BlueHorse42#Kite')).toBe(false);
  });

  it('rejects a missing password before applying the rules', () => {
    const result = validatePasswordStrength();
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Senha é obrigatória');
  });

  it('describes the requirements in a human-readable format', () => {
    const requirements = getPasswordRequirements();
    expect(requirements).toContain('Mínimo 12 caracteres');
    expect(requirements).toContain('caractere especial');
  });

  it('returns false when there is no password history', async() => {
    const result = await wasPasswordUsedBefore('StrongPass123!', [], jest.fn());
    expect(result).toBe(false);
  });

  it('returns true when the password matches a previous hash', async() => {
    const compare = jest.fn(async(current, hash) => hash === 'old-hash');
    const result = await wasPasswordUsedBefore('StrongPass123!', ['old-hash'], compare);
    expect(result).toBe(true);
  });

  it('returns false when no previous hash matches and logs compare failures', async() => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const compare = jest.fn(async() => {
      throw new Error('bcrypt failed');
    });

    const result = await wasPasswordUsedBefore('StrongPass123!', ['hash1'], compare);

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
