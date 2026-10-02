/**
 * Copyright (c) 2026 Dioney Froes
 * Project: Micrologin
 * Provenance-ID: ML-7F2A
 */

/**
 * Vocabulário único de resultado dos eventos de autenticação.
 *
 * Este módulo existe porque a decisão "qual é o resultado deste evento?" estava
 * duplicada: o controller traduzia o mesmo resultado para duas línguas
 * diferentes - um booleano para a auditoria, uma string para o coletor de
 * métricas - e cada consumidor reinterpretava a sua. O efeito prático era que o
 * controller passava o código cru do domínio adiante, e como nenhum código do
 * domínio estava no conjunto de rótulos, todo desfecho diferente de sucesso
 * virava `error`.
 *
 * Consequência: `reused`, `unavailable`, `invalid` e `current_password_invalid`
 * - justamente os rótulos que distinguem comprometimento de erro de usuário -
 * nunca apareciam em nenhum gráfico. Um alerta de reuso de refresh token era
 * impossível de escrever.
 *
 * A tradução fica aqui, num lugar só, e é testada com os códigos que o domínio
 * de fato emite.
 */

/**
 * Resultado de um evento de autenticação, já normalizado.
 *
 * Lista fechada de propósito: um rótulo por erro destruiria qualquer agrupamento
 * posterior e explodiria a cardinalidade de onde for indexado. Valor fora daqui
 * vira `error`, nunca um rótulo novo.
 */
export const AUTH_OUTCOMES = [
  'success',
  'failure',
  'invalid',
  'reused',
  'unavailable',
  'current_password_invalid',
  'rejected',
  'error'
] as const;

export type AuthOutcome = typeof AUTH_OUTCOMES[number];

const AUTH_OUTCOME_SET: ReadonlySet<string> = new Set<string>(AUTH_OUTCOMES);

/**
 * Tipos de evento de autenticação contados.
 */
export type AuthEventKind = 'login' | 'token_refresh' | 'password_change' | 'security';

/**
 * Rótulos válidos por tipo de evento.
 *
 * Um vocabulário por tipo é o que torna os eventos comparáveis: `reused` só
 * faz sentido para refresh, `current_password_invalid` só para troca de senha.
 * A lista é derivada do código, não escrita à mão num texto que ninguém conferia.
 */
export const AUTH_OUTCOMES_BY_KIND: Readonly<Record<AuthEventKind, readonly AuthOutcome[]>> = {
  login: ['success', 'failure', 'unavailable', 'error'],
  token_refresh: ['success', 'invalid', 'reused', 'unavailable', 'error'],
  password_change: ['success', 'current_password_invalid', 'rejected', 'error'],
  security: ['reused', 'error']
};

/**
 * Código do domínio -> rótulo, por tipo de evento.
 *
 * As chaves são os códigos que `AuthService` e `JWTTokenService` realmente
 * emitem: os `code:` dos `return` do domínio e o `error.code` do adapter de
 * token.
 */
const OUTCOME_BY_CODE: Readonly<Record<AuthEventKind, Readonly<Record<string, AuthOutcome>>>> = {
  login: {
    // `/login` não distingue motivo de propósito: responder "usuário não
    // encontrado" a uma senha errada enumeraria contas. Para quem observa, toda
    // recusa de credencial é a mesma coisa.
    AUTHENTICATION_FAILED: 'failure',
    VALIDATION_ERROR: 'failure',
    // Exceção que não é credencial: em fail-closed, com o armazenamento de
    // revogação fora do ar, o login recusa por indisponibilidade. Contar como
    // `failure` transformaria uma queda do Redis em tentativa de ataque.
    REVOCATION_UNAVAILABLE: 'unavailable',
    // Semáforo de hash saturado: também é o serviço recusando por capacidade,
    // não a credencial sendo julgada. Contar como 'failure' transformaria
    // sobrecarga em tentativa de ataque nos gráficos de segurança.
    ARGON2_OVERLOADED: 'unavailable'
  },
  token_refresh: {
    // Reuso é sinal de comprometimento, não erro de usuário: precisa de label
    // própria para o alerta de token roubado.
    REFRESH_TOKEN_REUSED: 'reused',
    REFRESH_TOKEN_INVALID: 'invalid',
    REFRESH_TOKEN_EXPIRED: 'invalid',
    // Redis fora em fail-closed: a sessão não foi encerrada. "unavailable"
    // separa "não deu para revogar" de "token ruim".
    REVOCATION_UNAVAILABLE: 'unavailable'
  },
  security: {
    TOKEN_REUSE_DETECTED: 'reused'
  },
  password_change: {
    CURRENT_PASSWORD_INVALID: 'current_password_invalid',
    INVALID_PASSWORD: 'rejected',
    PASSWORD_TOO_COMMON: 'rejected',
    PASSWORD_REUSED: 'rejected',
    USER_NOT_FOUND: 'rejected',
    // Não deu para consultar o histórico (comparação de hash falhou). Não é
    // 'rejected': recusar por política contra um usuário que não fez nada de
    // errado esconde um defeito de infraestrutura.
    PASSWORD_HISTORY_UNAVAILABLE: 'unavailable',
    // Semáforo do argon2id saturado no momento de gravar o novo hash.
    ARGON2_OVERLOADED: 'unavailable'
  }
};

/**
 * Desfecho assumido quando o evento não traz código.
 *
 * `error` seria o padrão seguro para "não sei", mas código ausente é um caso
 * conhecido de cada fluxo, e tratá-lo como erro interno mascararia falha de
 * código que ainda nem saiu do lugar. Cada fluxo declara o seu.
 */
const OUTCOME_WITHOUT_CODE: Readonly<Record<AuthEventKind, AuthOutcome>> = {
  login: 'failure',
  token_refresh: 'invalid',
  password_change: 'rejected',
  security: 'error'
};

/**
 * Normaliza o desfecho de um evento.
 *
 * Aceita três formatos porque eles aparecem em camadas diferentes:
 * `success`/`failure` já vem do controller, o código do domínio vem do caso de
 * uso, e qualquer outra coisa é lixo. Os dois primeiros viram `success` ou
 * `failure`; o resto passa pela tabela do tipo de evento.
 */
export const authOutcomeFor = (
  kind: AuthEventKind,
  outcomeOrCode?: string | null
): AuthOutcome => {
  const raw = (outcomeOrCode ?? '').trim();
  if (!raw) {
    return OUTCOME_WITHOUT_CODE[kind];
  }

  const mapped = OUTCOME_BY_CODE[kind][raw];
  if (mapped) {
    return mapped;
  }

  // Já é um rótulo conhecido? Aceita, desde que faça sentido para o tipo.
  if (AUTH_OUTCOME_SET.has(raw)) {
    const label = raw as AuthOutcome;
    return AUTH_OUTCOMES_BY_KIND[kind].includes(label) ? label : 'error';
  }

  return 'error';
};

/**
 * O evento deu certo?
 *
 * Usado pela auditoria para derivar severidade e contadores, para que nenhum
 * consumidor reinterprete o rótulo por conta própria.
 */
export const isSuccessOutcome = (outcome: AuthOutcome): boolean => outcome === 'success';
