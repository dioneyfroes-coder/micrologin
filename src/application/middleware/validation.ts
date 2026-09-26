import { body } from 'express-validator';
import { validatePasswordStrength, isCommonPassword, PASSWORD_MAX_LENGTH } from '../../shared/utils/passwordPolicy.js';
import { hasAllowedUsernameChars, normalizeUsernameField, USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH, USERNAME_CHARS_MESSAGE } from '../../shared/utils/usernamePolicy.js';

/**
 * Validações para login
 *
 * O username é normalizado (trim + lowercase) antes de qualquer validação e
 * antes de chegar ao domínio, que aplica a mesma forma canônica.
 * A senha NÃO é normalizada: é um valor opaco.
 */
export const validateLogin = [
  body('user')
    .isString()
    .customSanitizer(normalizeUsernameField)
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
    .customSanitizer(normalizeUsernameField)
    .isLength({ min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user: string) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error(`Usuário deve conter ${USERNAME_CHARS_MESSAGE}.`);
      }
      return true;
    }),

  body('password')
    .isString()
    .notEmpty()
    .withMessage('Senha é obrigatória.')
    .custom((password: string) => {
      const validation = validatePasswordStrength(password);
      if (!validation.isValid) {
        throw new Error(validation.errors.join('; '));
      }
      return true;
    })
    .custom((password: string) => {
      if (isCommonPassword(password)) {
        throw new Error('Senha é muito comum. Escolha uma senha mais complexa.');
      }
      return true;
    })
];

/**
 * Validações para atualização de perfil (apenas username)
 *
 * A senha NÃO é atualizada por aqui: troca de senha exige a senha atual e tem
 * caso de uso próprio (`PUT /password`).
 */
export const validateUpdate = [
  body('user')
    .optional()
    .isString()
    .customSanitizer(normalizeUsernameField)
    .isLength({ min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })
    .withMessage('Usuário deve ter entre 3 e 30 caracteres.')
    .custom((user: string) => {
      if (!hasAllowedUsernameChars(user)) {
        throw new Error(`Usuário deve conter ${USERNAME_CHARS_MESSAGE}.`);
      }
      return true;
    }),

  // Rejeita tentativa de trocar a senha por este endpoint: o caminho correto
  // é PUT /password, que exige a senha atual.
  body('password')
    .optional()
    .custom(() => {
      throw new Error('Use PUT /password para alterar a senha.');
    })
];

/**
 * Validações para troca de senha (PUT /password)
 *
 * `currentPassword` é o step-up: um access token sozinho não troca a senha.
 * Nenhuma das duas senhas é normalizada.
 */
export const validateChangePassword = [
  body('currentPassword')
    .isString()
    .withMessage('Senha atual é obrigatória.')
    .bail()
    .notEmpty()
    .withMessage('Senha atual é obrigatória.')
    .bail()
    .isLength({ max: PASSWORD_MAX_LENGTH })
    .withMessage(`Senha atual não pode exceder ${PASSWORD_MAX_LENGTH} caracteres.`)
    .bail(),

  body('newPassword')
    .isString()
    .withMessage('Nova senha é obrigatória.')
    .bail()
    .notEmpty()
    .withMessage('Nova senha é obrigatória.')
    .bail()
    .custom((newPassword: string, { req }) => {
      const validation = validatePasswordStrength(newPassword);
      if (!validation.isValid) {
        throw new Error(validation.errors.join('; '));
      }
      if (isCommonPassword(newPassword)) {
        throw new Error('Senha é muito comum. Escolha uma senha mais complexa.');
      }
      const currentPassword = (req.body as { currentPassword?: string }).currentPassword;
      if (currentPassword && currentPassword === newPassword) {
        throw new Error('A nova senha deve ser diferente da senha atual.');
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
