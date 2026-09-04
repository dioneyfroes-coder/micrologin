import { describe, it, expect } from '@jest/globals';
import { validatePasswordStrength, isCommonPassword } from '../../src/shared/utils/passwordValidator.js';

describe('Password validation', () => {
  it('accepts a strong password that meets policy', () => {
    const result = validatePasswordStrength('StrongPass123!');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects passwords shorter than 12 chars', () => {
    const result = validatePasswordStrength('Short1!');
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('12'))).toBe(true);
  });

  it('rejects common passwords', () => {
    expect(isCommonPassword('Password123!')).toBe(true);
    expect(isCommonPassword('StrongPass123!')).toBe(false);
  });
});
