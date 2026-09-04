import { body } from 'express-validator';
import { validatePasswordStrength, isCommonPassword } from '../../shared/utils/passwordValidator.js';
import { hasAllowedUsernameChars, USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH, USERNAME_CHARS_MESSAGE } from '../../shared/utils/usernamePolicy.js';

/**
 * Validações para login
 */
export const validateLogin = [
  body('user')
    .isString()
    .trim()
    .isLength({ min: USERNAME_MIN_LENGTH })
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
    .isLength({ min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error(`Usuário deve conter ${USERNAME_CHARS_MESSAGE}.`);
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
    .isLength({ min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error(`Usuário deve conter ${USERNAME_CHARS_MESSAGE}.`);
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

/**
 * Validações para renovação de tokens (POST /refresh)
 */
export const validateRefresh = [
  body('refreshToken')
    .isString()
    .notEmpty()
    .withMessage('refreshToken é obrigatório.')
];
