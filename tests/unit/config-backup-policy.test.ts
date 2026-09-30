import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Backup da configuração em vigor (Fase 2.3).
 *
 * A falha que a fase fecha é: o rollback volta a IMAGEM anterior mas usa o
 * `.env.prod` que está em disco no momento — o da versão nova. O backup precisa
 * capturar a configuração QUE ESTÁ RODANDO (fonte da verdade = o container),
 * não a que o arquivo em disco diz.
 *
 * A prova completa é o drill `scripts/test-config-backup.sh`, que edita o env
 * file sem redeployar e exige que o restore volte o valor EM EXECUÇÃO. Ele não
 * roda no CI (derruba containers). O portão de CI é este arquivo: fixa as
 * invariantes sem as quais o drill provaria uma configuração que ninguém roda:
 *
 *   1. os alvos de mount de segredo do DRILL são exatamente os de PRODUÇÃO
 *      (`/run/secrets` e `/run/secrets/deps`, binds read-only), e as envs
 *      *_PATH apontam para os mesmos caminhos — senão o drill captura um
 *      layout que o deploy não usa;
 *   2. o material de segredo entra por ARQUIVO (env *_PATH), nunca por valor de
 *      ambiente — é o que o backup tem de achar no container, e é o que faz
 *      `docker inspect` não vazar a senha;
 *   3. o backup lê do CONTAINER (fonte da verdade) e registra dono/modo para o
 *      restore reproduzir não só os bytes, mas quem pode lê-los dentro do
 *      container; o restore valida sha e caminho antes de escrever e reaplica o
 *      dono via container descartável;
 *   4. deploy.sh/remote-deploy.sh acoplam a config ao backup da imagem e
 *      restauram ANTES de subir o compose no rollback — fechar o buraco é
 *      ordem, não acidente.
 *
 * Ler YAML e fonte em vez de grep solto: isso impede que um flag comentado ou
 * um valor trocado passe por "estou copiando o prod".
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type ComposeVolume =
  | string
  | { type: string; source: string; target: string; read_only?: boolean };

type ComposeService = {
  command?: string | string[];
  volumes?: ComposeVolume[];
  environment?: Record<string, string>;
};

type ComposeFile = {
  services: Record<string, ComposeService>;
};

const readCompose = (name: string): ComposeFile =>
  load(readFileSync(resolve(ROOT, name), 'utf8')) as ComposeFile;

const volumeTargets = (service: ComposeService): string[] =>
  (service.volumes ?? []).map((volume) =>
    typeof volume === 'string' ? volume.split(':')[1] ?? volume.split(':')[0] : volume.target
  );

/** Alvos `/run/secrets*` de um serviço, ordenados (comparação de conjuntos). */
const secretTargets = (compose: ComposeFile, service: string): string[] =>
  volumeTargets(compose.services[service] as ComposeService)
    .filter((target) => target === '/run/secrets' || target.startsWith('/run/secrets/'))
    .sort();

describe('produção: segredos entram por arquivo, nunca por valor de ambiente (Fase 2.3)', () => {
  const prod = readCompose('docker-compose.prod.yml');
  const app = prod.services['auth-service'] as ComposeService;

  it('o serviço da aplicação chama-se auth-service (default do backup-config)', () => {
    expect(prod.services['auth-service']).toBeDefined();
  });

  it('monta /run/secrets e /run/secrets/deps como binds read-only', () => {
    // O backup descobre o material pelos mounts sob /run/secrets. Se o layout
    // mudar (ex.: KMS, secret do swarm), este teste grita porque o backup e o
    // texto desta fase deixariam de corresponder ao que é montado.
    expect(secretTargets(prod, 'auth-service')).toEqual([
      '/run/secrets',
      '/run/secrets/deps'
    ]);
    for (const volume of (app.volumes ?? []) as NonNullable<ComposeService['volumes']>) {
      const target = typeof volume === 'string' ? '' : volume.target;
      if (target.startsWith('/run/secrets')) {
        const readOnly = typeof volume !== 'string' && volume.read_only;
        expect(readOnly).toBe(true);
      }
    }
  });

  it('as senhas e chaves apontam para arquivos, e não existem como valor de env', () => {
    // A doutrina "secret vira arquivo" (D18, Fase 1.3) é o que permite o backup
    // sencontrou-lo no container sem vazar em `docker inspect`. Os nomes com
    // sufixo _PATH existem; os nomes sem sufixo (o valor cru) NÃO podem existir.
    const env = app.environment ?? {};
    expect(env['JWT_ES256_PRIVATE_KEY_PATH']).toBe('/run/secrets/jwt-es256-private.pem');
    expect(env['MONGODB_PASSWORD_PATH']).toBe('/run/secrets/deps/mongo-app-password');
    expect(env['REDIS_PASSWORD_PATH']).toBe('/run/secrets/deps/redis-password');
    expect(env['JWT_ES256_PRIVATE_KEY']).toBeUndefined();
    expect(env['MONGODB_PASSWORD']).toBeUndefined();
    expect(env['REDIS_PASSWORD']).toBeUndefined();
  });
});

describe('o drill da 2.3 mede o mesmo layout de segredo que a produção', () => {
  const prod = readCompose('docker-compose.prod.yml');
  const drill = readCompose('docker-compose.config-test.yml');

  it('tem os MESMOS alvos de mount de segredo do app de produção', () => {
    // Divergir aqui tornaria o drill inútil: ele passaria provando uma
    // configuração que ninguém monta em produção.
    expect(secretTargets(drill, 'auth-service')).toEqual(secretTargets(prod, 'auth-service'));
  });

  it('usa os MESMOS caminhos *_PATH do app de produção', () => {
    const prodEnv = (prod.services['auth-service'] as ComposeService).environment ?? {};
    const drillEnv = (drill.services['auth-service'] as ComposeService).environment ?? {};
    for (const pathVar of [
      'JWT_ES256_PRIVATE_KEY_PATH',
      'MONGODB_PASSWORD_PATH',
      'REDIS_PASSWORD_PATH'
    ]) {
      expect(drillEnv[pathVar]).toBe(prodEnv[pathVar]);
    }
  });

  it('em nenhum caso o valor cru aparece no environment do drill', () => {
    // Se o drill passasse com valor cru, estaríamos provando que o backup acha
    // a senha em variável de ambiente — a derrota exata da doutrina de arquivo.
    const drillEnv = (drill.services['auth-service'] as ComposeService).environment ?? {};
    expect(drillEnv['JWT_ES256_PRIVATE_KEY']).toBeUndefined();
    expect(drillEnv['MONGODB_PASSWORD']).toBeUndefined();
    expect(drillEnv['REDIS_PASSWORD']).toBeUndefined();
  });
});

describe('backup-config.sh: lê do container e registra dono/modo', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/backup-config.sh'), 'utf8');

  it('o default de projeto/serviço casa com o compose de produção', () => {
    expect(script).toMatch(/^PROJECT="micrologin"/m);
    expect(script).toMatch(/^SERVICE="auth-service"/m);
  });

  it('coleta o material de segredo pelo CONTAINER (docker cp), não pelo host', () => {
    // Em produção os arquivos são 600 do uid 1001/999; o operador que roda o
    // backup pode não ter leitura deles no host. A fonte da verdade é o
    // container em execução — esta é a marca da fase.
    expect(script).toMatch(/docker cp "\$ctr:\$dest/);
    expect(script).not.toMatch(/cp -a -- "\$src/);
  });

  it('registra uid/gid/modo de cada segredo no manifest', () => {
    expect(script).toMatch(/secrets\.owner/);
    expect(script).toMatch(/"uid": int\(uid\)/);
    expect(script).toMatch(/"gid": int\(gid\)/);
    expect(script).toMatch(/"mode"/);
  });

  it('exige passphrase em ARQUIVO (nunca argv) e cifra com AES256', () => {
    expect(script).toMatch(/--passphrase-file/);
    expect(script).toMatch(/--symmetric --cipher-algo AES256 --passphrase-file/);
  });
});

describe('restore-config.sh: valida antes de escrever e reaplica o dono', () => {
  const script = readFileSync(resolve(ROOT, 'scripts/restore-config.sh'), 'utf8');

  it('recusa conteúdo adulterado e caminho fora do alvo', () => {
    expect(script).toMatch(/sha256 diverge/);
    expect(script).toMatch(/fora do alvo/);
    expect(script).toMatch(/fora do diretório de extração/);
  });

  it('reaplica o dono/modo gravados por container descartável, como os geradores', () => {
    // Restaurar os bytes sem restaurar "quem pode ler" devolveria um material
    // que o app (uid 1001) e as dependências (uid 999) não conseguiriam abrir.
    expect(script).toMatch(/OWNER\|/);
    expect(script).toMatch(/chown %s:%s %q/);
    expect(script).toMatch(/docker run --rm -i -u 0 -v "\$TARGET_DIR:\/t:rw"/);
  });

  it('acha o archive por metadata sem segredos (--match-image / --match-tag)', () => {
    expect(script).toMatch(/\.meta\.json/);
    expect(script).toMatch(/--match-image/);
    expect(script).toMatch(/--match-tag/);
  });
});

describe('os deploys acoplam a config à imagem e restauram ANTES de subir', () => {
  const deploy = readFileSync(resolve(ROOT, 'scripts/deploy.sh'), 'utf8');
  const remote = readFileSync(resolve(ROOT, 'scripts/remote-deploy.sh'), 'utf8');

  const orderOk = (text: string, first: string, second: string): boolean => {
    const a = text.indexOf(first);
    const b = text.indexOf(second);
    return a !== -1 && b !== -1 && a < b;
  };

  it('deploy.sh captura a config no backup da versão e a restaura antes do compose up', () => {
    // O tag do archive de config é o MESMO do backup de imagem: o rollback acha
    // os dois com a mesma chave.
    expect(deploy).toContain('backup-config.sh');
    expect(deploy).toMatch(/--env-file "\$ENV_FILE"/);
    expect(deploy).toMatch(/--tag "\$\{backup_tag\}"/);
    // A chamada fica dentro de backup_current_version() — no fluxo de produção o
    // main a executa ANTES de build_and_push (o rollback precisa da versão que
    // está no ar, não da recém-construída).
    const backupFn = deploy.indexOf('backup_current_version()');
    const rollbackFn = deploy.indexOf('rollback()');
    const call = deploy.indexOf('backup-config.sh');
    expect(backupFn).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(backupFn);
    expect(call).toBeLessThan(rollbackFn);
    // A restauração vem ANTES do `up -d` do rollback; senão o rollback subiria
    // imagem antiga com o env da versão nova — o buraco que a fase fecha.
    // (Escopo na função rollback, porque deploy_production() tem um `up -d`
    // idêntico que aparece antes no arquivo.)
    const rollbackBody = deploy.slice(deploy.indexOf('rollback()'), deploy.indexOf('main()'));
    expect(orderOk(rollbackBody, 'restore-config.sh', 'docker compose --env-file ".env.prod" -f docker-compose.prod.yml up -d')).toBe(true);
  });

  it('remote-deploy.sh taggeia a config pelo digest da imagem e exige a passphrase', () => {
    // Config vira "da versão X" (deployed-<digest>); o rollback restaura por
    // essa tag — o recovery path é por versão, não por slot do backup.
    expect(remote).toMatch(/--tag "deployed-\$\{current_digest\}"/);
    expect(remote).toMatch(/--match-tag "deployed-\$\{PREVIOUS_DIGEST\}"/);
    expect(remote).toMatch(/CONFIG_BACKUP_PASSPHRASE_FILE é obrigatória/);
    expect(remote).toMatch(/deployed-\$\{IMAGE_DIGEST\}/);
  });

  it('remote-deploy.sh restaura a config ANTES de subir o compose no rollback', () => {
    expect(orderOk(remote, 'restore-config.sh', 'compose up -d')).toBe(true);
  });

  it('o drill prova a divergência disco×container e o valor EM EXECUÇÃO no fim', () => {
    const drill = readFileSync(resolve(ROOT, 'scripts/test-config-backup.sh'), 'utf8');
    expect(drill).toContain('VERSION_V2');
    expect(drill).toContain('running_kid');
    expect(drill).toMatch(/\/observability/);
    expect(drill).toMatch(/VERSION=\$\{VERSION_V1\}/);
    expect(drill).toMatch(/--match-image/);
  });
});
