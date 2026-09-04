/**
 * Carregamento de variáveis de ambiente
 * Este arquivo deve ser importado ANTES de qualquer outro módulo
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Obter diretório raiz do projeto
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..', '..');

// Carregar .env do diretório raiz
const envPath = resolve(projectRoot, '.env');
const result = dotenv.config({ path: envPath });

if (result.error && result.error.code !== 'ENOENT') {
  console.error('❌ Erro ao carregar .env:', result.error);
  throw result.error;
}

if (result.error) {
  console.warn('⚠️ Arquivo .env não encontrado; usando variáveis do ambiente do sistema');
}

// Apenas em modo de desenvolvimento, mostrar status
if (process.env.NODE_ENV === 'development') {
  console.log('🔧 Variáveis de ambiente carregadas');
}
