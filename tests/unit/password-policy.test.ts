import { describe, it, expect, jest } from '@jest/globals';
import {
  validatePasswordStrength,
  getPasswordRequirements,
  isCommonPassword,
  wasPasswordUsedBefore,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_HISTORY_LIMIT,
  PASSWORD_POLICY,
  passwordByteLength
} from '../../src/shared/utils/passwordPolicy.js';

describe('validatePasswordStrength - política de senha forte', () => {
  it('aceita senha que atende todos os requisitos', () => {
    const result = validatePasswordStrength('StrongPass123!');
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejeita senha obrigatória ausente', () => {
    const result = validatePasswordStrength('');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Senha é obrigatória');
  });

  it('rejeita senha curta demais', () => {
    const result = validatePasswordStrength('Ab1!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(`Senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`);
  });

  it('rejeita senha que passa do limite de bytes', () => {
    const long = `A1!${'a'.repeat(PASSWORD_MAX_LENGTH)}`;
    const result = validatePasswordStrength(long);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(`Senha não pode exceder ${PASSWORD_MAX_LENGTH} bytes`);
  });

  it('conta o limite em BYTES, não em caracteres', () => {
    // 28 caracteres multibyte = 76 bytes: passa em contagem de caracteres, mas
    // estoura o teto. Contar em caracteres deixaria o usuário acreditar num
    // limite que o serviço não está medindo.
    const multibyte = `Aa1!${'€'.repeat(24)}`;
    expect(multibyte.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
    expect(passwordByteLength(multibyte)).toBeGreaterThan(PASSWORD_MAX_LENGTH);

    const result = validatePasswordStrength(multibyte);
    expect(result.isValid).toBe(false);
    expect(result.errors.join(' ')).toContain(`${PASSWORD_MAX_LENGTH} bytes`);
  });

  it('aceita senha exatamente no limite de bytes', () => {
    const atLimit = `Aa1!${'a'.repeat(PASSWORD_MAX_LENGTH - 4)}`;
    expect(passwordByteLength(atLimit)).toBe(PASSWORD_MAX_LENGTH);
    expect(validatePasswordStrength(atLimit).isValid).toBe(true);
  });

  it('exige letra maiúscula', () => {
    const result = validatePasswordStrength('lowercase123!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Senha deve conter pelo menos uma letra maiúscula');
  });

  it('exige letra minúscula', () => {
    const result = validatePasswordStrength('UPPERCASE123!');
    expect(result.errors).toContain('Senha deve conter pelo menos uma letra minúscula');
  });

  it('exige número', () => {
    const result = validatePasswordStrength('NumbersAccount!');
    expect(result.errors).toContain('Senha deve conter pelo menos um número');
  });

  it('exige caractere especial', () => {
    const result = validatePasswordStrength('NoSpecial123456');
    expect(result.errors).toContain('Senha deve conter pelo menos um caractere especial (!@#$%^&*-_=+)');
  });

  it('acumula múltiplos erros em uma única validação', () => {
    const result = validatePasswordStrength('short');
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('getPasswordRequirements - mensagem amigável', () => {
  it('menciona o mínimo de caracteres e as classes exigidas', () => {
    const message = getPasswordRequirements();
    expect(message).toContain(`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`);
    expect(message).toContain('letra maiúscula');
    expect(message).toContain('letra minúscula');
    expect(message).toContain('número');
    expect(message).toContain('caractere especial');
  });
});

describe('isCommonPassword - lista de senhas comuns', () => {
  it.each(['password', 'password123', 'admin', '123456', 'qwerty'])('detecta %s como comum', (password) => {
    expect(isCommonPassword(password)).toBe(true);
  });

  it('aceita senha fora da lista de comuns', () => {
    expect(isCommonPassword('CloudyBlueSky42')).toBe(false);
  });
});

describe('PASSWORD_POLICY - decisões explícitas', () => {
  it('declara a política em um único objeto', () => {
    expect(PASSWORD_POLICY.minLength).toBe(PASSWORD_MIN_LENGTH);
    expect(PASSWORD_POLICY.maxLengthBytes).toBe(PASSWORD_MAX_LENGTH);
    expect(PASSWORD_POLICY.historyLimit).toBe(PASSWORD_HISTORY_LIMIT);
  });

  it('não expira senha por prazo (decisão de projeto)', () => {
    expect(PASSWORD_POLICY.expires).toBe(false);
  });

  it('mantém um teto explícito de bytes, independente do algoritmo', () => {
    // O argon2id não trunca em 72, mas teto definido protege o serviço de
    // entrada desnecessariamente grande e mantém a política estável.
    expect(PASSWORD_POLICY.maxLengthBytes).toBe(72);
  });
});

describe('wasPasswordUsedBefore - histórico de senhas', () => {
  const compareAlwaysTrue = async() => true;
  const compareAlwaysFalse = async() => false;

  it('retorna false quando não há histórico', async() => {
    expect(await wasPasswordUsedBefore('StrongPass123!', null, compareAlwaysTrue)).toBe(false);
    expect(await wasPasswordUsedBefore('StrongPass123!', undefined, compareAlwaysTrue)).toBe(false);
    expect(await wasPasswordUsedBefore('StrongPass123!', [], compareAlwaysTrue)).toBe(false);
  });

  it('retorna true quando uma senha do histórico coincide', async() => {
    const result = await wasPasswordUsedBefore(
      'StrongPass123!',
      ['hash-antigo'],
      compareAlwaysTrue
    );
    expect(result).toBe(true);
  });

  it('retorna false quando nenhuma senha do histórico coincide', async() => {
    const result = await wasPasswordUsedBefore(
      'StrongPass123!',
      ['hash-1', 'hash-2'],
      compareAlwaysFalse
    );
    expect(result).toBe(false);
  });

  it('avalia apenas as últimas senhas do histórico', async() => {
    const compare = jest.fn().mockResolvedValue(false);
    const history = Array.from({ length: 10 }, (_, i) => `hash-${i}`);

    await wasPasswordUsedBefore('StrongPass123!', history, compare);

    // O histórico é limitado: comparar com 10 hashes seria trabalho inútil
    expect(compare).toHaveBeenCalledTimes(PASSWORD_HISTORY_LIMIT);
  });

  it('propaga o erro de comparação em vez de seguir como se nada tivesse sido reutilizado', async() => {
    // O comportamento antigo (ignorar e continuar) respondia `false` mesmo sem
    // ter comparádo: o usuário podia trocar a senha para uma que já constava no
    // histórico. Em caso de falha, a resposta honesta é "não deu para saber",
    // e quem decide o que fazer com isso é o caso de uso.
    const compare = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(false);

    await expect(wasPasswordUsedBefore('StrongPass123!', ['hash-1', 'hash-2'], compare))
      .rejects.toThrow('boom');
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe('wasPasswordUsedBefore - a pergunta não pode ficar sem resposta', () => {
  it('propaga a falha de comparação em vez de responder "não usou antes"', async() => {
    // Responder `false` aqui permitiria trocar a senha para uma que já foi
    // usada: a checagem estaria dizendo "liberado" sem ter comparado nada.
    const compare = jest.fn().mockRejectedValue(new Error('pepper ausente'));

    await expect(wasPasswordUsedBefore('NovaSenha#1', ['hash-antigo'], compare))
      .rejects.toThrow('pepper ausente');
  });

  it('não compara nada quando não há histórico', async() => {
    const compare = jest.fn();

    await expect(wasPasswordUsedBefore('NovaSenha#1', [], compare)).resolves.toBe(false);
    await expect(wasPasswordUsedBefore('NovaSenha#1', null, compare)).resolves.toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });
});
