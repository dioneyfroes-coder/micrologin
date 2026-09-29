/**
 * @fileoverview LEITURA DE SEGREDO a partir de variável de ambiente ou de arquivo.
 *
 * Um segredo tem duas formas de chegar ao processo, e as duas existem por
 * motivos diferentes:
 *
 *   - variável de ambiente: simples, mas vaza em `docker inspect`, em dump de
 *     crash e em log de configuração;
 *   - arquivo montado (Docker secret, volume de KMS, secret manager): o valor
 *     não aparece em nenhum desses lugares, e o arquivo pode ter modo 600.
 *
 * O mesmo nome de variável nos dois formatos (`X` e `X_PATH`) é o contrato que
 * o compose e o app já usam para a chave ES256 e para o pepper, e é o mesmo que
 * os segredos das dependências (Fase 1.3) precisam obedecer.
 *
 * ⚠️ Não importa módulos do projeto para evitar ciclos de dependência.
 */

import { readFileSync } from 'fs';

export type SecretReadResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * `undefined` significa "não configurado"; `ok: false` significa "configurado e
 * ilegível". São estados opostos para quem valida: o primeiro não obriga nada,
 * o segundo é um erro de provisionamento que o arranque precisa recusar.
 */
export type SecretRead = SecretReadResult | undefined;

/**
 * Lê um segredo de `NAME` ou de `NAME_PATH`.
 *
 * @param name - Nome da variável de ambiente (ex.: `REDIS_PASSWORD`)
 */
export const readSecret = (name: string): SecretRead => {
  const raw = process.env[name];
  const path = process.env[`${name}_PATH`];

  // As duas fontes têm valores e são mutuamente exclusivas. Escolher uma em
  // silêncio é a pior das saídas: o operador troca uma, o app continua lendo a
  // outra, e a senha "que acabei de rotacionar" não é a que o serviço usa para
  // autenticar. O entrypoint do Mongo faz a mesma recusa (`file_env`).
  if (raw && path) {
    return {
      ok: false,
      error: `${name} e ${name}_PATH estão definidas: use uma só (o valor da outra é ignorado)`
    };
  }

  if (raw) {
    const value = raw.trim();
    return value ? { ok: true, value } : undefined;
  }

  if (path) {
    try {
      // O arquivo costuma vir de um secret montado por um orquestrador, e
      // sobra "\n" em quem escreve com `echo`. Sem o trim, a senha que o app
      // autentica não é a senha gerada — o serviço sobe e falha no primeiro
      // comando, longe de quem provisionou.
      const value = readFileSync(path, 'utf8').trim();
      return value ? { ok: true, value } : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const cause = code === 'ENOENT'
        ? 'arquivo não encontrado'
        : code === 'EACCES'
          ? 'sem permissão de leitura'
          : code || 'falha desconhecida';
      return { ok: false, error: `${name}_PATH não pôde ser lido: ${cause}` };
    }
  }

  return undefined;
};
