// src/middleware/sanitization.js
import DOMPurify from 'isomorphic-dompurify';
import validator from 'validator';

export const sanitizeInput = (req, res, next) => {
  // Sanitizar strings recursivamente
  const sanitizeObject = (obj) => {
    if (typeof obj === 'string') {
      // Remover scripts maliciosos
      obj = DOMPurify.sanitize(obj);
      // Escapar caracteres SQL
      obj = validator.escape(obj);
      // Remover caracteres de controle (Unicode)
      // eslint-disable-next-line no-control-regex
      obj = obj.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    } else if (typeof obj === 'object' && obj !== null) {
      for (const key in obj) {
        obj[key] = sanitizeObject(obj[key]);
      }
    }
    return obj;
  };

  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    if (req.query && typeof req.query === 'object') {
      const sanitizedQuery = sanitizeObject({ ...req.query });
      Object.keys(sanitizedQuery).forEach(key => {
        req.query[key] = sanitizedQuery[key];
      });
    }

    if (req.params && typeof req.params === 'object') {
      const sanitizedParams = sanitizeObject({ ...req.params });
      // Sobrescrever propriedades individuais em vez do objeto inteiro
      Object.keys(sanitizedParams).forEach(key => {
        req.params[key] = sanitizedParams[key];
      });
    }

  } catch (error) {
    console.warn('⚠️ Erro na sanitização de input:', error.message);
    // Continuar sem sanitização em caso de erro
  }

  next();
};
