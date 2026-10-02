import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * O bug que este arquivo existe para impedir
 * =============================================
 *
 * `deploy` declarava uma matrix fixa com `staging` e `production`, e ao mesmo
 * tempo aceitava um input `environment` que ninguém lia. Escolher `staging` no
 * dispatch rodava a matrix inteira — staging **e** production, este último com
 * os secrets de production e dentro de `environment: production`.
 *
 * A classe do bug é específica: não é um valor errado, é uma **decisão de
 * controle que a interface promete e a execução ignora**. O seletor na tela
 * dizia uma coisa; o que rodava era outra. Nenhum teste de runtime pegaria isso,
 * porque o código estava correto — ele executava exatamente o que a matrix
 * mandava. Só a leitura do workflow revela a divergência entre a intenção
 * declarada e o comportamento.
 *
 * Por isso os testes abaixo são estruturais: leem o YAML e verificam a forma do
 * job. Um teste que subisse a aplicação e fizesse deploy exigiria servidores
 * configurados e não provaria nada que a estrutura não proves.
 *
 * Sem parser de YAML em dependência: o bloco do job é isolado por delimitadores
 * de nível superior (`  deploy:` até o próximo job), que é a unidade que o bug
 * vivia.
 */

const WORKFLOW = resolve(process.cwd(), '.github/workflows/ci-cd.yml');

const rawWorkflow = readFileSync(WORKFLOW, 'utf8');

/** Bloco do job `deploy`, sem o cabeçalho de comentários que o precede. */
const deployJob = (): string => {
  const start = rawWorkflow.indexOf('\n  deploy:\n');
  if (start === -1) {
    throw new Error('Job `deploy` não encontrado no workflow');
  }
  // Próximo job no nível de topo começa com dois espaços e um nome com `:`.
  const rest = rawWorkflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-zA-Z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

const workflowInputs = (): string => {
  const start = rawWorkflow.indexOf('  workflow_dispatch:');
  if (start === -1) {
    throw new Error('workflow_dispatch não encontrado');
  }
  const rest = rawWorkflow.slice(start);
  const end = rest.indexOf('\nenv:');
  return rest.slice(0, end === -1 ? rest.length : end);
};

describe('CI/CD - o input de ambiente decide o deploy', () => {
  it('o input existe, é obrigatório e oferece exatamente staging e production', () => {
    const inputs = workflowInputs();

    expect(inputs).toMatch(/environment:/);
    expect(inputs).toMatch(/required:\s*true/);
    expect(inputs).toMatch(/type:\s*choice/);
    expect(inputs).toMatch(/options:\s*\n\s*-\s*staging\s*\n\s*-\s*production\s*$/m);
  });

  it('o job de deploy não tem matrix: a matrix era o que ignorava o input', () => {
    const job = deployJob();

    // Regressão direta. Com `strategy.matrix`, o input volta a ser decoração e
    // a matrix inteira roda — foi exatamente o que aconteceu.
    expect(job).not.toMatch(/^\s{4}matrix:/m);
    expect(job).not.toMatch(/^\s{6}matrix:/m);
    expect(job).not.toMatch(/secret_prefix/);
  });

  it('name, environment e concurrency leem o input, não a matrix', () => {
    const job = deployJob();

    expect(job).toMatch(/name:\s*🚀 Deploy \(\$\{\{ inputs\.environment \}\}\)/);
    expect(job).toMatch(/environment:\s*\$\{\{ inputs\.environment \}\}/);
    expect(job).toMatch(/group:\s*deploy-\$\{\{ inputs\.environment \}\}/);
    expect(job).not.toMatch(/matrix\./);
  });

  it('todo secret do deploy sai do prefixo derivado do input', () => {
    const job = deployJob();

    // Nenhum nome de secret escrito à mão. Se alguém reintroduzir
    // `secrets.PRODUCTION_DEPLOY_HOST` no meio do job, essa assertion falha —
    // e é essa reintrodução que faria um deploy de staging tocar production.
    expect(job).not.toMatch(/secrets\.(PRODUCTION|STAGING)_/);
    expect(job).not.toMatch(/secrets\[[^\]]*(PRODUCTION|STAGING)/);

    const secretRefs = job.match(/secrets\[/g) ?? [];
    expect(secretRefs.length).toBeGreaterThan(0);

    // E todos passam pelo prefixo resolvido a partir do input.
    const viaEnv = job.match(/secrets\[format\('\{0\}_[A-Z_]+', env\.DEPLOY_SECRET_PREFIX\)\]/g) ?? [];
    expect(viaEnv.length).toBe(secretRefs.length);
  });

  it('o prefixo dos secrets é derivado do input, não de uma lista', () => {
    const job = deployJob();

    expect(job).toMatch(
      /DEPLOY_SECRET_PREFIX:\s*\$\{\{ inputs\.environment == 'production' && 'PRODUCTION' \|\| 'STAGING' \}\}/
    );
  });

  it('há uma barreira que aborta antes de qualquer acesso a servidor', () => {
    const job = deployJob();

    expect(job).toMatch(/name:\s*🚦 Travar o deploy no ambiente escolhido/);

    // A barreira precisa ser um passo anterior a rede/chave/registry, senão ela
    // documenta a intenção em vez de impor.
    const guardAt = job.indexOf('Travar o deploy no ambiente escolhido');
    const sshAt = job.indexOf('ssh -i');
    const registryAt = job.indexOf('docker login');
    expect(guardAt).toBeGreaterThan(-1);
    expect(sshAt).toBeGreaterThan(guardAt);
    expect(registryAt).toBeGreaterThan(guardAt);
  });
});

describe('CI/CD - a barreira segura o ambiente escolhido', () => {
  /**
   * O `run:` da barreira, extraído do workflow e executado como bash de verdade.
   *
   * A primeira versão deste arquivo reescrevia a lógica no teste e rodava a cópia.
   * Isso provava que a *ideia* da barreira funcionava, não que a barreira do
   * workflow aborta: trocar `exit 1` por `::warning::` no workflow deixava os
   * 11 testes verdes, porque o teste nunca olhava o script real. Uma mutação
   * exatamente da protecao que o teste existe para verificar.
   *
   * Extrair e executar o script elimina a duplicação: agora há uma só cópia da
   * lógica, e ela é a que roda em produção.
   */
  const guardScript = (): string => {
    const job = deployJob();
    const stepAt = job.indexOf('      - name: 🚦 Travar o deploy no ambiente escolhido');
    expect(stepAt).toBeGreaterThan(-1);

    const runAt = job.indexOf('        run: |', stepAt);
    expect(runAt).toBeGreaterThan(-1);

    const bodyStart = job.indexOf('\n', runAt) + 1;
    const lines: string[] = [];
    let cursor = bodyStart;
    while (cursor < job.length) {
      const lineEnd = job.indexOf('\n', cursor);
      const line = job.slice(cursor, lineEnd === -1 ? job.length : lineEnd);

      // Bloco escalar de YAML: linhas em branco ou indentadas além do `run:`.
      if (line.trim() !== '' && !/^ {10}/.test(line)) {
        break;
      }
      lines.push(line);
      if (lineEnd === -1) {
        break;
      }
      cursor = lineEnd + 1;
    }

    const script = lines.join('\n').replace(/^ {10}/gm, '');
    expect(script).not.toMatch(/\$\{\{/);
    return script;
  };

  const runGuard = (inputEnvironment: string, resolvedPrefix: string): string => {
    try {
      return execFileSync('bash', ['-c', guardScript()], {
        env: { ...process.env, INPUT_ENVIRONMENT: inputEnvironment, RESOLVED_PREFIX: resolvedPrefix },
        encoding: 'utf8'
      }).trim();
    } catch (error) {
      return `REJECT exit=${(error as { status: number }).status}`;
    }
  };

  it('staging com prefixo STAGING passa', () => {
    expect(runGuard('staging', 'STAGING')).toContain('Deploy travado');
  });

  it('production com prefixo PRODUCTION passa', () => {
    expect(runGuard('production', 'PRODUCTION')).toContain('Deploy travado');
  });

  it('staging com prefixo PRODUCTION é barrado — a matrix reintroduzida', () => {
    // O cenário do bug original. Escolher staging e acabar em production é
    // exatamente o que a barreira existe para impedir.
    expect(runGuard('staging', 'PRODUCTION')).toMatch(/REJECT/);
  });

  it('production com prefixo STAGING é barrado', () => {
    expect(runGuard('production', 'STAGING')).toMatch(/REJECT/);
  });

  it('ambiente vazio ou desconhecido é barrado', () => {
    expect(runGuard('', 'STAGING')).toMatch(/REJECT/);
    expect(runGuard('production ', 'PRODUCTION')).toMatch(/REJECT/);
    expect(runGuard('producción', 'STAGING')).toMatch(/REJECT/);
  });

  it('a barreira aborta de fato, e não só avisa', () => {
    // Fecha a lacuna da mutação que o teste não pegava: um `::warning::` no
    // lugar do `exit 1` deixaria o job seguir para o ssh.
    const script = guardScript();
    const aborts = script.match(/exit 1/g) ?? [];

    // Um `exit 1` por condição verificada: mismatch de prefixo e ambiente
    // inválido.
    expect(aborts.length).toBeGreaterThanOrEqual(2);
    expect(script).not.toMatch(/::warning::[\s\S]*prosseguindo/);
  });

  it('a barreira não é "só aviso": o caminho de rejeição tem código diferente de zero', () => {
    // Prova executável: uma barreira que só avisa devolveria 0 aqui.
    expect(runGuard('staging', 'PRODUCTION')).toMatch(/exit=1/);
    expect(runGuard('production', 'STAGING')).toMatch(/exit=1/);
  });
});
