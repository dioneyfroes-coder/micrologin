// src/middleware/sanitization.js
import DOMPurify from 'isomorphic-dompurify';
import validator from 'validator';

/**
 * Remoção de caracteres de controle (Unicode) por CLASSIFICAÇÃO de
 * charCode, sem expressão regular. Cobre C0 controls (U+0000–U+001F) e
 * C1 controls (U+007F–U+009F).
 */
const stripControlCharacters = (value) => {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x0000 && code <= 0x001F) {
      continue;
    }
    if (code >= 0x007F && code <= 0x009F) {
      continue;
    }
    result += char;
  }
  return result;
};

export const sanitizeInput = (req, res, next) => {
  // Sanitizar strings recursivamente
  const sanitizeObject = (obj) => {
    if (typeof obj === 'string') {
      // Remover scripts maliciosos
      obj = DOMPurify.sanitize(obj);
      // Escapar caracteres SQL
      obj = validator.escape(obj);
      // Remover caracteres de controle (Unicode) sem regex
      obj = stripControlCharacters(obj);
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
