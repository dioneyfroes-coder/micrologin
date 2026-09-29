import mongoose from 'mongoose';
import { getMongoClientOptions } from '../../interfaces/config/mongoConfig.js';

/**
 * Conecta ao banco de dados MongoDB
 */
export const connectDatabase = async(): Promise<void> => {
  const { uri, options } = getMongoClientOptions();

  if (!uri) {
    throw new Error('URI_MONGODB não definida nas variáveis de ambiente');
  }

  // Sem process.exit aqui: quem chama decide (app.start captura e encerra;
  // testes podem detectar falha sem morrer o worker do Jest).
  await mongoose.connect(uri, options);
};
