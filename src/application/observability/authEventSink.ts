/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F2A
 *
 * PORTA DE EVENTOS DE AUTENTICACAO
 *
 * Onde o vocabulario de desfecho (ver `authOutcomes`) vira evento observavel.
 *
 * O projeto nao embute nem scrapea metricas: quem consome decide o que fazer com
 * o evento. Isso e deliberado. O que importa nao e o formato de saida, e o fato
 * de que a decisao "qual foi o resultado deste evento?" acontece UMA vez, num
 * lugar, e o rotulo viaja pronto.
 *
 * A porta existe para trocar o destino sem tocar nos chamadores:
 *
 * - o padrao escreve um log estruturado, que ja alimenta o agregador de logs de
 *   requisicao e o manifesto de `/observability`;
 * - um consumidor proprio pode receber o mesmo evento por qualquer via, sem
 *   que o dominio saiba que ele existe.
 */
import { logger } from '../../shared/utils/logger.js';
import { authOutcomeFor } from '../../shared/utils/authOutcomes.js';
import type { AuthEventKind, AuthOutcome } from '../../shared/utils/authOutcomes.js';

/**
 * Evento de autenticacao ja normalizado.
 *
 * `outcome` e o rotulo traduzido; `code` e o codigo do dominio, preservado para
 * quem precisar do detalhe. Os dois vao juntos porque o rotulo serve para
 * agrupar e o codigo serve para investigar.
 *
 * `at` e ISO-8601 com milissegundos: e a unica referencia de tempo no evento,
 * e o consumidor proprio precisa poder ordenar e agrupar por janela sem
 * depender do relogio da maquina que o emitiu.
 */
export interface AuthEvent {
  kind: AuthEventKind;
  outcome: AuthOutcome;
  code?: string;
  at: string;
}

/**
 * Destino de um evento de autenticacao.
 *
 * Retorna nada de proposito: um destino que lanca derrubaria a autenticacao por
 * causa da observabilidade. Quem implementa decide se engole ou registra.
 */
export type AuthEventSink = (event: AuthEvent) => void;

/**
 * Destino padrao: log estruturado.
 *
 * Um log por evento e o minimo que sustenta retrospectiva ("quantos refresh foram
 * reusados na ultima hora?") sem depender de coleta externa. Rótulos em
 * `auth_outcome` ficam como campo de primeira classe, e nao embutidos numa
 * string, para que o consumidor possa extrair por campo.
 */
const logSink: AuthEventSink = (event) => {
  logger.info('auth_event', {
    auth_kind: event.kind,
    auth_outcome: event.outcome,
    ...(event.code ? { auth_code: event.code } : {}),
    at: event.at
  });
};

let sink: AuthEventSink = logSink;

/**
 * Troca o destino dos eventos de autenticacao.
 *
 * Pensado para teste e para integracao com o meio proprio de observacao. Devolve
 * uma funcao que restaura o destino anterior, para nao vazar estado entre
 * testes.
 */
export const setAuthEventSink = (next: AuthEventSink | null): (() => void) => {
  const previous = sink;
  sink = next ?? logSink;
  return () => {
    sink = previous;
  };
};

/**
 * Publica um evento de autenticacao.
 *
 * Aceita o codigo do dominio ou um rotulo pronto e devolve o rotulo traduzido,
 * para que o chamador possa usar a mesma decisao no mesmo lugar (a auditoria
 * usa o retorno para derivar severidade e contadores).
 *
 * Traduzir e idempotente: passar um rotulo ja traduzido devolve o proprio
 * rotulo, com `code` omitido. Isso mantem a funcao segura para quem ja tem o
 * desfecho na mao, que e o caso de `SecurityAuditLogger`.
 */
export const recordAuthEvent = (
  kind: AuthEventKind,
  outcomeOrCode: string | null | undefined
): AuthOutcome => {
  const outcome = authOutcomeFor(kind, outcomeOrCode);
  const code = outcomeOrCode ?? undefined;

  try {
    sink({
      kind,
      outcome,
      ...(outcome !== code ? { code } : {}),
      at: new Date().toISOString()
    });
  } catch {
    // Observabilidade quebrada nao pode derrubar autenticacao. O logout e o
    // login ja decidiram; falhar aqui entregaria 500 a um login correto.
  }

  return outcome;
};

export const recordLoginAttempt = (outcomeOrCode: string | null | undefined): AuthOutcome =>
  recordAuthEvent('login', outcomeOrCode);

export const recordTokenRefresh = (outcomeOrCode: string | null | undefined): AuthOutcome =>
  recordAuthEvent('token_refresh', outcomeOrCode);

export const recordPasswordChange = (outcomeOrCode: string | null | undefined): AuthOutcome =>
  recordAuthEvent('password_change', outcomeOrCode);
