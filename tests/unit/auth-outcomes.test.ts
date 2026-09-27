/**
 * Vocabulário de desfecho dos eventos de autenticação.
 *
 * O teste que importa é o último: ele alimenta os códigos que o domínio REALMENTE
 * emite. A versão anterior destes testes passava 'reused' e 'invalid' direto
 * para o Prometheus e thereby provava que a tradutora funcionava - quando, em
 * produção, ninguém nunca passava essas strings, e todo desfecho colapsava em
 * `error`. Um teste que só exercita a fantasia da implementação não protege
 * nada.
 */
import { describe, it, expect } from '@jest/globals';
import {
  AUTH_OUTCOMES,
  AUTH_OUTCOMES_BY_KIND,
  authOutcomeFor,
  isSuccessOutcome
} from '../../src/shared/utils/authOutcomes.js';
import type { AuthEventKind } from '../../src/shared/utils/authOutcomes.js';

describe('authOutcomes - tradução do desfecho', () => {
  it('reuso de refresh vira "reused", e não "error"', () => {
    // Sinal de comprometimento. Se isto colapsar em `error`, o alerta de token
    // roubado deixa de existir e ninguém percebe.
    expect(authOutcomeFor('token_refresh', 'REFRESH_TOKEN_REUSED')).toBe('reused');
  });

  it('refresh inválido ou expirado vira "invalid"', () => {
    expect(authOutcomeFor('token_refresh', 'REFRESH_TOKEN_INVALID')).toBe('invalid');
    expect(authOutcomeFor('token_refresh', 'REFRESH_TOKEN_EXPIRED')).toBe('invalid');
  });

  it('revogação indisponível vira "unavailable", separada de token ruim', () => {
    // "não deu para revogar" e "o token é ruim" são operações diferentes, com
    // respostas diferentes. Juntas, uma indisponibilidade do Redis produziria
    // alertas de segurança falsos.
    expect(authOutcomeFor('token_refresh', 'REVOCATION_UNAVAILABLE')).toBe('unavailable');
    expect(authOutcomeFor('token_refresh', 'REVOCATION_UNAVAILABLE'))
      .not.toBe(authOutcomeFor('token_refresh', 'REFRESH_TOKEN_INVALID'));
  });

  it('senha atual incorreta tem rótulo próprio, distinto de "rejected"', () => {
    expect(authOutcomeFor('password_change', 'CURRENT_PASSWORD_INVALID')).toBe('current_password_invalid');
  });

  it('política de senha rejeita o valor, mas não é erro interno', () => {
    // Estes três são o usuário recebendo "não", não o sistema quebrando.
    for (const code of ['INVALID_PASSWORD', 'PASSWORD_TOO_COMMON', 'PASSWORD_REUSED']) {
      expect(authOutcomeFor('password_change', code)).toBe('rejected');
    }
  });

  it('código desconhecido vira "error" e nunca cria um rótulo novo', () => {
    // Rótulo de métrica vira dimensão de cardinalidade: um valor arbitrário
    // virando label acabaria com o Prometheus.
    expect(authOutcomeFor('password_change', 'senha_com_aspas\n_e_linha_nova')).toBe('error');
    expect(authOutcomeFor('token_refresh', 'qualquer_coisa')).toBe('error');
  });

  it('ausência de código assume o desfecho conhecido de cada fluxo', () => {
    // "Sem código" é um caso real de cada fluxo, não um "não sei": tratá-lo
    // como error mascararia falha de código que nem saiu do lugar.
    expect(authOutcomeFor('login', undefined)).toBe('failure');
    expect(authOutcomeFor('token_refresh', undefined)).toBe('invalid');
    expect(authOutcomeFor('password_change', null)).toBe('rejected');
  });

  it('login não distingue motivo: recusa de credencial é sempre "failure"', () => {
    // Responder "usuário não encontrado" a uma senha errada enumeraria contas.
    expect(authOutcomeFor('login', 'AUTHENTICATION_FAILED')).toBe('failure');
    expect(authOutcomeFor('login', 'VALIDATION_ERROR')).toBe('failure');
  });

  it('rótulo de outro fluxo não vaza para o evento', () => {
    // `reused` é legítimo em token_refresh e não existe em login. Aceitar
    // qualquer rótulo conhecido criaria uma combinação que o fluxo nunca emite.
    expect(authOutcomeFor('login', 'reused')).toBe('error');
    expect(authOutcomeFor('password_change', 'unavailable')).toBe('error');
  });

  it('todo rótulo prometido na ajuda do Prometheus é alcançável', () => {
    // A `help` da métrica é montada a partir de AUTH_OUTCOMES_BY_KIND. Um
    // rótulo acrescentado à lista sem tradutor correspondente seria prometido
    // na documentação e nunca apareceria - que é exatamente o defeito anterior,
    // em que `reused` e `unavailable` constavam da ajuda e não existiam.
    for (const kind of Object.keys(AUTH_OUTCOMES_BY_KIND) as AuthEventKind[]) {
      for (const label of AUTH_OUTCOMES_BY_KIND[kind]) {
        expect({ kind, label, translated: authOutcomeFor(kind, label) })
          .toEqual({ kind, label, translated: label });
      }
    }
  });

  it('a ajuda de cada métrica não promete rótulo de outro fluxo', () => {
    // `reused` é legítimo em token_refresh e não tem como ocorrer em login.
    expect(AUTH_OUTCOMES_BY_KIND.login).not.toContain('reused');
    expect(AUTH_OUTCOMES_BY_KIND.token_refresh).toContain('reused');
    expect(AUTH_OUTCOMES_BY_KIND.password_change).not.toContain('unavailable');
  });

  it('isSuccessOutcome só reconhece "success"', () => {
    expect(isSuccessOutcome('success')).toBe(true);
    for (const outcome of AUTH_OUTCOMES.filter(o => o !== 'success')) {
      expect(isSuccessOutcome(outcome)).toBe(false);
    }
  });
});
