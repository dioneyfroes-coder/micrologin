import type { NextFunction, Request, Response } from 'express';
import { serverConfig } from '../../interfaces/config/appConfig.js';
import { HttpError } from '../../shared/utils/errorHandler.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Disjuntor de requisições em andamento.
 *
 * O rate limit (`advancedRateLimit`) segura quem insiste; isto segura quem
 * chega de uma vez. São defesas complementares: um cliente pode estar muito
 * dentro do orçamento de 15 minutos e ainda assim ter 500 requisições abertas
 * ao mesmo tempo, e é o simultâneo que consome memória.
 *
 * Por que isso importa mais aqui do que em um serviço comum: o caminho de
 * autenticação carrega argon2id de 19 MiB por operação. A memória do serviço
 * sob autenticação é dominada pelo número de hashes **concorrentes**, não pelo
 * número total — o que torna "requisições em andamento" a unidade de controle
 * certa para memória.
 *
 * Estado por processo, e essa é a escolha deliberada: o contador precisa
 * proteger a memória DESTE processo, e memória não é compartilhada entre
 * workers. Com 2 workers são 2 × o limite, cada um defendendo o seu próprio
 * RSS — que é exatamente a conta que importa para não estourar o container.
 */
class InFlightLimiter {
  private current = 0;
  private highWaterMark = 0;
  private rejected = 0;
  private accepted = 0;

  constructor(private readonly limit: number) {}

  /**
   * @returns true se a requisição foi admitida
   */
  tryAcquire(): boolean {
    if (this.limit <= 0) {
      this.accepted++;
      return true;
    }

    if (this.current >= this.limit) {
      this.rejected++;
      return false;
    }

    this.current++;
    this.accepted++;
    if (this.current > this.highWaterMark) {
      this.highWaterMark = this.current;
    }
    return true;
  }

  release(): void {
    if (this.current > 0) {
      this.current--;
    }
  }

  getSnapshot() {
    return {
      current: this.current,
      limit: this.limit,
      high_water_mark: this.highWaterMark,
      accepted: this.accepted,
      rejected: this.rejected
    };
  }
}

const limiter = new InFlightLimiter(serverConfig.inFlight.max);

/**
 * Caminhos que nunca entram na contagem.
 *
 * `/health` e `/readiness` são o sinal que o orquestrador lê para decidir se o
 * container está vivo. Se o limite os recusasse, a sobrecarga viraria
 * reinício — e o serviço voltaria do mesmo jeito, gastando o mesmo recurso.
 * Um disjuntor de sobrecarga que derruba o alvo que ele existe para proteger
 * seria pior que não existir. `/observability` entra pelo mesmo motivo: é por
 * ele que se enxerga a sobrecarga que o limite acabou de registrar.
 */
const isBypassed = (req: Request): boolean => {
  const path = req.path || req.url.split('?')[0];
  return serverConfig.inFlight.bypassPaths.includes(path);
};

/**
 * @returns Medidas do limitador, para `/observability`
 */
export const inFlightSnapshot = (): ReturnType<InFlightLimiter['getSnapshot']> =>
  limiter.getSnapshot();

/**
 * Middleware que limita requisições em andamento por processo.
 *
 * Resposta de recusa: 503 e não 429. 429 é "tente mais tarde por janela" e o
 * cliente já conhece esse código do rate limit; 503 com `Retry-After` é
 * "agora eu não consigo", e é o que o balanceador e o orquestrador sabem
 * reagir: tirar da rotação em vez de insistir.
 */
export const inFlightLimit = (req: Request, res: Response, next: NextFunction) => {
  if (isBypassed(req)) {
    return next();
  }

  if (!limiter.tryAcquire()) {
    const snapshot = limiter.getSnapshot();

    // Log de aviso, e não de erro: é o disjuntor funcionando, não uma falha.
    // O `current === limit` dá a informação que importa — quantas estão de
    // fato em andamento quando ele began a recusar.
    logger.warn('⚠️ Sobrecarga: requisições em andamento no teto por processo', {
      limit: snapshot.limit,
      in_flight: snapshot.current,
      rejected_total: snapshot.rejected,
      path: req.path
    });

    res.setHeader('Retry-After', '1');
    return next(new HttpError(
      503,
      'OVERLOADED',
      'Serviço sobrecarregado: requisições em andamento no teto. Tente novamente em instantes.'
    ));
  }

  // `close` e `finish` cobrem os dois desfechos; sem os dois, uma conexão
  // abortada pelo cliente deixaria o contador preso em um phantom e o limite
  // passaria a recusar tráfego que não existe.
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      limiter.release();
    }
  };

  res.on('close', release);
  res.on('finish', release);

  return next();
};
