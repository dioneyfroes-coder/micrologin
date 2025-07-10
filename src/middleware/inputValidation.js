/**
 * @fileoverview Validação rigorosa de input com schemas
 * Implementa validação de schema e whitelist de caracteres
 */

import Joi from 'joi';

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
      .min(8)
      .max(100)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
      .required()
      .messages({
        'string.min': 'Password deve ter pelo menos 8 caracteres',
        'string.max': 'Password deve ter no máximo 100 caracteres',
        'string.pattern.base': 'Password deve conter ao menos: 1 minúscula, 1 maiúscula, 1 número e 1 caractere especial'
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
      .min(8)
      .max(100)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
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
      .min(8)
      .max(100)
      .when('newPassword', {
        is: Joi.exist(),
        then: Joi.required(),
        otherwise: Joi.optional()
      }),
    newPassword: Joi.string()
      .min(8)
      .max(100)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
      .optional()
  })
};

// Whitelist de caracteres permitidos por contexto
const characterWhitelists = {
  username: /^[a-zA-Z0-9]+$/,
  email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  password: /^[A-Za-z\d@$!%*?&]+$/,
  general: /^[a-zA-Z0-9\s.,!?@#$%^&*()_+-=[\]{}|;':"<>?/~`]+$/
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
   * Valida caracteres usando whitelist
   */
  validateCharacters(value, type = 'general') {
    const whitelist = characterWhitelists[type];
    if (!whitelist) {
      throw new Error(`Whitelist '${type}' não encontrada`);
    }

    if (typeof value !== 'string') {
      return { isValid: false, message: 'Valor deve ser string' };
    }

    if (!whitelist.test(value)) {
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
          return res.status(400).json({
            error: 'Validation Error',
            message: 'Dados inválidos fornecidos',
            errors: validation.errors,
            details: process.env.NODE_ENV === 'development' ? validation.validationDetails : undefined
          });
        }

        // Substituir req.body pelos dados validados e sanitizados
        req.body = validation.data;
        req.validationDetails = validation.validationDetails;
        
        next();
      } catch (error) {
        console.error('Erro na validação:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Erro interno na validação'
        });
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
   * Adiciona nova whitelist de caracteres
   */
  addCharacterWhitelist(name, regex) {
    characterWhitelists[name] = regex;
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
