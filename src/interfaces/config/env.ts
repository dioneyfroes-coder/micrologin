/**
 * Carregamento de variáveis de ambiente
 * Este arquivo deve ser importado ANTES de qualquer outro módulo
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { logger } from '../../shared/utils/logger.js';

// Obter diretório raiz do projeto
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..', '..');

// Carregar .env do diretório raiz
const envPath = resolve(projectRoot, '.env');
const result = dotenv.config({ path: envPath });

const loadError = result.error ? (result.error as Error & { code?: string }) : null;

if (loadError && loadError.code && loadError.code !== 'ENOENT') {
  logger.error('❌ Erro ao carregar .env', loadError);
  throw loadError;
}

if (loadError) {
  logger.warn('⚠️ Arquivo .env não encontrado; usando variáveis do ambiente do sistema');
}
