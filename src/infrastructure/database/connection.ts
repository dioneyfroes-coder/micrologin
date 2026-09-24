import mongoose from 'mongoose';
import { logger } from '../../shared/utils/logger.js';

/**
 * Conecta ao banco de dados MongoDB
 */
export const connectDatabase = async(): Promise<void> => {
  try {
    if (!process.env.URI_MONGODB) {
      throw new Error('URI_MONGODB não definida nas variáveis de ambiente');
    }

    await mongoose.connect(process.env.URI_MONGODB, {});
  } catch (error) {
    logger.error('❌ Erro ao conectar ao MongoDB', error);
    process.exit(1);
  }
};
