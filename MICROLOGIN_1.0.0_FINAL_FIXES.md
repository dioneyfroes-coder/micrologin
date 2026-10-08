# Micrologin — Correções finais para a 1.0.0

## Objetivo

Fechar o projeto como **portfólio**, sem adicionar novas funcionalidades.  
A meta é corrigir apenas o que ainda pode comprometer qualidade, segurança ou acabamento da release.

---

# Prioridade P1 — Corrigir antes da 1.0.0

## 1. Corrigir o fluxo de `latest` no CI/CD

### Problema

O `ci-cd.yml` ainda pode publicar `latest` antes do Trivy terminar.

Fluxo atual:

```text
build
→ push latest
→ Trivy
```

Se o Trivy reprovar, `latest` já foi atualizado.

### Correção

Arquivo:

```text
.github/workflows/ci-cd.yml
```

Fazer o fluxo ficar:

```text
build
→ imagem candidata / SHA
→ Trivy
→ promoção das tags
→ latest
```

### Regra

`latest` só pode apontar para uma imagem que passou pelo security gate.

### Validar

- [ ] PR continua sem publicar imagem.
- [ ] `main` faz build e scan.
- [ ] `latest` só é atualizado depois do scan.
- [ ] Imagem reprovada não vira `latest`.

---

# Prioridade P2 — Acabamento recomendado

## 2. Remover ou reorganizar `.env-setup.tmp.mjs`

Arquivo:

```text
.env-setup.tmp.mjs
```

Esse nome parece temporário.

### Escolha

Remover se não for necessário:

```bash
git rm .env-setup.tmp.mjs
```

ou mover para algo permanente, por exemplo:

```text
scripts/setup-local-env.mjs
```

### Validar

- [ ] Não existem arquivos temporários esquecidos na raiz.
- [ ] README usa o caminho correto, caso o script permaneça.

---

## 3. Impedir `SESSION_FAIL_OPEN=true` em produção

### Situação

O projeto já usa `fail-closed` como padrão de produção, mas ainda permite configurar explicitamente:

```text
SESSION_FAIL_OPEN=true
```

em produção.

### Correção recomendada

No carregamento/validação da configuração:

```text
NODE_ENV=production
+
SESSION_FAIL_OPEN=true
→ erro de startup
```

### Regra

```text
produção → fail-closed obrigatório
desenvolvimento/teste → fail-open pode existir
```

### Validar

- [ ] Produção com `SESSION_FAIL_OPEN=true` não inicia.
- [ ] Testes podem usar fail-open quando necessário.
- [ ] Documentação reflete essa regra.

---

## 4. Limpar comentários redundantes

Não é necessário reescrever o projeto.

Remover apenas comentários que:

- repetem literalmente o código;
- explicam operações óbvias;
- preservam histórico de bugs já resolvidos.

Manter comentários que expliquem:

- decisões arquiteturais;
- trade-offs;
- segurança;
- limitações;
- motivos de uma implementação incomum.

### Regra

```text
código       → como
teste        → comportamento
documentação → por quê
```

### Validar

- [ ] Comentários importantes continuam.
- [ ] Arquivos principais ficaram mais objetivos.
- [ ] Nenhuma lógica foi alterada nessa limpeza.

---

## 5. Ajustar o texto do README

Evitar afirmações absolutas ou comparativas sem necessidade.

Trocar linguagem como:

```text
"faz de um jeito que a maioria não faz"
```

por linguagem factual:

```text
"principais decisões técnicas"
```

Destacar:

- Argon2id;
- rotação de refresh token;
- invalidação de sessões;
- controle de concorrência;
- testes de segurança;
- Docker;
- CI/CD;
- limitações conhecidas.

### Validar

- [ ] README descreve o que o projeto realmente faz.
- [ ] Não promete segurança absoluta.
- [ ] Limitações importantes estão explícitas.

---

# Prioridade P3 — Opcional

## 6. Revisar licença

Avaliar se a licença atual faz sentido para o objetivo do portfólio.

Opções comuns:

```text
MIT
```

ou manter a licença proprietária atual.

Não é uma correção técnica obrigatória.

---

## 7. Remover identificadores internos desnecessários

Revisar IDs/documentos internos como:

```text
ML-7F29
ML-7F2A
ML-A31C
```

Manter somente se realmente ajudarem em rastreabilidade/documentação.

Não afeta funcionamento.

---

# Validação final

Depois das correções:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Depois validar Docker:

```bash
docker compose build
docker compose up -d
docker compose ps
```

Testar:

```text
/health
/readiness
login
refresh
logout
revogação
troca de senha
exclusão de usuário
```

### Resultado da validação (08/10/2026)

```text
npm run typecheck   ✓  tsc --noEmit sem erros
npm run lint        ✓  eslint src/ tests/ sem apontamentos
npm test            ✓  77 suites / 1045 testes
npm run build       ✓  tsc emite dist/ limpo
```

- `npm ci` não rodou: `package.json` e `package-lock.json` não mudaram, então a
  instalação limpa não diria nada novo.
- Docker não está instalado nesta máquina, então `docker compose build/up/ps`
  ficou de fora. Em compensação os dois workflows foram validados como YAML
  (`js-yaml`) e pelos testes estruturais de workflow, que travam a ordem
  `build → security → promote` e o formato das tags.
- Aplicação em execução real (pm2, cluster de 4, HTTPS na :3443) — 24 checks,
  todos verdes: `/health`, `/liveness` e `/readiness` 200 com mongo e redis
  healthy; registro 201 e duplicado 400; login errado 401; login → profile 200
  → refresh → logout; reuso de refresh 401 `REFRESH_TOKEN_REUSED`; troca de
  senha 200 derruba o access antigo (401) e a senha antiga (401) e aceita a
  nova; exclusão 200 e login seguinte 401.
- O rate limit de produção apareceu no caminho: o6º login em 15 minutos veio
  429 (5 pontos/900s, bloqueio 1800s) — contadores limpos no Redis entre os
  blocos de teste.
- Guarda do item 3 testada na prática, não só em unit test: com
  `NODE_ENV=production SESSION_FAIL_OPEN=true` o processo morre no arranque com
  `- SESSION_FAIL_OPEN=true não é permitido em produção...`, antes de ouvir a
  porta; com `SESSION_FAIL_OPEN=false` o mesmo build sobe (controle na :3999).

---

# Validação do CI/CD

## Pull Request

Confirmar:

```text
PR
→ build
→ testes
→ audit-ci
→ Trivy
→ sem push da imagem
```

## Main

Confirmar:

```text
main
→ build (só SHA, sem `main`, sem `latest`)
→ scan
→ promote (tags da branch + latest, se branch padrão)
→ deploy
```

Os três fluxos só se confirmam no próprio GitHub: este push dispara o de `main`,
o próximo PR dispara o de PR, e a tag `v1.0.0` dispara o de release. Localmente o
que dá para travar é a estrutura — e está travada pelos testes de workflow.

## Release

Confirmar:

```text
tag
→ build candidato
→ Trivy
→ promoção
→ 1.0.0
→ v1.0.0
→ latest
→ GitHub Release
```

---

# Checklist final

## Obrigatório

- [x] Corrigir `latest` antes do Trivy no `ci-cd.yml` (build publica só SHA/PR;
      job `promote` grava `main` e `latest` depois do scan).
- [x] Confirmar que PR não publica imagens (`tests/unit/pr-no-publish.test.ts`).
- [x] `audit-ci` funcionando como único gate de dependências.
- [x] Trivy bloqueando vulnerabilidades conforme política.
- [x] Release só promove imagem depois dos scans (release.yml já seguia
      `candidata → Trivy → promote`).
- [x] Testes completos passando — **77 suites / 1045 testes verdes**. As duas
      suítes de infra (`auth-http.e2e`, `credential-theft.real-redis`) rodaram
      apontadas para Mongo/Redis locais, já que esta máquina não tem Docker;
      `docs/OPERACOES.md` §4 documenta as variáveis que fazem isso.

## Recomendado

- [x] Remover/reorganizar `.env-setup.tmp.mjs` (removido: o que ele gravava já
      está no `.env`, e o ACL do Redis virou `scripts/start-local-redis.mjs`).
- [x] Bloquear `SESSION_FAIL_OPEN=true` em produção (`validateConfiguration`
      recusa o arranque; teste e documentação atualizados).
- [x] Limpar comentários redundantes (só narração literal; comentários de
      decisão/trade-off/segurança permanecem).
- [x] Revisar README (linguagem factual, sem promessa de segurança absoluta;
      drill de deploy deixou de ser descrito como CI).

## Opcional

- [x] Revisar licença → **manter a proprietária atual** (decisão registrada).
- [x] Limpar identificadores internos → **manter ML-7F29/ML-7F2A/ML-A31C**
      (decisão registrada; ajudam na rastreabilidade).

---

# Critério de encerramento

Quando os itens obrigatórios e recomendados estiverem concluídos:

```text
não adicionar novas features
        ↓
rodar validação final
        ↓
corrigir somente regressões
        ↓
congelar código
        ↓
tag v1.0.0
```

## Decisão

Para um projeto de **portfólio**, não é necessário implementar agora:

- MFA;
- OAuth/OpenID Connect;
- Kubernetes;
- Kafka/RabbitMQ;
- Redis HA;
- MongoDB HA;
- OpenTelemetry;
- arquitetura distribuída adicional.

Esses itens podem existir como ideias futuras, mas não devem impedir a `1.0.0`.
