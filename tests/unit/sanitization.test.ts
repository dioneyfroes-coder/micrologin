import { describe, it, expect, jest } from '@jest/globals';
import { sanitizeInput } from '../../src/application/middleware/sanitization.js';

describe('sanitizeInput - sanitização de entrada', () => {
  it('remove tags HTML/script de strings do body', () => {
    const req = { body: { username: '<script>alert(1)</script>alice', password: 'StrongPass123!' } };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(req.body.username).not.toContain('<script>');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('remove caracteres de controle Unicode', () => {
    const req = { body: { username: 'ali\u0000ce' } };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(req.body.username).toBe('alice');
    expect(next).toHaveBeenCalled();
  });

  it('sanitiza objetos aninhados recursivamente', () => {
    const req = {
      body: { profile: { bio: '<b>hello</b>', city: 'Sao Paulo' } }
    };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(req.body.profile.bio).not.toContain('<b>');
    expect(req.body.profile.city).toBe('Sao Paulo');
  });

  it('sanitiza query strings', () => {
    const req = { body: {}, query: { q: '<script>x</script>' }, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(req.query.q).not.toContain('<script>');
  });

  it('sanitiza params', () => {
    const req = { body: {}, query: {}, params: { id: '<img src=x onerror=alert(1)>' } };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(req.params.id).not.toContain('onerror');
  });

  it('segue para next mesmo sem corpo', () => {
    const req = { body: {}, query: {}, params: {} };
    const next = jest.fn();

    sanitizeInput(req, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
