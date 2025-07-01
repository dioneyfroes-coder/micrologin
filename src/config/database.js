import mongoose from 'mongoose';

/**
 * Conecta ao banco de dados MongoDB
 */
export const connectDatabase = async() => {
  try {
    if (!process.env.URI_MONGODB) {
      throw new Error('URI_MONGODB não definida nas variáveis de ambiente');
    }

    await mongoose.connect(process.env.URI_MONGODB, {});
    console.log('✅ Conectado ao MongoDB!');
  } catch (error) {
    console.error('❌ Erro ao conectar ao MongoDB:', error);
    process.exit(1);
  }
};
