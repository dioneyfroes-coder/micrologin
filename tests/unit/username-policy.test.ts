import { describe, it, expect } from '@jest/globals';
import {
  isUsernameValid,
  hasAllowedUsernameChars,
  normalizeUsername,
  normalizeUsernameField,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_ERROR_MESSAGE
} from '../../src/shared/utils/usernamePolicy.js';

describe('usernamePolicy - política de username', () => {
  it('aceita usuários válidos com letras, números, underscore e hífen', () => {
    expect(isUsernameValid('alice')).toBe(true);
    expect(isUsernameValid('user_123')).toBe(true);
    expect(isUsernameValid('bob-2026')).toBe(true);
    expect(isUsernameValid('A'.repeat(USERNAME_MIN_LENGTH))).toBe(true);
    expect(isUsernameValid('A'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
  });

  it('rejeita usuários mais curtos que o mínimo', () => {
    expect(isUsernameValid('a'.repeat(USERNAME_MIN_LENGTH - 1))).toBe(false);
  });

  it('rejeita usuários mais longos que o máximo', () => {
    expect(isUsernameValid('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejeita caracteres fora da lista permitida', () => {
    expect(isUsernameValid('nao valido')).toBe(false);
    expect(isUsernameValid('acentuadé')).toBe(false);
    expect(isUsernameValid('user@x')).toBe(false);
    expect(isUsernameValid('user.com')).toBe(false);
    expect(isUsernameValid('')).toBe(false);
  });

  it('hasAllowedUsernameChars segue a mesma classificação de caracteres', () => {
    expect(hasAllowedUsernameChars('valid_name-1')).toBe(true);
    expect(hasAllowedUsernameChars('invalid name')).toBe(false);
    expect(hasAllowedUsernameChars('espaço')).toBe(false);
  });

  it('expõe mensagem de erro única com os limites de tamanho', () => {
    expect(USERNAME_ERROR_MESSAGE).toContain(`${USERNAME_MIN_LENGTH} e ${USERNAME_MAX_LENGTH}`);
    expect(USERNAME_ERROR_MESSAGE).toContain('apenas letras, números, underscores e hífens');
  });
});

describe('normalizeUsername - forma canônica de identidade', () => {
  it('remove espaços das bordas e converte para minúsculas', () => {
    expect(normalizeUsername('Alice')).toBe('alice');
    expect(normalizeUsername('  ALICE  ')).toBe('alice');
    expect(normalizeUsername('Bob-2026')).toBe('bob-2026');
    expect(normalizeUsername('user_123')).toBe('user_123');
  });

  it('é idempotente (aplicar duas vezes não muda o valor)', () => {
    const once = normalizeUsername('  Alice  ');
    expect(normalizeUsername(once)).toBe(once);
  });

  it('normaliza a partir de valores que passam pela validação de tamanho', () => {
    // '  ab  ' tem 6 caracteres, mas só 2 depois da normalização:
    // a validação deve enxergar a forma canônica.
    expect(normalizeUsername('  ab  ')).toBe('ab');
    expect(isUsernameValid(normalizeUsername('  ab  '))).toBe(false);
    expect(isUsernameValid(normalizeUsername('  abc  '))).toBe(true);
  });

  it('normalizeUsernameField preserva valores não string para a validação de tipo', () => {
    expect(normalizeUsernameField(123)).toBe(123);
    expect(normalizeUsernameField(null)).toBeNull();
    expect(normalizeUsernameField(undefined)).toBeUndefined();
    expect(normalizeUsernameField(' Alice ')).toBe('alice');
  });
});
