/**
 * Container de Dependências usando Padrão Singleton
 * Seguindo o Dependency Inversion Principle
 */

type Factory<T = unknown> = () => T;

interface ServiceEntry<T = unknown> {
  factory: Factory<T>;
  singleton: boolean;
  instance: T | null;
}

export class ServiceContainer {
  private static instance: ServiceContainer | null = null;
  private services!: Map<string, ServiceEntry>;
  private singletons!: Map<string, unknown>;
  private resolving!: Set<string>; // Para detectar dependências circulares

  constructor() {
    if (ServiceContainer.instance) {
      return ServiceContainer.instance;
    }

    this.services = new Map();
    this.singletons = new Map();
    this.resolving = new Set();
    ServiceContainer.instance = this;
  }

  /**
   * Registra um serviço no container
   */
  register<T>(name: string, factory: Factory<T>, singleton = true): void {
    this.services.set(name, {
      factory,
      singleton,
      instance: null
    });
  }

  /**
   * Resolve uma dependência
   */
  resolve<T = unknown>(name: string): T {
    const service = this.services.get(name);

    if (!service) {
      throw new Error(`Serviço não registrado: ${name}`);
    }

    // Detectar dependências circulares
    if (this.resolving.has(name)) {
      throw new Error(`Dependência circular detectada: ${name}`);
    }

    if (service.singleton) {
      if (!service.instance) {
        this.resolving.add(name);
        try {
          service.instance = service.factory();
        } finally {
          this.resolving.delete(name);
        }
      }
      return service.instance as T;
    }

    this.resolving.add(name);
    try {
      return service.factory() as T;
    } finally {
      this.resolving.delete(name);
    }
  }

  /**
   * Verifica se um serviço está registrado
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Lista todos os serviços registrados
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Lista todos os serviços registrados (alias)
   */
  list(): string[] {
    return this.getRegisteredServices();
  }

  /**
   * Limpa todas as instâncias singleton
   */
  clear(): void {
    this.services.forEach(service => {
      service.instance = null;
    });
    this.singletons.clear();
    this.resolving.clear();
  }

  /**
   * Registra múltiplos serviços de uma vez
   */
  registerBatch(services: Record<string, { factory: Factory; singleton?: boolean }>): void {
    Object.entries(services).forEach(([name, config]) => {
      this.register(name, config.factory, config.singleton);
    });
  }

  /**
   * Cria uma instância isolada (útil para testes)
   */
  createScope(): { resolve: <T = unknown>(name: string) => T; dispose: () => void } {
    const scope = new Map<string, unknown>();

    return {
      resolve: <T = unknown>(name: string): T => {
        if (scope.has(name)) {
          return scope.get(name) as T;
        }

        const instance = this.resolve<T>(name);
        scope.set(name, instance);
        return instance;
      },

      dispose: () => {
        scope.clear();
      }
    };
  }
}

// Instância singleton global
export const container = new ServiceContainer();
