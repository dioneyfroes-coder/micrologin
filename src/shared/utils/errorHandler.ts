import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

export class HttpError extends Error {
  name: string;
  statusCode: number;
  code: string;
  details: unknown;

  constructor(statusCode: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

interface ErrorResponse {
  success: boolean;
  code: string;
  message: string;
  details?: unknown;
}

interface ClientErrorLike {
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Erros de cliente (body-parser, validations do express etc.) carregam status 4xx.
 * Sem isso, payload JSON inválido virava 500 (inflado a taxa de 5xx na observabilidade).
 */
const getClientStatus = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as ClientErrorLike;
  const status = candidate.statusCode ?? candidate.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return status;
  }
  return null;
};

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const isHttpError = error instanceof HttpError;
  const clientStatus = isHttpError ? null : getClientStatus(error);
  const isParseError = !isHttpError && typeof error === 'object' && error !== null
    && (error as ClientErrorLike).type === 'entity.parse.failed';

  const statusCode = isHttpError ? error.statusCode : clientStatus ?? 500;
  const response: ErrorResponse = {
    success: false,
    code: isHttpError ? error.code : isParseError ? 'INVALID_JSON' : clientStatus !== null ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
    message: isHttpError ? error.message
      : isParseError ? 'Payload JSON inválido'
        : clientStatus !== null ? 'Requisição inválida'
          : 'Erro interno do servidor'
  };

  if (isHttpError && error.details) {
    response.details = error.details;
  }

  if (!isHttpError && clientStatus === null) {
    logger.error('Erro HTTP não tratado', error);
  }

  return res.status(statusCode).json(response);
};

interface NodeServer {
  close(callback?: () => void): unknown;
}

/**
 * Configura handlers para erros não tratados
 */
export const setupErrorHandlers = (server: NodeServer, timeoutMs = 10000) => {
  const forceCloseTimeoutMs = timeoutMs;
  const gracefulShutdown = async(signal: string) => {
    logger.info(`📵 Recebido ${signal}, iniciando graceful shutdown...`);

    try {
      server.close(async() => {
        try {
          // Fecha conexão do MongoDB com proteção
          if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
          }
        } catch (dbError) {
          logger.error('⚠️ Erro ao fechar MongoDB', dbError);
        }

        process.exit(0);
      });
    } catch (serverError) {
      logger.error('⚠️ Erro ao fechar servidor', serverError);
      process.exit(1);
    }

    // Force close após timeout configurado
    setTimeout(() => {
      logger.error('❌ Timeout - forçando fechamento...');
      process.exit(1);
    }, forceCloseTimeoutMs);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // MELHOR tratamento de erros não críticos
  process.on('uncaughtException', (err: Error) => {
    logger.error('❌ Erro não tratado', err);

    // Se for erro de métricas, não quebrar a aplicação
    if (err.message.includes('forEach') || err.message.includes('metrics')) {
      return; // NÃO chamar gracefulShutdown
    }

    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    logger.error('❌ Rejeição não tratada', reason);
    gracefulShutdown('unhandledRejection');
  });
};
