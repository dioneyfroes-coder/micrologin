import mongoose from 'mongoose';

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
