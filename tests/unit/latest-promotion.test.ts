import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `latest` só depois do Trivy
 * ===========================
 *
 * O build publicava a imagem com `type=raw,value=latest` e com a tag do branch,
 * e o scan do Trivy rodava num job seguinte (`security`). A ordem significava
 * que um gate reprovado deixava `latest` já movido: quem puxasse a tag durante
 * o scan receberia a imagem que o gate ia barrar, e a reversão dependeria de
 * alguém perceber.
 *
 * A correção inverte a ordem: o build publica só referências imutáveis (derivadas
 * do SHA) e a tag do PR, e o job `promote` — que depende de `security` — é o
 * único que escreve tag flutuante.
 *
 * Os testes são estruturais, como os demais que leem workflow neste projeto:
 * a unidade que importa é a forma do job, e um parser de YAML não é dependência
 * daqui. Cada bloco é isolado no nome do job, então uma asserção não casa por
 * acidente com outro job do mesmo arquivo.
 */

const WORKFLOW = readFileSync(resolve(process.cwd(), '.github/workflows/ci-cd.yml'), 'utf8');

const jobBlock = (job: string): string => {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex(l => new RegExp(`^  ${job}:`).test(l));
  if (start === -1) {
    throw new Error(`job não encontrado: ${job}`);
  }
  const collected: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z-]+:/.test(lines[i])) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join('\n');
};

const jobCondition = (job: string): string =>
  jobBlock(job).match(/^ {4}if: (.+)$/m)?.[1] ?? '';

/** Jobs que publicam imagem neste workflow, além do promote. */
const PUBLISHING_JOBS = ['build', 'security', 'deploy'];

describe('CI/CD — o build publica só referências imutáveis', () => {
  it('o metadata não gera `latest` nem tag de branch', () => {
    // Regressão direta: `type=raw,value=latest` e `type=ref,event=branch` no
    // build eram as duas tags flutuantes nascendo antes do gate.
    const build = jobBlock('build');

    expect(build).not.toContain('value=latest');
    expect(build).not.toContain('type=ref,event=branch');
  });

  it('as tags do build são derivadas de SHA, e a de PR para o scan local', () => {
    const build = jobBlock('build');

    expect(build).toContain('type=sha');
    // É a tag que o scan de PR usa, sobre a imagem carregada com `load: true`.
    expect(build).toContain('type=ref,event=pr');
  });

  it('o build publica manifesto único, para o digest sobreviver à promoção', () => {
    // Com provenance o buildx publica um índice (manifesto + attestation). A
    // promoção etiqueta com `--prefer-index=false`, que espera um manifesto
    // único: com índice, a tag promovida apontaria para outro digest e o
    // `promote` reprovaria a própria verificação de que promoveu o certo.
    expect(jobBlock('build')).toMatch(/provenance: false/);
  });
});

describe('CI/CD — a promoção vem depois do security scan', () => {
  it('existe o job promote, depois de security, e depende dele', () => {
    expect(WORKFLOW).toMatch(/^ {2}promote:/m);
    expect(jobBlock('promote')).toMatch(/needs: \[build, security\]/);

    // A ordem no arquivo é a ordem de leitura do pipeline: promote vem depois
    // do security e antes do deploy.
    expect(WORKFLOW.indexOf('\n  promote:')).toBeGreaterThan(WORKFLOW.indexOf('\n  security:'));
    expect(WORKFLOW.indexOf('\n  promote:')).toBeLessThan(WORKFLOW.indexOf('\n  deploy:'));
  });

  it('não roda em pull_request, onde não há imagem publicada para promover', () => {
    const condition = jobCondition('promote');

    expect(condition).toContain('github.event_name == \'push\'');
    expect(condition).toContain('github.event_name == \'workflow_dispatch\'');
    expect(condition).not.toContain('pull_request');
  });

  it('`latest` e a tag do branch só são escritos no promote', () => {
    // `ubuntu-latest` do runner também contém ":latest", então a comparação é
    // sobre as referências da imagem (`${IMAGE}:...`), não sobre qualquer
    // ocorrência da palavra.
    for (const job of PUBLISHING_JOBS) {
      const block = jobBlock(job);

      expect(block).not.toContain('value=latest');
      expect(block).not.toMatch(/\$\{IMAGE\}:latest/);
      expect(block).not.toMatch(/\$\{IMAGE\}:\$\{BRANCH\}/);
    }

    const promote = jobBlock('promote');
    expect(promote).toMatch(/\$\{IMAGE\}:latest/);
    expect(promote).toMatch(/\$\{IMAGE\}:\$\{BRANCH\}/);
  });

  it('a promoção aponta para o digest que o scan aprovou', () => {
    // Promover uma referência por tag, e não por digest, reintroduziria o
    // defeito por outro caminho: a tag pode ter sido movida entre build e scan.
    const promote = jobBlock('promote');

    expect(promote).toContain('needs.build.outputs.image-digest');
    expect(promote).toContain('${IMAGE}@${DIGEST}');
  });

  it('`latest` só sai do branch padrão', () => {
    // Um push em branch de trabalho não pode decidir o que `pull :latest`
    // entrega.
    const promote = jobBlock('promote');

    expect(promote).toContain('github.event.repository.default_branch');
  });
});
