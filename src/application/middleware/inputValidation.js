/**
 * @fileoverview Validação rigorosa de input com schemas
 * Implementa validação de schema e políticas de caracteres por
 * CLASSIFICAÇÃO (proteção principal). Regex não é usada como regra
 * padrão de rejeição — apenas como auxiliar em contextos externos.
 */

import Joi from 'joi';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePasswordStrength } from '../../shared/utils/passwordValidator.js';
import { HttpError } from '../../shared/utils/errorHandler.js';

// ===================================================================
// Políticas de caracteres via CLASSIFICAÇÃO (proteção principal).
// Expressões regulares ficam reservadas apenas para detecção/
// monitoramento — a validação de entrada não depende delas.
// ===================================================================

const isASCIILetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isASCIIDigit = (code) => code >= 48 && code <= 57;

const everyChar = (value, predicate) => {
  for (const char of value) {
    if (!predicate(char.charCodeAt(0), char)) {
      return false;
    }
  }
  return true;
};

const usernamePolicy = (value) =>
  value.length > 0 && everyChar(value, (code) => isASCIILetter(code) || isASCIIDigit(code));

const emailPolicy = (value) => {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return false;
  }

  const localPart = value.slice(0, atIndex);
  const domainPart = value.slice(atIndex + 1);

  const localOk = everyChar(
    localPart,
    (code, char) => isASCIILetter(code) || isASCIIDigit(code) || '._%+-'.includes(char)
  );
  if (!localOk) {
    return false;
  }

  const lastDot = domainPart.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === domainPart.length - 1) {
    return false;
  }

  const tld = domainPart.slice(lastDot + 1);
  if (!everyChar(tld, (code) => isASCIILetter(code)) || tld.length < 2) {
    return false;
  }

  return everyChar(
    domainPart,
    (code, char) => isASCIILetter(code) || isASCIIDigit(code) || '.-'.includes(char)
  );
};

const PASSWORD_ALLOWED_CHARS = new Set([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '@', '$', '!', '%', '*', '?', '&'
]);

const passwordPolicy = (value) =>
  value.length > 0 && everyChar(value, (code, char) => PASSWORD_ALLOWED_CHARS.has(char));

const GENERAL_PUNCTUATION = new Set([
  ' ', '.', ',', '!', '?', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '_', '+', '-', '=', '[', ']', '{', '}', '|', ';', ':', '\'', '"', '<',
  '>', '/', '~', '`', '\\'
]);

const generalPolicy = (value) =>
  value.length > 0 && everyChar(value, (code, char) => isASCIILetter(code) || isASCIIDigit(code) || GENERAL_PUNCTUATION.has(char));

// Validador customizado de senha usado nos schemas Joi (sem lookaround regex)
const joiPasswordPolicy = (password, helpers) => {
  const strength = validatePasswordStrength(password);
  if (!strength.isValid) {
    return helpers.error('string.passwordStrength', { reasons: strength.errors.join('; ') });
  }
  if (!passwordPolicy(password)) {
    return helpers.error('string.passwordChars');
  }
  return password;
};
  // Schemas de validação
const schemas = {
  login: Joi.object({
    username: Joi.string()
      .alphanum()
      .min(3)
      .max(30)
      .required()
      .messages({
        'string.alphanum': 'Username deve conter apenas letras e números',
        'string.min': 'Username deve ter pelo menos 3 caracteres',
        'string.max': 'Username deve ter no máximo 30 caracteres'
      }),
    password: Joi.string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .custom(joiPasswordPolicy)
      .required()
      .messages({
        'string.min': `Password deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`,
        'string.max': `Password deve ter no máximo ${PASSWORD_MAX_LENGTH} caracteres`,
        'string.passwordStrength': 'Password não atende à política de senha forte ({#reasons})',
        'string.passwordChars': 'Password contém caracteres não permitidos'
      })
  }),

  register: Joi.object({
    username: Joi.string()
      .alphanum()
      .min(3)
      .max(30)
      .required(),
    email: Joi.string()
      .email()
      .max(255)
      .required()
      .messages({
        'string.email': 'Email deve ter formato válido',
        'string.max': 'Email deve ter no máximo 255 caracteres'
      }),
    password: Joi.string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .custom(joiPasswordPolicy)
      .required(),
    confirmPassword: Joi.string()
      .valid(Joi.ref('password'))
      .required()
      .messages({
        'any.only': 'Confirmação de password deve ser igual ao password'
      })
  }),

  updateProfile: Joi.object({
    username: Joi.string()
      .alphanum()
      .min(3)
      .max(30)
      .optional(),
    email: Joi.string()
      .email()
      .max(255)
      .optional(),
    currentPassword: Joi.string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .when('newPassword', {
        is: Joi.exist(),
        then: Joi.required(),
        otherwise: Joi.optional()
      }),
    newPassword: Joi.string()
      .min(PASSWORD_MIN_LENGTH)
      .max(PASSWORD_MAX_LENGTH)
      .custom(joiPasswordPolicy)
      .optional()
  })
};

// Políticas de caracteres permitidos por contexto (via classificação, sem regex)
const characterPolicies = {
  username: usernamePolicy,
  email: emailPolicy,
  password: passwordPolicy,
  general: generalPolicy
};

class InputValidator {
  constructor() {
    this.maxPayloadSizes = {
      login: 1024,        // 1KB
      register: 2048,     // 2KB
      updateProfile: 2048, // 2KB
      default: 10240      // 10KB
    };
  }

  /**
   * Valida payload baseado no schema
   */
  validateSchema(schemaName, data) {
    const schema = schemas[schemaName];
    if (!schema) {
      throw new Error(`Schema '${schemaName}' não encontrado`);
    }

    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return {
        isValid: false,
        errors,
        data: null
      };
    }

    return {
      isValid: true,
      errors: [],
      data: value
    };
  }

  /**
   * Valida caracteres usando a política de classificação do contexto
   */
  validateCharacters(value, type = 'general') {
    const policy = characterPolicies[type];
    if (!policy) {
      throw new Error(`Política de caracteres '${type}' não encontrada`);
    }

    if (typeof value !== 'string') {
      return { isValid: false, message: 'Valor deve ser string' };
    }

    if (!policy(value)) {
      return {
        isValid: false,
        message: `Caracteres não permitidos detectados para tipo '${type}'`
      };
    }

    return { isValid: true, message: 'Caracteres válidos' };
  }

  /**
   * Valida tamanho do payload
   */
  validatePayloadSize(data, context = 'default') {
    const maxSize = this.maxPayloadSizes[context] || this.maxPayloadSizes.default;
    const dataString = JSON.stringify(data);
    const size = Buffer.byteLength(dataString, 'utf8');

    if (size > maxSize) {
      return {
        isValid: false,
        message: `Payload muito grande: ${size} bytes. Máximo permitido: ${maxSize} bytes`,
        size,
        maxSize
      };
    }

    return {
      isValid: true,
      message: 'Tamanho válido',
      size,
      maxSize
    };
  }

  /**
   * Valida input completo (schema + caracteres + tamanho)
   */
  validateComplete(schemaName, data) {
    // Validar tamanho primeiro
    const sizeValidation = this.validatePayloadSize(data, schemaName);
    if (!sizeValidation.isValid) {
      return {
        isValid: false,
        errors: [{ field: 'payload', message: sizeValidation.message }],
        validationDetails: { size: sizeValidation }
      };
    }

    // Validar schema
    const schemaValidation = this.validateSchema(schemaName, data);
    if (!schemaValidation.isValid) {
      return {
        isValid: false,
        errors: schemaValidation.errors,
        validationDetails: {
          schema: schemaValidation,
          size: sizeValidation
        }
      };
    }

    // Validar caracteres em campos específicos
    const characterErrors = [];
    if (data.username) {
      const usernameValidation = this.validateCharacters(data.username, 'username');
      if (!usernameValidation.isValid) {
        characterErrors.push({ field: 'username', message: usernameValidation.message });
      }
    }

    if (data.email) {
      const emailValidation = this.validateCharacters(data.email, 'email');
      if (!emailValidation.isValid) {
        characterErrors.push({ field: 'email', message: emailValidation.message });
      }
    }

    if (data.password) {
      const passwordValidation = this.validateCharacters(data.password, 'password');
      if (!passwordValidation.isValid) {
        characterErrors.push({ field: 'password', message: passwordValidation.message });
      }
    }

    if (characterErrors.length > 0) {
      return {
        isValid: false,
        errors: characterErrors,
        validationDetails: {
          schema: schemaValidation,
          size: sizeValidation,
          characters: characterErrors
        }
      };
    }

    return {
      isValid: true,
      errors: [],
      data: schemaValidation.data,
      validationDetails: {
        schema: schemaValidation,
        size: sizeValidation
      }
    };
  }

  /**
   * Middleware Express para validação
   */
  createValidationMiddleware(schemaName) {
    return (req, res, next) => {
      try {
        const validation = this.validateComplete(schemaName, req.body);

        if (!validation.isValid) {
          return next(new HttpError(400, 'VALIDATION_ERROR', 'Dados inválidos fornecidos', validation.errors));
        }

        // Substituir req.body pelos dados validados e sanitizados
        req.body = validation.data;
        req.validationDetails = validation.validationDetails;

        next();
      } catch (error) {
        return next(error);
      }
    };
  }

  /**
   * Adiciona novo schema de validação
   */
  addSchema(name, schema) {
    schemas[name] = schema;
  }

  /**
   * Registra nova política de caracteres (proteção principal).
   * Aceita apenas função `(value) => boolean`; policy.type === 'function'.
   */
  addCharacterWhitelist(name, policy) {
    if (typeof policy !== 'function') {
      throw new TypeError('Política de caracteres deve ser uma função de classificação');
    }
    characterPolicies[name] = policy;
  }

  /**
   * Atualiza limite de tamanho para contexto
   */
  updatePayloadSizeLimit(context, size) {
    this.maxPayloadSizes[context] = size;
  }
}

// Instância global do validador
export const inputValidator = new InputValidator();

// Middlewares pré-configurados
export const validateLogin = inputValidator.createValidationMiddleware('login');
export const validateRegister = inputValidator.createValidationMiddleware('register');
export const validateUpdateProfile = inputValidator.createValidationMiddleware('updateProfile');
