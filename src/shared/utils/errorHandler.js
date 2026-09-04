import mongoose from 'mongoose';

export class HttpError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errorHandler = (error, _req, res, _next) => {
  const isHttpError = error instanceof HttpError;
  const statusCode = isHttpError ? error.statusCode : 500;
  const response = {
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

/**
 * Configura handlers para erros não tratados
 */
export const setupErrorHandlers = (server) => {
  const gracefulShutdown = async(signal) => {
    console.log(`📵 Recebido ${signal}, iniciando graceful shutdown...`);

    try {
      server.close(async() => {
        console.log('🔴 Servidor HTTP fechado.');

        try {
          // Fecha conexão do MongoDB com proteção
          if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
            console.log('🔴 Conexão MongoDB fechada.');
          }
        } catch (dbError) {
          console.error('⚠️ Erro ao fechar MongoDB:', dbError.message);
        }

        process.exit(0);
      });
    } catch (serverError) {
      console.error('⚠️ Erro ao fechar servidor:', serverError.message);
      process.exit(1);
    }

    // Force close após 10 segundos
    setTimeout(() => {
      console.error('❌ Timeout - forçando fechamento...');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // MELHOR tratamento de erros não críticos
  process.on('uncaughtException', (err) => {
    console.error('❌ Erro não tratado:', err.message);

    // Se for erro de métricas, não quebrar a aplicação
    if (err.message.includes('forEach') || err.message.includes('metrics')) {
      console.log('⚠️ Erro de métricas ignorado - aplicação continua rodando');
      return; // NÃO chamar gracefulShutdown
    }

    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, _promise) => {
    console.error('❌ Rejeição não tratada:', reason);
    gracefulShutdown('unhandledRejection');
  });
};
