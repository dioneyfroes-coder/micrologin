import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

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

interface ClientErrorLike {
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Erros de cliente (body-parser, validations do express etc.) carregam status 4xx.
 * Sem isso, payload JSON inválido virava 500 (inflado a taxa de 5xx na observabilidade).
 */
const getClientStatus = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as ClientErrorLike;
  const status = candidate.statusCode ?? candidate.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return status;
  }
  return null;
};

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const isHttpError = error instanceof HttpError;
  const clientStatus = isHttpError ? null : getClientStatus(error);
  const isParseError = !isHttpError && typeof error === 'object' && error !== null
    && (error as ClientErrorLike).type === 'entity.parse.failed';

  const statusCode = isHttpError ? error.statusCode : clientStatus ?? 500;
  const response: ErrorResponse = {
    success: false,
    code: isHttpError ? error.code : isParseError ? 'INVALID_JSON' : clientStatus !== null ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
    message: isHttpError ? error.message
      : isParseError ? 'Payload JSON inválido'
        : clientStatus !== null ? 'Requisição inválida'
          : 'Erro interno do servidor'
  };

  if (isHttpError && error.details) {
    response.details = error.details;
  }

  if (!isHttpError && clientStatus === null) {
    logger.error('Erro HTTP não tratado', error);
  }

  return res.status(statusCode).json(response);
};

interface NodeServer {
  close(callback?: () => void): unknown;
}

/**
 * Configura handlers para erros não tratados
 *
 * ## Um `uncaughtException` sempre derruba o processo
 *
 * Uma exceção que escapou do fluxo normal significa que o estado do processo
 * não é confiável: pode haver um lock tomado sem metade da escrita, uma
 * transação aberta, um cache pela metade. Continuar rodando parece gentileza e
 * na prática adia o problema para um `TypeError` muito mais distante, sem
 * nenhum registro de que a causa existiu.
 *
 * Havia aqui uma isenção por mensagem:
 *
 * ```js
 * if (err.message.includes('forEach')) return; // "mantém a app de pé"
 * ```
 *
 * O efeito colateral era o oposto do pretendido. `forEach` aparece na mensagem
 * de qualquer `TypeError` lançado dentro de um `forEach` do domínio — não de
 * uma biblioteca de métricas, que era a origem histórica da isenção. Um erro
 * de domínio com a palavra no meio da frase mantinha o processo vivo com estado
 * possivelmente inconsistente, enquanto qualquer outro erro derrubava tudo. A
 * mesma falha, com uma palavra a menos ou a mais, decidia se o processo
 * sobrevivia.
 *
 * Decidir entre derrubar e continuar é decisão de resiliência — e ela é feita
 * uma vez, aqui, de forma uniforme e em favor da integridade. A disponibilidade
 * vem do orquestrador, que reinicia o processo: Docker com `restart:
 * unless-stopped` e PM2 com `autorestart` no default (`true`) sobem de novo
 * depois de qualquer saída, inclusive a não-zero de um crash.
 *
 * ## Por que o código de saída distingue crash de encerramento
 *
 * O `exit(0)` de um crash afirmaria que o processo terminou como deveria, e ele
 * não terminou. Nos dois orquestradores deste projeto isso não muda o
 * reinício — ambos reiniciam em qualquer código —, mas a informação errada
 * escapa para fora: alertas e runbooks que leem o código de saída do container
 * tratariam uma queda por estado inconsistente como uma parada programada, e
 * qualquer supervisor que *sim* distingue sucesso de falha (systemd com
 * `Restart=on-failure`, Kubernetes) deixaria o processo com estado inconsistente
 * no ar justamente por causa do `0`.
 *
 * Por isso: SIGTERM/SIGINT saem com 0 (encerramento pedido é sucesso), e
 * `uncaughtException`/`unhandledRejection` saem com 1.
 */
export const setupErrorHandlers = (server: NodeServer, timeoutMs = 10000) => {
  const forceCloseTimeoutMs = timeoutMs;

  /**
   * Trava de idempotência.
   *
   * Sem ela, um SIGTERM seguido de um `uncaughtException` dispararia duas
   * rotinas concorrentes: dois `server.close()`, dois `mongoose.close()` e dois
   * timers de force-close. Pior, o segundo `close()` numa conexão já fechada
   * lança, cai no `catch` e chama `process.exit(1)` no meio do encerramento
   * limpo — pullando o `close()` bem-sucedido pela janela.
   */
  let shuttingDown = false;

  const gracefulShutdown = async(signal: string, exitCode = 0) => {
    if (shuttingDown) {
      // Registrado e ignorado de propósito: o processo já está encerrando e a
      // rotina em curso vai fechar tudo. Um segundo shutdown aqui só criaria
      // duas bulbosas para o mesmo socket.
      logger.warn(`⚠️ ${signal} recebido durante graceful shutdown em andamento; encerramento já em curso`);
      return;
    }
    shuttingDown = true;

    logger.info(`📵 Recebido ${signal}, iniciando graceful shutdown (exit ${exitCode})...`);

    try {
      server.close(async() => {
        try {
          // Fecha conexão do MongoDB com proteção
          if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
          }
        } catch (dbError) {
          logger.error('⚠️ Erro ao fechar MongoDB', dbError);
        }

        process.exit(exitCode);
      });
    } catch (serverError) {
      logger.error('⚠️ Erro ao fechar servidor', serverError);
      process.exit(1);
    }

    // Force close após timeout configurado
    setTimeout(() => {
      logger.error('❌ Timeout - forçando fechamento...');
      process.exit(1);
    }, forceCloseTimeoutMs);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));

  // Um `uncaughtException` não é um erro de requisição: é o processo inteiro
  // perdeu a confiança em si mesmo. Registra a causa e derruba.
  process.on('uncaughtException', (err: Error) => {
    logger.error('❌ Erro não tratado', err);
    gracefulShutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    logger.error('❌ Rejeição não tratada', reason);
    // Mesma escala de `uncaughtException`: uma promessa rejeitada que ninguém
    // tratou é estado desconhecido, e saída 0 aqui diria ao orquestrador que
    // está tudo bem.
    gracefulShutdown('unhandledRejection', 1);
  });
};
