import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';

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

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const isHttpError = error instanceof HttpError;
  const statusCode = isHttpError ? error.statusCode : 500;
  const response: ErrorResponse = {
    success: false,
    code: isHttpError ? error.code : 'INTERNAL_ERROR',
    message: isHttpError ? error.message : 'Erro interno do servidor'
  };

  if (isHttpError && error.details) {
    response.details = error.details;
  }

  if (!isHttpError) {
    console.error('Erro HTTP não tratado:', error);
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
    console.log(`📵 Recebido ${signal}, iniciando graceful shutdown...`);

    try {
      server.close(async() => {
        try {
          // Fecha conexão do MongoDB com proteção
          if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
          }
        } catch (dbError) {
          console.error('⚠️ Erro ao fechar MongoDB:', (dbError as Error).message);
        }

        process.exit(0);
      });
    } catch (serverError) {
      console.error('⚠️ Erro ao fechar servidor:', (serverError as Error).message);
      process.exit(1);
    }

    // Force close após timeout configurado
    setTimeout(() => {
      console.error('❌ Timeout - forçando fechamento...');
      process.exit(1);
    }, forceCloseTimeoutMs);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // MELHOR tratamento de erros não críticos
  process.on('uncaughtException', (err: Error) => {
    console.error('❌ Erro não tratado:', err.message);

    // Se for erro de métricas, não quebrar a aplicação
    if (err.message.includes('forEach') || err.message.includes('metrics')) {
      return; // NÃO chamar gracefulShutdown
    }

    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    console.error('❌ Rejeição não tratada:', reason);
    gracefulShutdown('unhandledRejection');
  });
};
