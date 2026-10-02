/**
 * Semáforo de operações argon2id.
 *
 * O limite de requisições em andamento (`inFlightLimit`) e este são defesas
 * diferentes, e nenhum substitui o outro:
 *
 * - `inFlight` conta requisições HTTP abertas, o que protege o servidor de uma
 *   rajada de tráfego qualquer (`/profile`, `/observability`, ...);
 * - este conta operações argon2id **simultâneas**, que é a unidade que consome
 *   memória de verdade: ~19-64 MiB por hash, alocados fora do heap do JS, e
 *   liberados só quando a operação termina.
 *
 * A distinção importa porque uma requisição em andamento não é necessariamente
 * um hash em andamento. `/profile` ocupa uma vaga do `inFlight` e zero deste
 * semáforo; um burst de 200 logins pode passar inteiramente pelo `inFlight` de
 * 1024 e ser 200 hashes concorrentes se nada os serializar. Era exatamente o
 * que acontecia: `MAX_CONCURRENT_LOGINS` era uma constante usada só na conta de
 * memória do arranque, e nenhum código a impunha em tempo de execução. O
 * orçamento dizia "8" e a máquina fazia 200.
 *
 * A política aqui é **fila, não recusa**: um hashargon2 é trabalho legítimo de um
 * usuário legítimo, e recusá-lo porque chegou atrás de outros oito só troca
 * memória por erro. A fila tem profundidade limitada, e só aí (fila cheia) a
 * operação é recusada — porque fila sem fundo é uma forma de transformar
 * sobrecarga em atraso silencioso.
 *
 * 503 e não 429, pelo mesmo motivo do `inFlight`: "agora eu não consigo" é o que
 * o balanceador sabe reagir.
 */

/**
 * Limite padrão de operações argon2id simultâneas por processo.
 *
 * Oito é a concorrência que o serviço já entregava sem fila perceptível
 * (medido em `docs/metricas.md`) e, com `m=64MiB`, 8 hashes consomem 512 MiB dos
 * 768 MiB do orçamento de memória do container.
 */
export const DEFAULT_ARGON2_CONCURRENCY = 8;

/**
 * Profundidade padrão da fila de espera.
 *
 * Holmgren a taxa de chegada faz a fila crescer, e fila sem fundo converte
 * sobrecarga em latência que ninguém consegue explicar depois. 64 pendências é
 * folga para rajada curta sem virar armazenamento de requisições.
 */
export const DEFAULT_ARGON2_QUEUE = 64;

/**
 * Código do erro de saturação. Distingue "não deu conta agora" de "senha
 * errada", e é o que permite à fronteira HTTP responder 503 em vez de 401.
 */
export const ARGON2_OVERLOADED_CODE = 'ARGON2_OVERLOADED';

export class Argon2OverloadedError extends Error {
  constructor(readonly limit: number, readonly queued: number) {
    super('Operações de hash simultâneas no teto e fila cheia');
    this.name = 'Argon2OverloadedError';
    (this as Error & { code?: string }).code = ARGON2_OVERLOADED_CODE;
  }
}

export interface Argon2LimiterOptions {
  /** Hashes simultâneos. `<= 0` desliga o limite (só para teste). */
  limit?: number;
  /** Operações à espera de uma vaga. */
  maxQueue?: number;
}

export interface Argon2LimiterSnapshot {
  /** Operações argon2 em execução agora. */
  current: number;
  /** Teto de simultaneidade. */
  limit: number;
  /** Maior simultaneidade já observada desde o arranque. */
  high_water_mark: number;
  /** Operações à espera de vaga agora. */
  queued: number;
  /** Maior fila já observada desde o arranque. */
  max_queued_observed: number;
  /** Total de operações admitidas. */
  admitted: number;
  /** Total de operações que esperaram por uma vaga. */
  waited: number;
  /** Total de operações recusadas por fila cheia. */
  rejected: number;
}

/**
 * Semáforo de contagem com fila FIFO.
 *
 * FIFO de propósito: se a fila fosse LIFO, um burst faria as operações mais
 * antigas esperarem enquanto as mais recentes passavam direto — o pior
 * cenário para latência e o mais fácil de não perceber.
 */
export class Argon2Limiter {
  private limit: number;
  private maxQueue: number;
  private current = 0;
  private queued = 0;
  private highWaterMark = 0;
  private maxQueuedObserved = 0;
  private admitted = 0;
  private waited = 0;
  private rejected = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: Argon2LimiterOptions = {}) {
    this.limit = options.limit ?? DEFAULT_ARGON2_CONCURRENCY;
    this.maxQueue = options.maxQueue ?? DEFAULT_ARGON2_QUEUE;
  }

  /**
   * Executa `operation` [^(sob o teto de simultaneidade)].
   *
   * Libera a vaga em `finally`, e não no caminho de sucesso: um hash que
   * rejeita por exceção deixaria a conta presa e o semáforo perceberia um
   * vazamento de memória que não existe.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.limit > 0 && this.current >= this.limit) {
      if (this.queued >= this.maxQueue) {
        this.rejected++;
        throw new Argon2OverloadedError(this.limit, this.queued);
      }

      this.queued++;
      this.waited++;
      if (this.queued > this.maxQueuedObserved) {
        this.maxQueuedObserved = this.queued;
      }

      // A vaga NÃO é contada aqui de novo: `release` a repassa a quem espera
      // sem devolvê-la ao contador (ver `release`). Somar dos dois lados faria o
      // contador crescer uma unidade a cada repasse — e foi exatamente o que a
      // primeira versão fez, chegando a 40 operações "simultâneas" com teto 3.
      await new Promise<void>(resolve => {
        this.waiting.push(resolve);
      });

      this.admitted++;
      return;
    }

    this.current++;
    this.admitted++;
    if (this.current > this.highWaterMark) {
      this.highWaterMark = this.current;
    }
  }

  /**
   * Devolve a vaga ao semáforo.
   *
   * Handoff, não devolução: quando há alguém esperando, a posição muda de dono.
   * Por isso quem sai NÃO decrementa e quem entra NÃO incrementa — se os dois
   * fizessem, cada repasse acrescentaria uma unidade à contagem de operações em
   * andamento, e o limite viraria decorativo depois do primeiro pico.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      this.queued--;
      next();
      return;
    }

    if (this.current > 0) {
      this.current--;
    }
  }

  getSnapshot(): Argon2LimiterSnapshot {
    return {
      current: this.current,
      limit: this.limit,
      high_water_mark: this.highWaterMark,
      queued: this.queued,
      max_queued_observed: this.maxQueuedObserved,
      admitted: this.admitted,
      waited: this.waited,
      rejected: this.rejected
    };
  }

  /**
   * Troca o teto e a profundidade da fila sem recriar o semáforo.
   *
   * Preserva a fila e as vagas em andamento de propósito: recriar o objeto
   * zeraria `current` e o processo voltaria a aceitar mais hashes que o teto
   * permitiria até a fila antiga ser drenada — que é o caminho mais perigoso
   * possível para um limite de memória, porque parece correto na leitura.
   */
  reconfigure(options: Argon2LimiterOptions): void {
    this.limit = options.limit ?? this.limit;
    this.maxQueue = options.maxQueue ?? this.maxQueue;
  }

  /** Zera a contabilidade sem mexer nas operações em andamento. */
  resetMetrics(): void {
    this.highWaterMark = this.current;
    this.maxQueuedObserved = this.queued;
    this.admitted = 0;
    this.waited = 0;
    this.rejected = 0;
  }
}

const limiter = new Argon2Limiter();

/**
 * Aplica o limite configurado. Chamado uma vez pelo bootstrap, depois da
 * validação de configuração.
 *
 * Existe como método (e não como leitura direta da config no módulo) porque o
 * limite validado e o limite aplicado precisam ser a mesma decisão: se o
 * semáforo lesse o ambiente sozinho, ele poderia divergir do número que a
 * validação aprovou.
 */
export const configureArgon2Limiter = (options: Argon2LimiterOptions): void => {
  limiter.reconfigure(options);
};

/**
 * Executa uma operação argon2id sob o teto de simultaneidade.
 *
 * Todo acesso ao argon2id passa por aqui: `hash` e `verify` são o mesmo tipo de
 * trabalho — alocar `memoryCost` KiB e queimar `timeCost` passadas — então
 * limitar um e não o outro não limita nada.
 */
export const runArgon2 = <T>(operation: () => Promise<T>): Promise<T> => limiter.run(operation);

export const argon2Snapshot = (): Argon2LimiterSnapshot => limiter.getSnapshot();

/**
 * Zera a contabilidade do processo, preservando o que está em andamento.
 *
 * Existe para janelas de observação que precisam de uma leitura limpa — um teste
 * de carga que mede a partir do zero, ou um operador comparando duas fases sem
 * reiniciar o processo. Não altera o teto, e não interfere nas vagas abertas.
 */
export const resetArgon2Metrics = (): void => limiter.resetMetrics();
