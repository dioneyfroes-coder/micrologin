/**
 * NORMALIZAÇÃO DE ENTRADA (não confundir com sanitização de saída)
 *
 * O que este middleware faz:
 * 1. remove caracteres de controle Unicode (C0/C1), que quebram logs e
 *   iky keys de cache;
 * 2. NÃO transforma credenciais (`password`, `refreshToken`, ...): são valores
 *    opacos e mudá-los quebra a senha real do usuário e a revogação de tokens.
 *
 * O que este middleware NÃO faz (e por quê):
 * - HTML escaping: a API responde JSON, não HTML. Escapar `<`/`&` na entrada
 *   altera o valor fornecido pelo cliente sem impedir XSS (que depende da
 *   codificação na SAÍDA, no ponto onde o dado é renderizado).
 * - "escapar SQL": não há SQL no projeto (MongoDB); a preocupação foi
 *   importada de outro contexto.
 * - Sanitização de senha com DOMPurify: senha não é markup, é segredo.
 *
 * Validação (formato/tamanho) vive em `validation.ts`; normalização de
 * identidade (username) vive em `usernamePolicy.ts`.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/utils/logger.js';

type Normalizable = string | Record<string, unknown> | null;

/**
 * Campos cujo valor é opaco: nunca podem ser transformados, pois a
 * verificação criptográfica depende do valor exato fornecido pelo cliente.
 */
const OPAQUE_FIELDS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'oldpassword',
  'senha',
  'senhanova',
  'senhaatual',
  'refreshtoken',
  'accesstoken',
  'authorization',
  'token'
]);

const isOpaqueField = (key: string): boolean => OPAQUE_FIELDS.has(key.toLowerCase());

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

export const normalizeInput = (req: Request, res: Response, next: NextFunction): void => {
  // Normalizar strings recursivamente
  const normalizeValue = (value: unknown, key?: string): Normalizable => {
    if (key !== undefined && isOpaqueField(key)) {
      return value as Normalizable;
    }

    if (typeof value === 'string') {
      return stripControlCharacters(value);
    }

    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      for (const recordKey of Object.keys(record)) {
        record[recordKey] = normalizeValue(record[recordKey], recordKey);
      }
    }

    return value as Normalizable;
  };

  try {
    if (req.body && typeof req.body === 'object') {
      req.body = normalizeValue(req.body);
    }

    if (req.query && typeof req.query === 'object') {
      const normalizedQuery = normalizeValue({ ...req.query }) as Record<string, unknown>;
      Object.keys(normalizedQuery).forEach(key => {
        (req.query as Record<string, unknown>)[key] = normalizedQuery[key];
      });
    }

    if (req.params && typeof req.params === 'object') {
      const normalizedParams = normalizeValue({ ...req.params }) as Record<string, unknown>;
      // Sobrescrever propriedades individuais em vez do objeto inteiro
      Object.keys(normalizedParams).forEach(key => {
        (req.params as Record<string, string>)[key] = normalizedParams[key] as string;
      });
    }

  } catch (error) {
    logger.warn('⚠️ Erro na normalização de input', error);
    // Continuar sem normalização em caso de erro
  }

  next();
};
