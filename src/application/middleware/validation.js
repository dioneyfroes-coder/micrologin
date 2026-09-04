import { body } from 'express-validator';
import { validatePasswordStrength, isCommonPassword } from '../../shared/utils/passwordValidator.js';

/**
 * Política de username por CLASSIFICAÇÃO DE CARACTERES.
 *
 * A checagem principal não usa expressão regular: percorre os caracteres e
 * aceita apenas letras ASCII, dígitos, underscore e hífen. Regex fica
 * reservada apenas para detecção/monitoramento em outras camadas.
 */
export const hasAllowedUsernameChars = (username) => {
  for (const char of username) {
    const code = char.charCodeAt(0);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit && char !== '_' && char !== '-') {
      return false;
    }
  }
  return true;
};

/**
 * Validações para login
 */
export const validateLogin = [
  body('user')
    .isString()
    .trim()
    .isLength({ min: 3 })
    .withMessage('Usuário deve ter pelo menos 3 caracteres.'),
  body('password')
    .isString()
    .notEmpty()
    .withMessage('Senha é obrigatória.')
];

/**
 * Validações para registro - COM POLÍTICA DE SENHA FORTE
 */
export const validateRegister = [
  body('user')
    .isString()
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error('Usuário deve conter apenas letras, números, underscores e hífens.');
      }
      return true;
    }),

  body('password')
    .isString()
    .notEmpty()
    .withMessage('Senha é obrigatória.')
    .custom((password) => {
      const validation = validatePasswordStrength(password);
      if (!validation.isValid) {
        throw new Error(validation.errors.join('; '));
      }
      return true;
    })
    .custom((password) => {
      if (isCommonPassword(password)) {
        throw new Error('Senha é muito comum. Escolha uma senha mais complexa.');
      }
      return true;
    })
];

/**
 * Validações para atualização (campos opcionais)
 */
export const validateUpdate = [
  body('user')
    .optional()
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error('Usuário deve conter apenas letras, números, underscores e hífens.');
      }
      return true;
    }),

  body('password')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Senha não pode ser vazia.')
    .custom((password) => {
      const validation = validatePasswordStrength(password);
      if (!validation.isValid) {
        throw new Error(validation.errors.join('; '));
      }
      return true;
    })
    .custom((password) => {
      if (isCommonPassword(password)) {
        throw new Error('Senha é muito comum. Escolha uma senha mais complexa.');
      }
      return true;
    })
];
