import { describe, expect, it, jest } from '@jest/globals';

const randomUUID = jest.fn(() => '11111111-2222-4333-8444-555555555555');

jest.unstable_mockModule('crypto', () => ({
  default: { randomUUID },
  randomUUID
}));

const { requestLogger } = await import('../../src/application/middleware/requestLogger.js');

interface FakeResponse {
  headers: Record<string, string>;
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: string, listener: () => void): void;
}

const buildResponse = (): FakeResponse => ({
  headers: {},
  statusCode: 200,
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  },
  on() {
    // o listener de 'finish' não é relevante para o id
  }
});

const run = (headerValue?: string): FakeResponse => {
  const req = {
    method: 'GET',
    path: '/health',
    get: (name: string) => (name === 'X-Request-Id' ? headerValue : undefined),
    route: { path: '/health' }
  } as never;
  const res = buildResponse();
  requestLogger(req, res as never, () => undefined);
  return res;
};

describe('requestLogger - confiança no X-Request-Id externo', () => {
  it('preserva um UUID válido vindo de um proxy confiável', () => {
    const res = run('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(res.headers['x-request-id']).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it.each([
    ['string arbitrária', 'nao-e-uuid'],
    ['uuid com sufixo', '3f2504e0-4f89-41d3-9a0c-0305e82c3301-inject'],
    ['uuid sem dashes', '3f2504e04f8941d39a0c0305e82c3301'],
    ['uuid com versão inválida', '3f2504e0-4f89-91d3-9a0c-0305e82c3301'],
    ['payload gigante', 'a'.repeat(5000)],
    ['tentativa de injeção de cabeçalho', 'abc\r\nX-Injected: 1'],
    ['json', '{"trace":"1"}']
  ])('descarta %s e gera id próprio', (_label, hostile) => {
    const res = run(hostile);
    expect(res.headers['x-request-id']).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('gera id quando o cabeçalho está ausente ou vazio', () => {
    expect(run(undefined).headers['x-request-id']).toBe('11111111-2222-4333-8444-555555555555');
    expect(run('   ').headers['x-request-id']).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('normaliza caixa do UUID antes de aceitar', () => {
    const res = run('3F2504E0-4F89-41D3-9A0C-0305E82C3301');
    expect(res.headers['x-request-id']).toBe('3F2504E0-4F89-41D3-9A0C-0305E82C3301');
  });
});
