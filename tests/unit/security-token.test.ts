import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { requireSecurityToken, securityTokenConfigured } from '../../src/application/middleware/securityToken.js';
import { HttpError } from '../../src/shared/utils/errorHandler.js';

const setToken = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.SECURITY_DASHBOARD_TOKEN;
  } else {
    process.env.SECURITY_DASHBOARD_TOKEN = value;
  }
};

describe('requireSecurityToken', () => {
  const original = process.env.SECURITY_DASHBOARD_TOKEN;

  afterEach(() => setToken(original));

  it('libera o acesso com o token correto', () => {
    setToken('security-token-123');
    const next = jest.fn();
    const req = {
      get: (name: string) => name === 'x-security-token' ? 'security-token-123' : undefined
    };

    requireSecurityToken(req as never, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejeita token ausente com 401', () => {
    setToken('security-token-123');
    const next = jest.fn();
    const req = { get: () => undefined };

    requireSecurityToken(req as never, {} as never, next);

    const error = next.mock.calls[0][0] as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('SECURITY_FORBIDDEN');
  });

  it('rejeita token incorreto com 401', () => {
    setToken('security-token-123');
    const next = jest.fn();
    const req = { get: () => 'security-token-124' };

    requireSecurityToken(req as never, {} as never, next);

    expect((next.mock.calls[0][0] as HttpError).code).toBe('SECURITY_FORBIDDEN');
  });

  it('rejeita tokens com tamanhos diferentes sem lançar erro', () => {
    setToken('security-token-123');
    const next = jest.fn();
    const req = { get: () => 'x' };

    expect(() => requireSecurityToken(req as never, {} as never, next)).not.toThrow();
    expect((next.mock.calls[0][0] as HttpError).statusCode).toBe(401);
  });

  it('falha fechado quando o token do servidor não está configurado', () => {
    setToken(undefined);
    const next = jest.fn();
    const req = { get: () => 'security-token-123' };

    requireSecurityToken(req as never, {} as never, next);

    const error = next.mock.calls[0][0] as HttpError;
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('SECURITY_TOKEN_NOT_CONFIGURED');
  });

  it('informa se o token está configurado', () => {
    setToken('security-token-123');
    expect(securityTokenConfigured()).toBe(true);

    setToken(undefined);
    expect(securityTokenConfigured()).toBe(false);
  });
});
