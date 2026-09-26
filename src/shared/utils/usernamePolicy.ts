/**
 * Política de username por CLASSIFICAÇÃO DE CARACTERES - FONTE ÚNICA.
 *
 * Todas as camadas (domínio, validação HTTP, schemas Joi) devem usar esta
 * definição para garantir regras consistentes de registro/login/atualização.
 *
 * A checagem principal não usa expressão regular: percorre os caracteres e
 * aceita apenas letras ASCII, dígitos, underscore e hífen. Regex fica
 * reservada apenas para detecção/monitoramento em outras camadas.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/**
 * Forma canônica de identidade: sem espaços nas bordas e em minúsculas.
 *
 * É a ÚNICA normalização aplicada a username (registro, login, atualização e
 * consultas ao repositório). Sem ela, `Alice` e `alice` seriam identidades
 * diferentes na consulta, apesar de o schema Mongo gravar em minúsculas.
 *
 * Senhas NÃO são normalizadas: são valores opacos.
 */
export const normalizeUsername = (username: string): string => username.trim().toLowerCase();

/**
 * Sanitizador seguro para uso em middlewares: preserva o valor original quando
 * não é string, para que a validação de tipo possa reportar o erro correto.
 */
export const normalizeUsernameField = (value: unknown): unknown => (
  typeof value === 'string' ? normalizeUsername(value) : value
);

export const hasAllowedUsernameChars = (username: string): boolean => {
  for (const char of username) {
    const code = char.charCodeAt(0);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit && char !== '_' && char !== '-') {
      return false;
    }
  }
  return true;
};

export const isUsernameValid = (username: string): boolean => !!(username &&
  username.length >= USERNAME_MIN_LENGTH &&
  username.length <= USERNAME_MAX_LENGTH &&
  hasAllowedUsernameChars(username));

export const USERNAME_CHARS_MESSAGE = 'apenas letras, números, underscores e hífens';
export const USERNAME_ERROR_MESSAGE = `Usuário deve conter entre ${USERNAME_MIN_LENGTH} e ${USERNAME_MAX_LENGTH} caracteres, ${USERNAME_CHARS_MESSAGE}.`;
