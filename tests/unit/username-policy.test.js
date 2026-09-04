import { describe, it, expect } from '@jest/globals';
import {
  hasAllowedUsernameChars,
  isUsernameValid,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH
} from '../../src/shared/utils/usernamePolicy.js';

describe('username policy - fonte única', () => {
  it('accepts letters, digits, underscores and hyphens', () => {
    expect(hasAllowedUsernameChars('alice')).toBe(true);
    expect(hasAllowedUsernameChars('alice_123')).toBe(true);
    expect(hasAllowedUsernameChars('alice-123')).toBe(true);
    expect(hasAllowedUsernameChars('A1_b2-C3')).toBe(true);
  });

  it('rejects spaces, symbols and non-ASCII characters', () => {
    expect(hasAllowedUsernameChars('a b')).toBe(false);
    expect(hasAllowedUsernameChars('user@name')).toBe(false);
    expect(hasAllowedUsernameChars('período')).toBe(false);
    expect(hasAllowedUsernameChars('a!b')).toBe(false);
  });

  it('enforces the minimum length', () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    expect(isUsernameValid('ab')).toBe(false);
    expect(isUsernameValid('abc')).toBe(true);
  });

  it('enforces the maximum length', () => {
    expect(USERNAME_MAX_LENGTH).toBe(30);
    expect(isUsernameValid('x'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
    expect(isUsernameValid('x'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects empty or non-string values', () => {
    expect(isUsernameValid('')).toBe(false);
    expect(isUsernameValid(null)).toBe(false);
    expect(isUsernameValid(undefined)).toBe(false);
  });
});
