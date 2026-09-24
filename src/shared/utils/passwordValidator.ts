export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

import { logger } from './logger.js';

/**
 * @fileoverview Validador de Política de Senha Forte
 *
 * Segue as melhores práticas de segurança:
 * - OWASP: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
 * - NIST: https://pages.nist.gov/800-63-3/
 */

/**
 * Classificação ASCII para a política de senha.
 *
 * A política é aplicada por CLASSIFICAÇÃO DE CARACTERES (intervalos de
 * charCode e conjunto explícito de símbolos), e não por expressões regulares.
 * Regex é usada apenas como mecanismo auxiliar de detecção/monitoramento em
 * outras camadas; a proteção principal fica nesta checagem determinística.
 */
const SPECIAL_CHARS = new Set(['!', '@', '#', '$', '%', '^', '&', '*', '-', '_', '=', '+']);

const isASCIIUpper = (code: number): boolean => code >= 65 && code <= 90;   // A-Z
const isASCIILower = (code: number): boolean => code >= 97 && code <= 122;  // a-z
const isASCIIDigit = (code: number): boolean => code >= 48 && code <= 57;   // 0-9

interface PasswordComposition {
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
}

export interface PasswordValidationResult {
  isValid: boolean;
  errors: string[];
}

const classifyComposition = (password: string): PasswordComposition => {
  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;
  let hasSpecial = false;

  for (const char of password) {
    const code = char.charCodeAt(0);
    if (isASCIIUpper(code)) {
      hasUpper = true;
    } else if (isASCIILower(code)) {
      hasLower = true;
    } else if (isASCIIDigit(code)) {
      hasDigit = true;
    } else if (SPECIAL_CHARS.has(char)) {
      hasSpecial = true;
    }
  }

  return { hasUpper, hasLower, hasDigit, hasSpecial };
};

/**
 * Validação de senha forte
 *
 * Regras obrigatórias:
 * - Mínimo 12 caracteres (NIST recomenda)
 * - Pelo menos 1 letra maiúscula
 * - Pelo menos 1 letra minúscula
 * - Pelo menos 1 número
 * - Pelo menos 1 caractere especial (!@#$%^&*-_=+)
 *
 * @param {string} password - Senha a validar
 * @returns {Object} { isValid: boolean, errors: string[] }
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password) {
    return {
      isValid: false,
      errors: ['Senha é obrigatória']
    };
  }

  // Comprimento mínimo
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }

  // Comprimento máximo (prevenção de DoS)
  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Senha não pode ter mais de ${PASSWORD_MAX_LENGTH} caracteres`);
  }

  // Composição por classificação de caracteres (proteção principal)
  const composition = classifyComposition(password);

  if (!composition.hasUpper) {
    errors.push('Senha deve conter pelo menos uma letra maiúscula');
  }

  if (!composition.hasLower) {
    errors.push('Senha deve conter pelo menos uma letra minúscula');
  }

  if (!composition.hasDigit) {
    errors.push('Senha deve conter pelo menos um número');
  }

  if (!composition.hasSpecial) {
    errors.push('Senha deve conter pelo menos um caractere especial (!@#$%^&*-_=+)');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Gera mensagem amigável de requisitos de senha
 * @returns {string} Mensagem formatada
 */
export function getPasswordRequirements() {
  return [
    `✓ Mínimo ${PASSWORD_MIN_LENGTH} caracteres`,
    '✓ Pelo menos 1 letra maiúscula (A-Z)',
    '✓ Pelo menos 1 letra minúscula (a-z)',
    '✓ Pelo menos 1 número (0-9)',
    '✓ Pelo menos 1 caractere especial (!@#$%^&*-_=+)'
  ].join('\n');
}

/**
 * Valida senhas contra lista de senhas comuns
 * Lista de verificação básica - em produção, use haveibeenpwned API
 * @param {string} password - Senha a verificar
 * @returns {boolean} true se a senha é comum, false se é segura
 */
export function isCommonPassword(password: string): boolean {
  // Lista de senhas mais comuns (básica)
  // Em produção, use haveibeenpwned ou similar
  const commonPasswords: string[] = [
    'password',
    'password123',
    'admin',
    'admin123',
    '123456',
    'qwerty',
    'abc123',
    'letmein',
    'welcome',
    'monkey'
  ];

  return commonPasswords.some(common => password.toLowerCase().includes(common));
}

/**
 * Valida se a senha foi usada antes (para rotação de senha)
 * @param {string} currentPassword - Senha atual
 * @param {string[]} passwordHistory - Histórico de hashes de senhas anteriores
 * @param {Function} bcryptCompare - Função bcrypt.compare
 * @returns {Promise<boolean>} true se a senha foi usada antes
 */
export type BcryptCompareFn = (plain: string, hash: string) => Promise<boolean>;

export async function wasPasswordUsedBefore(
  currentPassword: string,
  passwordHistory: string[] | null | undefined,
  bcryptCompare: BcryptCompareFn
): Promise<boolean> {
  if (!passwordHistory || passwordHistory.length === 0) {
    return false;
  }

  for (const oldPasswordHash of passwordHistory) {
    try {
      const isMatch = await bcryptCompare(currentPassword, oldPasswordHash);
      if (isMatch) {
        return true;
      }
    } catch (error) {
      logger.error('Erro ao comparar histórico de senha', error);
    }
  }

  return false;
}
