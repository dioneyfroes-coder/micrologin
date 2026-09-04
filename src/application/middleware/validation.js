import { body } from 'express-validator';
import { validatePasswordStrength, isCommonPassword } from '../../shared/utils/passwordValidator.js';

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
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Usuário deve conter apenas letras, números, underscores e hífens.'),
  
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
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Usuário deve conter apenas letras, números, underscores e hífens.'),
  
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
