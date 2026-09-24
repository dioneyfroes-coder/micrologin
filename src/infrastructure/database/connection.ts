import mongoose from 'mongoose';

/**
 * Conecta ao banco de dados MongoDB
 */
export const connectDatabase = async(): Promise<void> => {
  if (!process.env.URI_MONGODB) {
    throw new Error('URI_MONGODB não definida nas variáveis de ambiente');
  }

  // Sem process.exit aqui: quem chama decide (app.start captura e encerra;
  // testes podem detectar falha sem morrer o worker do Jest).
  await mongoose.connect(process.env.URI_MONGODB, {});
};
