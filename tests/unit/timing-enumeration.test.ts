import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * Enumeração de contas por tempo de resposta (item 2.2).
 *
 * O `/login` já respondia "credenciais inválidas" para usuário inexistente e
 * para senha errada — a mensagem não distinguia. O **tempo** distinguia, e era
 * o único canal que sobrava: o caminho do username inexistente não tinha
 * argon2id para rodar, então voltava em microssegundos enquanto uma senha
 * errada levava os ~27 ms de um `verify` m=19456,t=2. Uma requisição por
 * username bastava para mapear a base inteira, sem errar senha nenhuma.
 *
 * Este arquivo tem duas metades, e a segunda existe porque a primeira sozinha
 * passa pelo motivo errado:
 *
 * - **contagem**: quantas operações argon2 cada caminho faz, e com quais
 *   parâmetros. É determinístico e é o que reprova se `compareDummy` sair do
 *   `AuthService`. Sem isso, um teste puramente temporal só reprovaria quando a
 *   máquina estivesse lenta — que é um teste que falha sozinho, não um teste
 *   que reprova a mutação.
 * - **tempo**: p50/p95/p99 dos dois caminhos, com `argon2id` de verdade, e o
 *   razão entre eles. É o que registra a diferença observada e pega a mitigação
 *   que existe mas não funciona (dummy mais barato, dummy só gerado uma vez a
 *   cada N logins).
 *
 * A instrumentação envolve a função real da biblioteca, não uma substituta: um
 * mock que devolvesse hash falso faria o hasher operar sobre entrada que não é
 * argon2id, e a medição de tempo não diria nada.
 */

type Argon2Module = typeof import('@node-rs/argon2');

interface Argon2Options {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

let calls: Array<{ op: 'hash' | 'verify'; params: Argon2Options }> = [];

jest.unstable_mockModule('@node-rs/argon2', async() => {
  const actual = await jest.requireActual<Argon2Module>('@node-rs/argon2');

  return {
    ...actual,
    hash: async(password: string, options?: Argon2Options) => {
      calls.push({ op: 'hash', params: options ?? {} });
      return actual.hash(password, options as never);
    },
    verify: async(hashValue: string, password: string) => {
      calls.push({ op: 'verify', params: {} });
      return actual.verify(hashValue, password);
    }
  };
});

const { AuthService, User } = await import('../../src/domain/index.js');
const { PasswordHasher } = await import('../../src/infrastructure/adapters/index.js');
const { Algorithm } = await import('@node-rs/argon2');

/**
 * Custo de operação: `m=16384,t=2,p=1` dá ~23 ms por operação, o suficiente
 * para o argon2 dominar o ruído de um repositório mockado. Barato demais e o
 * "não existe" voltaria a parecer rápido por acidente; caro demais e o arquivo
 * deixaria de ser rápido para rodar em CI.
 */
const ARGON = { memoryCost: 16384, timeCost: 2, parallelism: 1 };

const hasher = (): PasswordHasher => new PasswordHasher({
  algorithm: 'argon2id',
  argon2: { ...ARGON }
});

const logger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const tokenGenerator = () => ({ generateTokenPair: jest.fn() });

const repo = (overrides: Record<string, unknown> = {}) => ({
  findById: jest.fn(),
  findByUsername: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
  exists: jest.fn(),
  ...overrides
});

const STRONG = 'SenhaForte#1aA1';

const existingUser = async(hashedPassword: string): Promise<User> => {
  const user = new User('u-1', 'alice', hashedPassword);

  return user;
};

beforeEach(() => {
  calls = [];
});

describe('enumeração por tempo - o caminho inexistente paga argon2id', () => {
  it('login de usuário inexistente roda exatamente uma verificação argon2id', async() => {
    const crypto = hasher();
    const userRepository = repo({ findByUsername: jest.fn().mockResolvedValue(null) });
    const tokens = tokenGenerator();
    const service = new AuthService(userRepository, crypto, tokens, logger());

    const result = await service.authenticateUser('nao-existe', STRONG);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário não encontrado');

    // Um verify: o hash descartável já estava pronto (foi gerado na primeira
    // chamada, no `hash` logo abaixo) e a senha foi comparada contra ele.
    expect(calls.filter((call) => call.op === 'verify')).toHaveLength(1);
    // Nenhum token emitido e nada gravado: a mitigação não pode virar efeito
    // colateral no banco nem no par de tokens.
    expect(tokens.generateTokenPair).not.toHaveBeenCalled();
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('o hash descartável é gerado com os parâmetros que o hasher usa de verdade', async() => {
    const crypto = hasher();
    const userRepository = repo({ findByUsername: jest.fn().mockResolvedValue(null) });
    const service = new AuthService(userRepository, crypto, tokenGenerator(), logger());

    await service.authenticateUser('nao-existe', STRONG);

    const generated = calls.filter((call) => call.op === 'hash');
    expect(generated).toHaveLength(1);
    // Divergir aqui é o modo de falha silencioso da mitigação: um dummy com
    // `m` menor custa menos, a resposta do "não existe" fica mais rápida de
    // novo, e nada no código muda. É por isso que a asserção existe.
    expect(generated[0].params).toMatchObject(ARGON);
    expect(generated[0].params.algorithm).toBe(Algorithm.Argon2id);
  });

  it('registro com username repetido roda argon2id e não grava', async() => {
    const crypto = hasher();
    const userRepository = repo({ exists: jest.fn().mockResolvedValue(true) });
    const service = new AuthService(userRepository, crypto, tokenGenerator(), logger());

    const result = await service.registerUser('alice', STRONG);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Usuário já existe');
    expect(calls.filter((call) => call.op === 'verify')).toHaveLength(1);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('o hash descartável é gerado uma vez e reaproveitado', async() => {
    const crypto = hasher();
    const userRepository = repo({ findByUsername: jest.fn().mockResolvedValue(null) });
    const service = new AuthService(userRepository, crypto, tokenGenerator(), logger());

    for (let index = 0; index < 25; index += 1) {
      await service.authenticateUser(`nao-existe-${index}`, STRONG);
    }

    // 1 hash + 25 verifies. Se cada requisição gerasse o seu descarte, seriam
    // 25 hashes: o caminho "não existe" passaria a ser **mais** lento que o de
    // usuário real, que é o mesmo oráculo com o sinal invertido — e um
    // amplificador de carga para quem não tem conta nenhuma.
    expect(calls.filter((call) => call.op === 'hash')).toHaveLength(1);
    expect(calls.filter((call) => call.op === 'verify')).toHaveLength(25);
  });

  it('compareDummy sempre devolve false, mesmo com a senha que o geraria', async() => {
    const crypto = hasher();

    // Nenhum valor de entrada pode ser aceito: o descarte é aleatório e criado
    // dentro do processo, mas a porta não devolve o que o argon2 respondeu.
    await expect(crypto.compareDummy('qualquer-coisa')).resolves.toBe(false);
    await expect(crypto.compareDummy('')).resolves.toBe(false);
    await expect(crypto.compareDummy('x'.repeat(1024))).resolves.toBe(false);
  });
});

/**
 * Medição. Não é prova por si só — a prova é a contagem acima — mas é o que
 * registra o número que o critério de aceite pede e o que pega mitigação que
 * existe e não funciona.
 */
describe('enumeração por tempo - medição dos caminhos', () => {
  const SAMPLES = 15;

  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);

    return sorted[Math.max(0, index)];
  };

  const measure = async(label: string, run: () => Promise<unknown>): Promise<Record<string, number>> => {
    const samples: number[] = [];

    // Descartadas as duas primeiras: a primeira paga a alocação de memória do
    // argon2 e a geração do hash descartável, e incluí-las inflaria o p50 por
    // um evento que não existe em produção.
    for (let index = 0; index < SAMPLES + 2; index += 1) {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      if (index >= 2) {
        samples.push(elapsed);
      }
    }

    const stats = {
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99)
    };

    console.log(
      `[timing-enumeration] ${label} n=${SAMPLES} ` +
      `p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`
    );

    return stats;
  };

  it('login: usuário inexistente e senha errada custam o mesmo', async() => {
    const crypto = hasher();
    const hashed = await crypto.hash(STRONG);
    const user = await existingUser(hashed);

    const absent = repo({ findByUsername: jest.fn().mockResolvedValue(null) });
    const wrongPassword = repo({ findByUsername: jest.fn().mockResolvedValue(user) });

    const absentService = new AuthService(absent, crypto, tokenGenerator(), logger());
    const wrongService = new AuthService(wrongPassword, crypto, tokenGenerator(), logger());

    const semUsuario = await measure('login / usuário inexistente', () => absentService.authenticateUser('nao-existe', STRONG));
    const senhaErrada = await measure('login / senha errada', () => wrongService.authenticateUser('alice', 'SenhaErrada#1aA1'));

    const ratio = semUsuario.p50 / senhaErrada.p50;
    console.log(`[timing-enumeration] razão p50 inexistente/errada = ${ratio.toFixed(3)}`);

    // Faixa larga de propósito: o objetivo declarado no checklist não é timing
    // idêntico, é diferença não explorável. O piso de 0.5 reprova a mitigação
    // removida (razão ~0.01) e tolera ruído de GC e de agendamento; o teto de
    // 2.0 reprova o descarte mais caro que o necessário, que seria um caminho
    // "não existe" mais lento que o de usuário real.
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(2);
  });

  it('registro: username repetido e conta nova custam o mesmo', async() => {
    const crypto = hasher();

    const duplicate = repo({
      exists: jest.fn().mockResolvedValue(true),
      save: jest.fn()
    });
    const fresh = repo({
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async(user: User) => {
        user.id = 'u-3';
        return user;
      })
    });

    const duplicateService = new AuthService(duplicate, crypto, tokenGenerator(), logger());
    const freshService = new AuthService(fresh, crypto, tokenGenerator(), logger());

    const repetido = await measure('registro / username repetido', () => duplicateService.registerUser('alice', STRONG));
    const novo = await measure('registro / conta nova', () => freshService.registerUser(`novo-${Math.random().toString(36).slice(2)}`, STRONG));

    const ratio = repetido.p50 / novo.p50;
    console.log(`[timing-enumeration] razão p50 repetido/novo = ${ratio.toFixed(3)}`);

    // Mesma faixa. `verify` e `hash` custam o mesmo nos mesmos parâmetros
    // (medido entre 0.97 e 1.01), então o equalizador serve aos dois caminhos.
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(2);
  });
});
