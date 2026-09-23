// src/middleware/sanitization.js
import DOMPurify from 'isomorphic-dompurify';
import validator from 'validator';
import type { NextFunction, Request, Response } from 'express';

type Sanitizable = string | Record<string, unknown> | null;

/**
 * Remoção de caracteres de controle (Unicode) por CLASSIFICAÇÃO de
 * charCode, sem expressão regular. Cobre C0 controls (U+0000–U+001F) e
 * C1 controls (U+007F–U+009F).
 */
const stripControlCharacters = (value: string): string => {
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

export const sanitizeInput = (req: Request, res: Response, next: NextFunction): void => {
  // Sanitizar strings recursivamente
  const sanitizeObject = (obj: unknown): Sanitizable => {
    if (typeof obj === 'string') {
      // Remover scripts maliciosos
      let sanitized: string = DOMPurify.sanitize(obj);
      // Escapar caracteres SQL
      sanitized = validator.escape(sanitized);
      // Remover caracteres de controle (Unicode) sem regex
      sanitized = stripControlCharacters(sanitized);
      return sanitized;
    } else if (typeof obj === 'object' && obj !== null) {
      const record = obj as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        record[key] = sanitizeObject(record[key]);
      }
    }
    return obj as Sanitizable;
  };

  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    if (req.query && typeof req.query === 'object') {
      const sanitizedQuery = sanitizeObject({ ...req.query }) as Record<string, unknown>;
      Object.keys(sanitizedQuery).forEach(key => {
        (req.query as Record<string, unknown>)[key] = sanitizedQuery[key];
      });
    }

    if (req.params && typeof req.params === 'object') {
      const sanitizedParams = sanitizeObject({ ...req.params }) as Record<string, unknown>;
      // Sobrescrever propriedades individuais em vez do objeto inteiro
      Object.keys(sanitizedParams).forEach(key => {
        (req.params as Record<string, string>)[key] = sanitizedParams[key] as string;
      });
    }

  } catch (error) {
    console.warn('⚠️ Erro na sanitização de input:', (error as Error).message);
    // Continuar sem sanitização em caso de erro
  }

  next();
};
