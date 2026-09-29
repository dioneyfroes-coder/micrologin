/**
 * ADAPTERS - Implementações concretas dos PORTS
 *
 * Estes adapters conectam o CORE da aplicação com o mundo exterior.
 * Podem ser facilmente trocados, configurados ou removidos.
 */

import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHmac } from 'node:crypto';
import type { CryptoService, Logger, UserRepository } from '../../domain/index.js';
import { User } from '../../domain/index.js';
import { normalizeUsername } from '../../shared/utils/usernamePolicy.js';
import { getUserModel } from '../database/models/User.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * ADAPTER: MongoDB User Repository
 * Implementa o UserRepositoryPort
 */
export class MongoUserAdapter implements UserRepository {
  private UserModel: ReturnType<typeof getUserModel>;

  constructor() {
    this.UserModel = getUserModel();
  }

  async findById(id: string): Promise<User | null> {
    try {
      // O histórico de senhas tem select:false no schema; aqui ele é necessário
      // para a troca de senha (checagem de reuso).
      const userData = await this.UserModel.findById(id).select('+passwordHistory');
      if (!userData) {
        return null;
      }

      return this.toDomain(userData);
    } catch (error) {
      throw new Error(`Erro ao buscar usuário por ID: ${(error as Error).message}`);
    }
  }

  async findByUsername(username: string): Promise<User | null> {
    try {
      // Consulta sempre pela forma canônica (minúsculas), igual ao que o
      // schema grava (lowercase: true). Sem isso, `Alice` não encontraria `alice`.
      // O login não precisa do histórico de senhas: não é carregado aqui.
      const userData = await this.UserModel.findOne({ user: normalizeUsername(username) });
      if (!userData) {
        return null;
      }

      return this.toDomain(userData);
    } catch (error) {
      throw new Error(`Erro ao buscar usuário por username: ${(error as Error).message}`);
    }
  }

  /**
   * Mapeia documento do Mongo para a entidade de domínio.
   */
  private toDomain(userData: {
    _id: { toString(): string };
    user: string;
    password: string;
    passwordHistory?: string[];
    passwordChangedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    return new User(
      userData._id.toString(),
      userData.user,
      userData.password,
      userData.createdAt,
      userData.updatedAt,
      userData.passwordHistory ?? [],
      userData.passwordChangedAt ?? userData.createdAt
    );
  }

  async save(user: User): Promise<User> {
    try {
      if (user.id) {
        // Update
        const userData = await this.UserModel.findByIdAndUpdate(
          user.id,
          {
            user: user.username,
            password: user.hashedPassword,
            passwordHistory: user.passwordHistory,
            passwordChangedAt: user.passwordChangedAt,
            updatedAt: user.updatedAt
          },
          { new: true }
        ).select('+passwordHistory');

        if (!userData) {
          throw new Error('Usuário não encontrado para atualização');
        }

        return this.toDomain(userData);
      } else {
        // Create
        const userData = await this.UserModel.create({
          user: user.username,
          password: user.hashedPassword,
          passwordHistory: [],
          passwordChangedAt: new Date(),
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        });

        return this.toDomain(userData);
      }
    } catch (error) {
      throw new Error(`Erro ao salvar usuário: ${(error as Error).message}`);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.UserModel.findByIdAndDelete(id);
    } catch (error) {
      throw new Error(`Erro ao deletar usuário: ${(error as Error).message}`);
    }
  }

  async exists(username: string): Promise<boolean> {
    try {
      const count = await this.UserModel.countDocuments({ user: normalizeUsername(username) });
      return count > 0;
    } catch (error) {
      throw new Error(`Erro ao verificar existência do usuário: ${(error as Error).message}`);
    }
  }
}

/**
 * ADAPTER: Console Logger
 * Implementa o LoggerPort
 */
export class ConsoleLoggerAdapter implements Logger {
  info(message: string, meta: Record<string, unknown> = {}): void {
    logger.info(message, meta);
  }

  error(message: string, error: unknown = null): void {
    logger.error(message, error);
  }

  warn(message: string, meta: Record<string, unknown> = {}): void {
    logger.warn(message, meta);
  }
}

/**
 * Algoritmo de hash de senha em vigor.
 *
 * `argon2id`, memory-hard e recomendado pela OWASP (D16). O bcrypt saiu do
 * projeto e não há mais caminho de migração a sustentar: `compare` só entende
 * argon2id, então qualquer outro valor gravado é tratado como credencial ilegível.
 */
export type PasswordHashAlgorithm = 'argon2id';

/** Pepper em vigor, com a versão que fica gravada dentro do hash. */
export interface PepperConfig {
  /**
   * Identificador gravado no hash (`p1$argon2id$...`). Precisa existir porque
   * não há como distinguir "hash sem pepper" de "hash de outra versão do
   * pepper" olhando só o valor: sem versão, ativar ou rotacionar o pepper
   * bloquearia todos os usuários. Ver `D17`.
   */
  version: string;
  secret: string;
}

export interface PasswordHasherOptions {
  /** Algoritmo usado para gravar hash novo. Verificar é sempre automático. */
  algorithm: PasswordHashAlgorithm;
  argon2: {
    /** Memória em KiB. 19456 = 19 MiB (mínimo da OWASP). */
    memoryCost: number;
    /** Passadas sobre a memória. */
    timeCost: number;
    /** Threads por hash. `1` em servidor: p>1 entrega CPU ao atacante. */
    parallelism: number;
  };
  /**
   * Segredo externo aplicado antes do hash (HMAC-SHA256). Ausente = sem pepper.
   *
   * O pepper só protege se o hash *e* o pepper não saírem juntos: por isso ele
   * vem de variável de ambiente/secret, nunca do banco. É defesa em profun-
   * didade, não substitui senha forte.
   */
  pepper?: PepperConfig;
  /**
   * Pepper anterior, só para verificar hashes já gravados com ele. Permite
   * trocar o pepper sem derrubar quem ainda não voltou a fazer login; cada
   * login bem-sucedido reescreve o hash com o pepper atual (rotaçãoLazy).
   */
  previousPepper?: PepperConfig;
}

/** Prefixo que o argon2id grava (`$argon2id$v=19$...`). */
const ARGON2ID_PREFIX = '$argon2id$';
/**
 * Envelope do pepper: `p1:` antes do hash.
 *
 * O separador é `:` e não `$` porque o hash argon2id começa com `$` e não usa
 * `:` em nenhum campo. Com `$` como separador, o resultado saía
 * `p1$$argon2id$...`.
 */
const PEPPER_ENVELOPE_PATTERN = /^(p\d+):([\s\S]+)$/;

/**
 * ADAPTER: hashing de senha em argon2id
 *
 * O valor gravado é opaco e carrega o próprio contexto:
 *
 * - `argon2id$v=19$m=19456,t=2,p=1$...` — sem pepper;
 * - `p1:$argon2id$v=19$...` — com pepper na versão 1 (envelope).
 *
 * `compare` não recebe o algoritmo: ele lê o hash gravado. O envelope de pepper
 * é o único contexto que precisa ser OPENADO, porque precisa do segredo da
 * versão certa — ver `pepperCandidates`. Sem pepper, o valor é argon2id direto.
 */
export class PasswordHasher implements CryptoService {
  private readonly options: PasswordHasherOptions;

  constructor(options: PasswordHasherOptions) {
    this.options = options;

    // Métodos são entregues já ligados à instância. O histórico de senha é
    // comparado por uma função recebida de fora (`wasPasswordUsedBefore`), e
    // um método solto perde o `this`: o `compare` explodiria dentro do try e o
    // erro seria engolido, o que transformaria a checagem de reuso em
    // "nunca reutilizada".
    this.hash = this.hash.bind(this);
    this.compare = this.compare.bind(this);
    this.needsRehash = this.needsRehash.bind(this);
  }

  async hash(plainText: string): Promise<string> {
    const pepper = this.options.pepper;
    const toHash = pepper ? this.pepper(plainText, pepper.secret) : plainText;

    return this.envelope(
      await argon2Hash(toHash, {
        algorithm: Algorithm.Argon2id,
        memoryCost: this.options.argon2.memoryCost,
        timeCost: this.options.argon2.timeCost,
        parallelism: this.options.argon2.parallelism
      })
    );
  }

  async compare(plainText: string, hash: string): Promise<boolean> {
    const { value, pepperVersion } = this.unwrap(hash);

    if (!this.isArgon2id(value)) {
      // Formato desconhecido não é "senha correta" e também não merece um 500:
      // um hash que ninguém consegue ler é uma credencial que não confere.
      logger.warn('Hash de senha em formato desconhecido; comparação negada', {
        prefix: hash.slice(0, 7),
        length: hash.length
      });
      return false;
    }

    for (const secret of this.pepperCandidates(pepperVersion)) {
      const toCompare = secret === null ? plainText : this.pepper(plainText, secret);

      if (await argon2Verify(value, toCompare)) {
        return true;
      }
    }

    return false;
  }

  /**
   * O hash guardado está atrás do padrão atual?
   *
   * Dois motivos, ambos decididos pelo próprio valor gravado:
   *
   * 1. parâmetros mais fracos que os configurados — subir custo é uma mudança
   *    de política que se aplica sozinha no próximo login de cada usuário;
   * 2. pepper ausente ou de outra versão (ativação ou rotação).
   *
   * Um hash que não seja argon2id também pede rehash, mas nunca chega aqui: um
   * valor ilegível falha a verificação antes, porque o `compare` não tem como
   * confirmar a senha e tratá-lo como login válido seria aceitar qualquer coisa.
   */
  needsRehash(hash: string): boolean {
    const { value, pepperVersion } = this.unwrap(hash);
    const current = this.options.pepper?.version;

    if (current) {
      if (pepperVersion !== current) {
        return true;
      }
    } else if (pepperVersion) {
      // Pepper desligado com hash pepperado: só um rehash sem pepper devolve
      // o usuário ao estado em que o serviço consegue verificar sem segredo.
      return true;
    }

    if (!this.isArgon2id(value)) {
      return true;
    }

    return this.isWeakerArgon2(value);
  }

  /**
   * O hash argon2id foi feito com menos memória ou menos passadas do que os
   * parâmetros em vigor, ou com mais threads do que se quer gastar por hash.
   *
   * Só conta o que é mais fraco ou mais caro: parâmetros melhores que o
   * configurado não são motivo para reescrever a senha a cada login.
   */
  private isWeakerArgon2(value: string): boolean {
    const parsed = this.parseArgon2Params(value);
    if (!parsed) {
      return true;
    }

    const { memoryCost, timeCost, parallelism } = this.options.argon2;

    if (parsed.memoryCost < memoryCost || parsed.timeCost < timeCost) {
      return true;
    }

    return parsed.parallelism > Math.max(1, parallelism);
  }

  private parseArgon2Params(
    value: string
  ): { memoryCost: number; timeCost: number; parallelism: number } | null {
    const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(value);
    if (!match) {
      return null;
    }

    return {
      memoryCost: Number(match[1]),
      timeCost: Number(match[2]),
      parallelism: Number(match[3])
    };
  }

  private isArgon2id(value: string): boolean {
    return value.startsWith(ARGON2ID_PREFIX);
  }

  /**
   * Quais segredos testar, em ordem, para este hash.
   *
   * Com envelope (`p1$...`) o segredo é o daquela versão — um só candidato. Sem
   * envelope, são tentados o pepper atual, o anterior e a senha em claro, nessa
   * ordem: é o que cobre o intervalo entre ativar/rotacionar o pepper e cada
   * usuário voltar a fazer login. `null` significa "sem pepper".
   */
  private pepperCandidates(pepperVersion: string | undefined): (string | null)[] {
    if (pepperVersion) {
      if (this.options.pepper?.version === pepperVersion) {
        return [this.options.pepper.secret];
      }

      if (this.options.previousPepper?.version === pepperVersion) {
        return [this.options.previousPepper.secret];
      }

      // Hash pepperado numa versão cujo segredo não está mais configurado. Não
      // dá para verificar, e dizer "senha incorreta" mandaria o usuário para
      // um reset de senha que não resolve nada. Falhar alto é o honesto.
      throw new Error(
        `Versão de pepper desconhecida (${pepperVersion}): defina PASSWORD_PEPPER_PREVIOUS_VERSION ` +
          'com o segredo anterior para verificar os hashes já gravados'
      );
    }

    const candidates: (string | null)[] = [];
    if (this.options.pepper) {
      candidates.push(this.options.pepper.secret);
    }
    if (this.options.previousPepper) {
      candidates.push(this.options.previousPepper.secret);
    }
    candidates.push(null);

    return candidates;
  }

  /**
   * Abre o envelope do pepper: qual versão foi usada e qual é o hash de verdade.
   */
  private unwrap(hash: string): { value: string; pepperVersion: string | undefined } {
    const match = PEPPER_ENVELOPE_PATTERN.exec(hash);

    if (match) {
      return { value: match[2], pepperVersion: match[1] };
    }

    return { value: hash, pepperVersion: undefined };
  }

  private envelope(hash: string): string {
    const version = this.options.pepper?.version;
    return version ? `${version}:${hash}` : hash;
  }

  private pepper(plainText: string, secret: string): string {
    // Base64 e não hex: o valor volta a entrar no argon2, que aceita bytes, e
    // base64 não ocupa mais espaço que hex com os mesmos 32 bytes.
    return createHmac('sha256', secret).update(plainText, 'utf8').digest('base64');
  }
}

/**
 * FACTORY: Adapter Factory para Injeção de Dependência
 */
export class AdapterFactory {
  static createUserRepository(): UserRepository {
    return new MongoUserAdapter();
  }

  /**
   * Hasher de senha em uso: argon2id com os parâmetros configurados (D16).
   */
  static createCryptoService(options: Partial<PasswordHasherOptions> = {}): CryptoService {
    return new PasswordHasher({
      algorithm: 'argon2id',
      argon2: options.argon2 ?? { memoryCost: 19456, timeCost: 2, parallelism: 1 },
      pepper: options.pepper,
      previousPepper: options.previousPepper
    });
  }

  static createLogger(): ConsoleLoggerAdapter {
    return new ConsoleLoggerAdapter();
  }
}
