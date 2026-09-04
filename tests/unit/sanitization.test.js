import { describe, it, expect, jest } from '@jest/globals';
import { sanitizeInput } from '../../src/application/middleware/sanitization.js';

describe('sanitizeInput - input sanitation middleware', () => {
  it('removes HTML/script tags from body strings', () => {
    const req = {
      body: { username: '<script>alert(1)</script>alice', password: 'StrongPass123!' }
    };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(req.body.username).not.toContain('<script>');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('removes control characters from input', () => {
    const req = {
      body: { username: 'ali\u0000ce' }
    };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(req.body.username).toBe('alice');
    expect(next).toHaveBeenCalled();
  });

  it('sanitizes nested objects recursively', () => {
    const req = {
      body: {
        profile: {
          bio: '<b>hello</b>',
          city: 'Sao Paulo'
        }
      }
    };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(req.body.profile.bio).not.toContain('<b>');
    expect(req.body.profile.city).toBe('Sao Paulo');
  });

  it('sanitizes query strings', () => {
    const req = {
      body: {},
      query: { q: '<script>x</script>' },
      params: {}
    };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(req.query.q).not.toContain('<script>');
    expect(next).toHaveBeenCalled();
  });

  it('continues to the next middleware when body is null', () => {
    const req = { body: null, query: {}, params: {} };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles arrays inside the payload', () => {
    const req = {
      body: { tags: ['<b>bold</b>', 'normal'] }
    };
    const res = {};
    const next = jest.fn();

    sanitizeInput(req, res, next);

    expect(req.body.tags[0]).not.toContain('<b>');
    expect(req.body.tags[1]).toBe('normal');
  });
});
