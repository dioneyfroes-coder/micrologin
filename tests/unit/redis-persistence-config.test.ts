import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Persistência do Redis (Fase 2.2).
 *
 * A prova de que a revogação sobrevive ao restart exige derrubar o container
 * (`scripts/test-redis-persistence.sh`), e esse drill não roda no CI. Então o
 * portão de CI sobre a configuração é este arquivo: se alguém voltar a pôr
 * `--save "" --appendonly no` no compose de produção, o CI fica vermelho antes
 * do próximo deploy, e não depois de alguém descobrir que tokens revogados
 * voltaram a valer.
 *
 * Os três arquivos comparados têm papéis diferentes e por issodominalidades
 * opostas, que este teste fixa:
 *   - produção: persiste (AOF everysec + RDB + volume);
 *   - drill 2.2: os mesmos flags, byte a byte, senão o drill provaria uma
 *     configuração que ninguém usa;
 *   - resiliência: NÃO persiste, de propósito — aquele teste reinicia o Redis
 *     querendo que nada sobreviva, e um volume ali mudaria o que ele mede.
 *
 * Ler o YAML (em vez de grep no texto) é o que faz a checagem valer: `grep
 * appendonly` passaria com o flag comentado ou em outro serviço, e não
 * distinguiria `--appendonly yes` de `--appendonly no`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type ComposeVolume =
  | string
  | { type: string; source: string; target: string; read_only?: boolean };

type ComposeService = {
  image?: string;
  command?: string | string[];
  volumes?: ComposeVolume[];
  restart?: string;
};

type ComposeFile = {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

const readCompose = (name: string): ComposeFile =>
  load(readFileSync(resolve(ROOT, name), 'utf8')) as ComposeFile;

/**
 * Flags do redis-server de um serviço, como lista de argumentos.
 *
 * O `command` pode ser string (o caso normal) ou lista (compose aceita as
 * duas). Folded YAML (`>-`) já chega aqui como string com os espaços Certain.
 */
const serverFlags = (compose: ComposeFile, service: string): string[] => {
  const command = compose.services[service]?.command;
  if (Array.isArray(command)) {
    return command;
  }
  if (typeof command === 'string') {
    return command.split(/\s+/).filter(Boolean);
  }
  throw new Error(`serviço ${service} não tem command`);
};

/** O valor que segue um flag (`--appendfsync everysec` -> `everysec`). */
const flagValue = (flags: string[], flag: string): string | undefined => {
  const index = flags.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return flags[index + 1];
};

const volumeTargetOf = (volume: ComposeVolume): string => {
  if (typeof volume !== 'string') {
    return volume.target;
  }
  // `fonte:destino[:opções]`, ou só `destino` para volume anônimo.
  const parts = volume.split(':');
  return parts.length >= 2 ? (parts[1] as string) : (parts[0] as string);
};

const volumeTargets = (compose: ComposeFile, service: string): string[] =>
  (compose.services[service]?.volumes ?? []).map(volumeTargetOf);

/** A fonte (volume nomeado ou caminho de bind) do mount em `target`. */
const volumeSources = (compose: ComposeFile, service: string, target: string): string | undefined => {
  for (const volume of compose.services[service]?.volumes ?? []) {
    if (volumeTargetOf(volume) !== target) {
      continue;
    }
    if (typeof volume !== 'string') {
      return volume.source;
    }
    const parts = volume.split(':');
    return parts.length >= 2 ? (parts[0] as string) : undefined;
  }
  return undefined;
};

describe('persistência do Redis em produção (Fase 2.2)', () => {
  const prod = readCompose('docker-compose.prod.yml');
  const flags = serverFlags(prod, 'redis');

  it('liga o AOF com fsync a cada segundo', () => {
    // Sem isto, a última operação de escrita pode não chegar ao disco quando o
    // processo morre: o token revogado nos últimos instantes voltaria a valer.
    expect(flagValue(flags, '--appendonly')).toBe('yes');
    expect(flagValue(flags, '--appendfsync')).toBe('everysec');
  });

  it('mantém snapshot RDB como segunda camada', () => {
    // O AOF é reescrito do zero a cada 60s pelo Redis; um snapshot periódico
    // é a rede de segurança caso o arquivo de AOF se corrompa.
    const save = flagValue(flags, '--save');
    expect(save).toBeDefined();
    expect(save).not.toBe('""');
    expect(save).not.toBe('');
  });

  it('guarda /data em volume nomeado, não na camada do container', () => {
    // Dado em /data sem volume morre com o container: a persistência ligada
    // acima seria inútil. "Nomeado" significa declarado no bloco `volumes:` do
    // compose — um bind de caminho do host seria outra história (o dado
    // sobreviveria ao container, mas não a uma recriação do diretório).
    const source = volumeSources(prod, 'redis', '/data');
    expect(source).toBeDefined();
    expect(prod.volumes?.[source as string]).toBeDefined();
  });

  it('continua autenticando por ACL de arquivo, sem requirepass na linha de comando', () => {
    // `requirepass` no command deixaria a senha visível em `docker inspect` e
    // em `ps`, e ligaria a senha no usuário `default`, que não é atribuível a
    // ninguém. A rotação de segredo da 1.4 depende disso continuar assim.
    expect(flagValue(flags, '--aclfile')).toBe('/etc/redis/users.acl');
    expect(flags).not.toContain('--requirepass');
  });
});

describe('o drill da 2.2 mede a mesma configuração que a produção', () => {
  const prod = readCompose('docker-compose.prod.yml');
  const drill = readCompose('docker-compose.redis.yml');

  it('tem a mesma assinatura de persistência do compose de produção', () => {
    // Divergir aqui tornaria o drill inútil: ele passaria provando uma
    // configuração que ninguém roda.
    //
    // A comparação é por `flag=valor`, não por nome de flag: só os nomes
    // passariam para uma troca de valor — `appendfsync everysec` virando
    // `appendfsync no` continuaria com os mesmos nomes e o teste verde, que é
    // exatamente a mudança que desfaz a garantia de RPO.
    const signature = (flags: string[]): string[] => {
      const pairs = ['--appendonly', '--appendfsync'].map(
        (flag) => `${flag}=${flagValue(flags, flag) ?? '(ausente)'}`
      );
      // `--save <segundos> <chaves>`: os dois valores contam, senão um snapshot
      // a cada 10s passaria como equivalente a um a cada 60s.
      const saveIndex = flags.indexOf('--save');
      const savePair = saveIndex === -1
        ? '--save=(ausente)'
        : `--save=${flags[saveIndex + 1] ?? ''} ${flags[saveIndex + 2] ?? ''}`.trim();
      return [...pairs, savePair];
    };

    expect(signature(serverFlags(drill, 'redis'))).toEqual(signature(serverFlags(prod, 'redis')));
    // E a assinatura não pode ser a de "não persiste", senão o teste acima
    // ficaria verde por vacuidade se as duas cópias caíssem juntas.
    expect(signature(serverFlags(prod, 'redis'))).toContain('--appendonly=yes');
  });

  it('também guarda /data em volume nomeado', () => {
    expect(volumeTargets(drill, 'redis')).toContain('/data');
  });
});

describe('o stack de resiliência segue sem persistência, de propósito', () => {
  const resilience = readCompose('docker-compose.resilience.yml');
  const flags = serverFlags(resilience, 'redis');

  it('não persiste, porque aquele teste reinicia o Redis querendo o estado perdido', () => {
    // `scripts/infra-resilience-test.sh` reinicia o Redis de propósito e mede
    // quanto tempo o serviço leva a voltar a atender. Um volume ali devolveria
    // o estado e mudaria o que o teste mede. Isto fixa a diferença de propósito
    // entre os dois stacks, para ninguém "consertar" um harmonizando o outro.
    expect(flagValue(flags, '--appendonly')).toBe('no');
    expect(flagValue(flags, '--save')).toBe('""');
  });

  it('não tem volume de dados', () => {
    expect(volumeTargets(resilience, 'redis')).not.toContain('/data');
  });
});
