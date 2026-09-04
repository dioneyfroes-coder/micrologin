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

export const hasAllowedUsernameChars = (username) => {
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

export const isUsernameValid = (username) => !!(username &&
  username.length >= USERNAME_MIN_LENGTH &&
  username.length <= USERNAME_MAX_LENGTH &&
  hasAllowedUsernameChars(username));

export const USERNAME_CHARS_MESSAGE = 'apenas letras, números, underscores e hífens';
export const USERNAME_ERROR_MESSAGE = `Usuário deve conter entre ${USERNAME_MIN_LENGTH} e ${USERNAME_MAX_LENGTH} caracteres, ${USERNAME_CHARS_MESSAGE}.`;
