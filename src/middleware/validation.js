import { body } from 'express-validator';

/**
 * Validações para login
 */
export const validateLogin = [
  body('user')
    .isString()
    .isLength({ min: 3 })
    .withMessage('Usuário deve ter pelo menos 3 caracteres.'),
  body('password')
    .isString()
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres.')
];

/**
 * Validações para registro
 */
export const validateRegister = [
  body('user')
    .isString()
    .isLength({ min: 3 })
    .withMessage('Usuário deve ter pelo menos 3 caracteres.'),
  body('password')
    .isString()
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres.')
];

/**
 * Validações para atualização (campos opcionais)
 */
export const validateUpdate = [
  body('user')
    .optional()
    .isString()
    .isLength({ min: 3 })
    .withMessage('Usuário deve ter pelo menos 3 caracteres.'),
  body('password')
    .optional()
    .isString()
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres.')
];

