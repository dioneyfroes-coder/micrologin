import { describe, it, expect, jest } from '@jest/globals';
import { ServiceContainer, container } from '../../src/core/ServiceContainer.js';

describe('ServiceContainer - container de injeção de dependência', () => {
  it('registra e resolve um serviço', () => {
    const c = new ServiceContainer();
    c.register('math', () => 2 + 2);

    expect(c.has('math')).toBe(true);
    expect(c.resolve('math')).toBe(4);
  });

  it('lança erro ao resolver serviço desconhecido', () => {
    const c = new ServiceContainer();
    expect(() => c.resolve('missing')).toThrow('Serviço não registrado: missing');
  });

  it('retorna a mesma instância para serviços singleton', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({ value: Date.now() }));

    c.register('singleton', factory, true);
    const a = c.resolve('singleton');
    const b = c.resolve('singleton');

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('cria nova instância para serviços não-singleton', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({ value: Date.now() }));

    c.register('transient', factory, false);
    const a = c.resolve('transient');
    const b = c.resolve('transient');

    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('detecta dependências circulares', () => {
    const c = new ServiceContainer();

    c.register('a', () => c.resolve('b'));
    c.register('b', () => c.resolve('a'));

    expect(() => c.resolve('a')).toThrow(/Dependência circular detectada/);
  });

  it('limpa instâncias singleton e mantém registros', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({}));

    c.register('svc', factory, true);
    const a = c.resolve('svc');
    c.clear();
    const b = c.resolve('svc');

    expect(a).not.toBe(b);
    expect(c.has('svc')).toBe(true);
  });

  it('registra múltiplos serviços via registerBatch', () => {
    const c = new ServiceContainer();
    c.registerBatch({
      one: { factory: () => 1, singleton: true },
      two: { factory: () => 2, singleton: false }
    });

    expect(c.list()).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('fornece resolução com escopo e descarte', () => {
    const c = new ServiceContainer();
    c.register('dep', () => ({ token: 'x' }), true);

    const scope = c.createScope();
    const first = scope.resolve('dep');
    const second = scope.resolve('dep');

    expect(first).toBe(second);

    scope.dispose();
    const again = scope.resolve('dep');
    expect(again.token).toBe('x');
  });

  it('expõe o container global como instância do ServiceContainer', () => {
    expect(container).toBeInstanceOf(ServiceContainer);
  });
});
