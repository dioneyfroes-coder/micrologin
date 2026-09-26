import { logger } from './logger.js';

/**
 * @fileoverview Política de senha - fonte única da verdade
 *
 * Todas as decisões de política estão declaradas em `PASSWORD_POLICY`. Nenhuma
 * outra camada redefine comprimento, composição ou histórico: o middleware HTTP,
 * o domínio e os testes leem daqui.
 *
 * Decisões (e o motivo de cada uma):
 *
 * 1. **Mínimo de 12 caracteres.** Acima do mínimo de 8 da NIST SP 800-63B,
 *    porque a política também exige composição e o custo de um caractere a mais
 *    é trivial para o usuário.
 * 2. **Máximo de 72 BYTES, não de caracteres.** bcrypt ignora tudo o que passa
 *    de 72 bytes: duas senhas diferentes com o mesmo prefixo de 72 bytes
 *    seriam considered equivalentes. Aceitar mais do que isso prometeria uma
 *    proteção que o hash não entrega, então o limite é o do algoritmo.
 * 3. **Composição obrigatória** (maiúscula, minúscula, número, símbolo). A NIST
 *    desaconselha regras de composição em troca de comprimento + bloqueio de
 *    senhas comprometidas; aqui o tamanho é exigida junto com composição e com
 *    a lista de senhas comuns, e o usuário não tem como contornar a verificação
 *    de breach, então a composição é mantida como camada extra.
 * 4. **Senha é valor opaco.** Nunca é normalizada, escapada ou recortada. Todo
 *    limite é aplicado sem tocar no valor que vai para o bcrypt.
 * 5. **Sem expiração forçada.** Rotação periódica semi-automática empurra o
 *    usuário para padrões piores (NIST SP 800-63B). A troca acontece quando o
 *    usuário ou o sistema pedem.
 * 6. **Histórico limitado** aos últimos `historyLimit` hashes, para impedir
 *    reuso de senha sem transformar o documento em um arquivo de credenciais.
 *
 * Referências: OWASP Authentication Cheat Sheet, NIST SP 800-63B.
 */

/**
 * Política de senha em um único objeto.
 */
export const PASSWORD_POLICY = {
  /** Comprimento mínimo, em caracteres. */
  minLength: 12,
  /**
   * Comprimento máximo em BYTES (limite do bcrypt: o que passa disso é ignorado
   * pelo hash). Contar em bytes também evita que caracteres multibyte "paguem"
   * por um limite que o algoritmo não honra.
   */
  maxLengthBytes: 72,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSpecial: true,
  /** Símbolos aceitos como "caractere especial". */
  specialChars: '!@#$%^&*-_=+',
  /** Quantos hashes de senhas anteriores são guardados. */
  historyLimit: 5,
  /** Senha não expira: a troca é evento, não rotina. */
  expires: false
} as const;

export const PASSWORD_MIN_LENGTH = PASSWORD_POLICY.minLength;
export const PASSWORD_MAX_LENGTH = PASSWORD_POLICY.maxLengthBytes;
export const PASSWORD_HISTORY_LIMIT = PASSWORD_POLICY.historyLimit;

/**
 * Lista de senhas comuns (comparação sem diferenciar caixa).
 *
 * Em produção o ideal é checar contra um serviço de breach (k-anonymity no
 * Have I Been Pwned); aqui a lista local cobre o caso offline e não exige rede
 * dentro do caminho de registro.
 */
const COMMON_PASSWORDS: readonly string[] = [
  'password',
  'password123',
  'senha',
  'senha123',
  'admin',
  'admin123',
  'administrator',
  'root',
  '123456',
  '12345678',
  '123456789',
  'qwerty',
  'qwerty123',
  'abc123',
  'letmein',
  'welcome',
  'monkey',
  'dragon',
  'iloveyou',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'changeme',
  'mudar123',
  'mudarSenha',
  'teste123'
];

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

/**
 * Quantidade de BYTES da senha (é o que o bcrypt realmente processa).
 */
export const passwordByteLength = (password: string): number => Buffer.byteLength(password, 'utf8');

/**
 * Classificação de caracteres. A política é aplicada por classificação
 * (intervalos ASCII + conjunto explícito de símbolos), não por regex.
 */
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
    } else if (PASSWORD_POLICY.specialChars.includes(char)) {
      hasSpecial = true;
    }
  }

  return { hasUpper, hasLower, hasDigit, hasSpecial };
};

/**
 * Valida a senha contra a política.
 *
 * Não modifica o valor: a senha devolvida ao chamador é a mesma que entrou.
 *
 * @param password - Senha a validar
 * @returns { isValid, errors }
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password) {
    return {
      isValid: false,
      errors: ['Senha é obrigatória']
    };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }

  // Limite do bcrypt: acima de 72 bytes o resto da senha seria ignorado.
  const bytes = passwordByteLength(password);
  if (bytes > PASSWORD_MAX_LENGTH) {
    errors.push(`Senha não pode exceder ${PASSWORD_MAX_LENGTH} caracteres (limite do bcrypt)`);
  }

  const composition = classifyComposition(password);

  if (PASSWORD_POLICY.requireUppercase && !composition.hasUpper) {
    errors.push('Senha deve conter pelo menos uma letra maiúscula');
  }

  if (PASSWORD_POLICY.requireLowercase && !composition.hasLower) {
    errors.push('Senha deve conter pelo menos uma letra minúscula');
  }

  if (PASSWORD_POLICY.requireDigit && !composition.hasDigit) {
    errors.push('Senha deve conter pelo menos um número');
  }

  if (PASSWORD_POLICY.requireSpecial && !composition.hasSpecial) {
    errors.push(`Senha deve conter pelo menos um caractere especial (${PASSWORD_POLICY.specialChars})`);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Requisitos em texto (usado nas respostas de erro e na documentação).
 */
export function getPasswordRequirements(): string {
  return [
    `✓ Mínimo ${PASSWORD_MIN_LENGTH} caracteres`,
    `✓ Máximo ${PASSWORD_MAX_LENGTH} caracteres (limite do bcrypt)`,
    '✓ Pelo menos 1 letra maiúscula (A-Z)',
    '✓ Pelo menos 1 letra minúscula (a-z)',
    '✓ Pelo menos 1 número (0-9)',
    `✓ Pelo menos 1 caractere especial (${PASSWORD_POLICY.specialChars})`
  ].join('\n');
}

/**
 * A senha contém (ou é) uma senha comum?
 *
 * A comparação ignora caixa e verifica por substring: "Senha@2024" é rejeitada
 * por conter "senha". Custa um pouco de recall, e é o trade-off consciente de
 * uma lista local (sem rede no caminho de registro).
 */
export function isCommonPassword(password: string): boolean {
  const normalized = password.toLowerCase();
  return COMMON_PASSWORDS.some(common => normalized.includes(common));
}

export type BcryptCompareFn = (plain: string, hash: string) => Promise<boolean>;

/**
 * A senha já foi usada antes?
 *
 * @param currentPassword - Senha sendo cadastrada agora
 * @param passwordHistory - Hashes anteriores (limite: PASSWORD_HISTORY_LIMIT)
 * @param bcryptCompare - Função de comparação
 * @returns true se a senha consta no histórico
 */
export async function wasPasswordUsedBefore(
  currentPassword: string,
  passwordHistory: string[] | null | undefined,
  bcryptCompare: BcryptCompareFn
): Promise<boolean> {
  if (!passwordHistory || passwordHistory.length === 0) {
    return false;
  }

  // Só os N hashes mais recentes interessam.
  const recent = passwordHistory.slice(-PASSWORD_HISTORY_LIMIT);

  for (const oldPasswordHash of recent) {
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
