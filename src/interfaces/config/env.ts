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

// Os testes são herméticos: eles montam o ambiente via `process.env` e
// `tests/env.setup.js`, e não devem ler o `.env` da máquina de quem roda. O
// arquivo de desenvolvimento injeta valores que o CI (sem `.env`) não tem — por
// exemplo `JWT_ALGORITHM=HS256` fazia os testes de produção, que esperam o
// default ES256, falharem só localmente. A chave é ligada no setup de teste; o
// teste de `env.ts` a desliga para exercitar o carregamento de verdade.
const skipDotenv = process.env.MICROLOGIN_SKIP_DOTENV === 'true';

if (!skipDotenv) {
  const result = dotenv.config({ path: envPath });

  const loadError = result.error ? (result.error as Error & { code?: string }) : null;

  if (loadError && loadError.code && loadError.code !== 'ENOENT') {
    logger.error('❌ Erro ao carregar .env', loadError);
    throw loadError;
  }

  if (loadError) {
    logger.warn('⚠️ Arquivo .env não encontrado; usando variáveis do ambiente do sistema');
  }
}
