import { describe, it, expect, jest } from '@jest/globals';
import { ServiceContainer, container } from '../../src/core/ServiceContainer.js';

describe('ServiceContainer - DI container', () => {
  it('registers and resolves a service', () => {
    const c = new ServiceContainer();
    c.register('math', () => 2 + 2);

    expect(c.has('math')).toBe(true);
    expect(c.resolve('math')).toBe(4);
  });

  it('throws when resolving an unknown service', () => {
    const c = new ServiceContainer();
    expect(() => c.resolve('missing')).toThrow('Serviço não registrado: missing');
  });

  it('returns the same instance for singleton services', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({ value: Date.now() }));

    c.register('singleton', factory, true);
    const a = c.resolve('singleton');
    const b = c.resolve('singleton');

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('creates a new instance for non-singleton services', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({ value: Date.now() }));

    c.register('transient', factory, false);
    const a = c.resolve('transient');
    const b = c.resolve('transient');

    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('detects circular dependencies', () => {
    const c = new ServiceContainer();

    c.register('a', () => c.resolve('b'));
    c.register('b', () => c.resolve('a'));

    expect(() => c.resolve('a')).toThrow(/Dependência circular detectada/);
  });

  it('clears singleton instances and keeps registrations', () => {
    const c = new ServiceContainer();
    const factory = jest.fn(() => ({}));

    c.register('svc', factory, true);
    const a = c.resolve('svc');
    c.clear();
    const b = c.resolve('svc');

    expect(a).not.toBe(b);
    expect(c.has('svc')).toBe(true);
  });

  it('registers multiple services in a batch', () => {
    const c = new ServiceContainer();
    c.registerBatch({
      one: { factory: () => 1, singleton: true },
      two: { factory: () => 2, singleton: false }
    });

    expect(c.list()).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('provides scoped resolution with disposal', () => {
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

  it('returns the same instance for the module-level container', () => {
    expect(container).toBeInstanceOf(ServiceContainer);
  });
});
