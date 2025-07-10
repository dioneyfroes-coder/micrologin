/**
 * Container de Dependências usando Padrão Singleton
 * Seguindo o Dependency Inversion Principle
 */
export class ServiceContainer {
  constructor() {
    if (ServiceContainer.instance) {
      return ServiceContainer.instance;
    }

    this.services = new Map();
    this.singletons = new Map();
    this.resolving = new Set(); // Para detectar dependências circulares
    ServiceContainer.instance = this;
  }

  /**
   * Registra um serviço no container
   */
  register(name, factory, singleton = true) {
    this.services.set(name, {
      factory,
      singleton,
      instance: null
    });
  }

  /**
   * Resolve uma dependência
   */
  resolve(name) {
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
      return service.instance;
    }

    this.resolving.add(name);
    try {
      return service.factory();
    } finally {
      this.resolving.delete(name);
    }
  }

  /**
   * Verifica se um serviço está registrado
   */
  has(name) {
    return this.services.has(name);
  }

  /**
   * Lista todos os serviços registrados
   */
  getRegisteredServices() {
    return Array.from(this.services.keys());
  }

  /**
   * Lista todos os serviços registrados (alias)
   */
  list() {
    return this.getRegisteredServices();
  }

  /**
   * Limpa todas as instâncias singleton
   */
  clear() {
    this.services.forEach(service => {
      service.instance = null;
    });
    this.singletons.clear();
    this.resolving.clear();
  }

  /**
   * Registra múltiplos serviços de uma vez
   */
  registerBatch(services) {
    Object.entries(services).forEach(([name, config]) => {
      this.register(name, config.factory, config.singleton);
    });
  }

  /**
   * Cria uma instância isolada (útil para testes)
   */
  createScope() {
    const scope = new Map();

    return {
      resolve: (name) => {
        if (scope.has(name)) {
          return scope.get(name);
        }

        const instance = this.resolve(name);
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
