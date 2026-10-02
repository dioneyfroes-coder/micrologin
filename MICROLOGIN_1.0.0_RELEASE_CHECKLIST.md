# Micrologin — Checklist de fechamento e lançamento da 1.0.0

**Objetivo:** levar o projeto atual a um estado que possa ser congelado como `v1.0.0` de portfólio, com código, testes, segurança, CI/CD, documentação e processo de release coerentes entre si.

**Data do check:** 2026-10-02  
**Versão no `package.json`:** `1.0.0`  
**Escopo:** correções necessárias para a versão final; novas funcionalidades não são objetivo deste ciclo.

> **Regra:** não marcar este documento como concluído por “parece funcionar”. Cada item obrigatório precisa de código + teste/prova + documentação quando aplicável.

---

## 0. Estado atual

O projeto já possui uma base forte: arquitetura hexagonal, Argon2id, JWT, rotação de refresh token, revogação, Redis, MongoDB, Docker, observabilidade, testes unitários/integrados/E2E, testes de segurança, testes de resiliência, backup/restore, k6 e workflows de CI/CD.

O trabalho restante é principalmente de **confiabilidade e consistência**. O projeto não precisa de outra grande feature para chegar à 1.0.0; precisa fechar os pontos abaixo e provar o comportamento final.

### Decisões já aceitas e que NÃO devem virar novos projetos neste ciclo

- [x] Limite D20 da revogação armazenada em Redis foi formalmente aceito e documentado como limitação da topologia atual.
- [x] Logout foi desenhado como encerramento de **todas as sessões do usuário**, e não como logout de um único dispositivo.
- [x] A infraestrutura de produção pode continuar simples; não é necessário introduzir Kubernetes, KMS, OpenTelemetry ou múltiplos bancos para esta 1.0.0.
- [x] Integrações externas não são requisito para o lançamento do projeto de portfólio.

---

# 1. BLOQUEADORES DE 1.0.0

Estes itens precisam estar concluídos antes da tag final.

---

## 1.1 — Tornar o limite de Argon2 um limite real

**Prioridade:** P0 / crítico  
**Arquivos principais:**

- `src/interfaces/config/appConfig.ts`
- `src/application/middleware/inFlightLimit.ts`
- módulo responsável por `argon2Hash()` / `argon2Verify()`
- testes unitários e de integração de autenticação

### Problema

Existe a configuração:

```ts
MAX_CONCURRENT_LOGINS = 8
```

Ela participa do cálculo de orçamento de memória, mas não representa necessariamente a quantidade máxima de operações Argon2 simultâneas. O `inFlight` é um limite de requisições por processo e não substitui um semáforo específico de Argon2.

### Implementação

[ ] Criar um semáforo/limiter específico para operações Argon2.

[ ] Fazer `hash` e `verify` passarem pelo mesmo mecanismo quando forem operações de autenticação.

[ ] O limite deve ser configurável e validado no bootstrap.

[ ] O cálculo de orçamento de memória deve usar o mesmo limite que a execução realmente impõe.

[ ] Manter o `inFlight` como proteção de HTTP; não substituir uma proteção pela outra.

### Testes obrigatórios

[ ] Disparar dezenas de operações de login em paralelo e medir a concorrência real de Argon2.

[ ] Provar que o máximo simultâneo nunca excede o limite configurado.

[ ] Criar teste de regressão que falhe caso o semáforo seja removido.

### Critério de aceite

```text
concorrência observada de Argon2 <= MAX_CONCURRENT_LOGINS
```

E o valor precisa aparecer de forma verificável nos logs/artefato de teste de carga.

---

## 1.2 — Corrigir a ordem da troca de senha para evitar estado parcialmente aplicado

**Prioridade:** P0 / crítico  
**Arquivo:** `src/domain/index.ts`

### Problema

Hoje a troca de senha salva a nova senha e só depois tenta revogar as sessões.

Isso cria este estado possível:

```text
salvar nova senha      -> sucesso
revogar sessões        -> falha
```

Resultado: a senha mudou, mas os tokens antigos podem continuar válidos.

### Implementação mínima recomendada para a 1.0.0

[ ] Revogar as sessões **antes** de persistir a nova senha.

[ ] Exigir `true`/sucesso explícito de `revokeUserTokens()` antes de salvar a nova senha.

[ ] Se a revogação estiver indisponível, retornar erro de infraestrutura e não alterar a senha.

[ ] Se a revogação funcionar e o `save()` falhar, aceitar o estado de segurança resultante: a senha antiga continua válida, mas as sessões foram encerradas. Registrar esse cenário.

[ ] Não ignorar o retorno booleano de `revokeUserTokens()`.

### Testes obrigatórios

[ ] Revogação falha -> senha não muda.

[ ] Revogação retorna `false` -> senha não muda.

[ ] Revogação funciona + `save()` funciona -> senha muda e sessões são encerradas.

[ ] Revogação funciona + `save()` falha -> nenhuma sessão antiga continua válida.

[ ] Criar mutação de teste que remova a checagem da revogação e confirme que o build/teste reprova.

### Critério de aceite

Nunca existir o estado “senha nova gravada + revogação de sessão falhou silenciosamente”.

---

## 1.3 — Revogar sessões antes de excluir usuário

**Prioridade:** P0 / crítico  
**Arquivo:** `src/domain/index.ts`

### Problema

`deleteUser()` atualmente pode excluir o usuário antes de revogar os tokens. Se a revogação falhar depois da exclusão, tokens antigos podem permanecer válidos até seu vencimento ou continuar sendo aceitos em pontos que não dependem imediatamente do usuário existir.

### Implementação

[ ] Antes da exclusão, chamar `revokeUserTokens(userId)`.

[ ] Só executar o `delete()` do repositório após a revogação ter sido confirmada.

[ ] Se a revogação falhar, não excluir o usuário.

[ ] No fluxo de refresh, confirmar que o usuário ainda existe e está ativo antes de emitir novo par de tokens.

### Testes obrigatórios

[ ] delete + revogação bem-sucedidos -> usuário removido e tokens inválidos.

[ ] revogação indisponível -> usuário permanece.

[ ] usuário removido -> refresh token antigo não produz novos tokens.

[ ] Criar mutação que retire a verificação de existência no refresh; o teste precisa reprovar.

---

## 1.4 — Remover o tratamento especial de `forEach` em `uncaughtException`

**Prioridade:** P0 / crítico  
**Arquivo:** `src/shared/utils/errorHandler.ts`

### Problema

Existe um `return` especial para erros cuja mensagem contém `forEach`. Um `uncaughtException` significa que uma exceção escapou do fluxo normal e o processo pode estar em estado inconsistente. Ignorar seletivamente esse erro é arriscado.

### Implementação

[ ] Remover o `if (err.message.includes('forEach')) return`.

[ ] Ao ocorrer `uncaughtException`, registrar o erro e iniciar graceful shutdown.

[ ] Manter o comportamento de reinício pelo PM2/Docker/orquestrador.

[ ] Manter `unhandledRejection` no mesmo modelo.

[ ] Garantir que o shutdown seja idempotente para não disparar múltiplas rotinas concorrentes.

### Testes

[ ] Forçar `uncaughtException` em ambiente de teste controlado.

[ ] Provar que o processo entra no fluxo de encerramento.

[ ] Provar que erros que contenham a palavra `forEach` não recebem tratamento especial.

---

## 1.5 — Corrigir a escolha de ambiente do deploy no CI/CD

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/ci-cd.yml`

### Problema

O workflow declara um input manual:

```yaml
workflow_dispatch:
  inputs:
    environment:
      options:
        - staging
        - production
```

mas o job de deploy usa uma matrix fixa com os dois ambientes. Portanto, selecionar um ambiente no dispatch não limita o deploy àquele ambiente.

### Implementação

[ ] Usar `inputs.environment` diretamente no job de deploy.

[ ] Remover a matrix de dois ambientes para o dispatch manual, ou condicioná-la explicitamente ao input.

[ ] Manter `environment: staging` e `environment: production` como GitHub Environments separados.

[ ] Impedir por construção que uma execução escolhendo `staging` faça qualquer operação em `production`.

### Prova obrigatória

[ ] Executar manualmente com `environment=staging`.

[ ] Confirmar no log e no servidor que apenas staging foi tocado.

[ ] Confirmar que `environment=production` exige somente os secrets de production.

[ ] Documentar o processo no README.

---

## 1.6 — Corrigir o gate de dependências do `audit-ci`

**Prioridade:** P0 / crítico  
**Arquivos:** `.audit-ci.json`, `.github/workflows/ci-cd.yml`

### Problema

A configuração atual define simultaneamente `low`, `moderate`, `high` e `critical` como `true`. O `audit-ci` documenta que a configuração deve escolher **um único threshold** de severidade. 

### Implementação

[ ] Adicionar `$schema` ao `.audit-ci.json`.

[ ] Escolher um threshold único para a política de 1.0.0.

[ ] Política recomendada para este projeto: bloquear `moderate` ou superior, salvo advisory explicitamente analisado e allowlisted.

[ ] Manter `allowlist` vazia até existir uma justificativa real.

[ ] Se surgir uma exceção futura, registrar advisory, motivo, escopo e validade.

### Testes

[ ] `npx audit-ci --config .audit-ci.json` passa sem warnings de configuração.

[ ] Introduzir, em branch temporária, uma vulnerabilidade de severidade acima do threshold e confirmar que o job reprova.

### Fonte

Verificação da documentação do projeto `audit-ci` em 2026-10-02:  
https://github.com/IBM/audit-ci

---

## 1.7 — Transformar Trivy em gate real

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/ci-cd.yml`

### Problema

O Trivy gera SARIF, mas o passo atual não define `exit-code: '1'`. Portanto, um resultado vulnerável pode ser enviado ao GitHub sem necessariamente reprovar o job.

### Implementação

[ ] Fixar `aquasecurity/trivy-action` em uma versão suportada; em 2026-10-02, a documentação oficial usa `v0.36.0`.

[ ] Definir explicitamente `exit-code: '1'`.

[ ] Definir `severity` conforme a política de release, por exemplo `CRITICAL,HIGH`.

[ ] Definir `ignore-unfixed: true` apenas se essa escolha for documentada.

[ ] Adicionar `permissions.security-events: write` ao job que envia SARIF.

[ ] Fazer o scan do artefato que será efetivamente implantado.

### Melhor fluxo

```text
PR/main
  ↓
build candidate
  ↓
Trivy gate
  ↓
publicação da imagem
  ↓
deploy
```

Evitar, sempre que possível, publicar uma imagem candidata vulnerável antes de sua validação de segurança.

### Fonte

https://github.com/aquasecurity/trivy-action

---

## 1.8 — Atualizar actions obsoletas/arquivadas

**Prioridade:** P0 / crítico para o release pipeline; P1 para o restante  
**Arquivos:** `.github/workflows/ci-cd.yml`, `.github/workflows/release.yml`

### Alterações obrigatórias

[ ] `github/codeql-action/upload-sarif@v2` -> linha suportada `v4`.

[ ] `codecov/codecov-action@v3` -> linha suportada `v5`.

[ ] `aquasecurity/trivy-action@master` -> release fixada, atualmente `v0.36.0` no upstream consultado.

[ ] `8398a7/action-slack@v3` -> migrar para `slackapi/slack-github-action` ou remover a notificação para manter o release independente de Slack.

[ ] `softprops/action-gh-release@v1` -> `v3`.

[ ] Onde segurança da supply chain for prioridade, considerar pin por SHA em actions de terceiros.

### Observação

O repositório `8398a7/action-slack` foi arquivado em 2025-09-13. Não deve entrar numa release final nova sem necessidade. 

### Fontes

- CodeQL: https://github.com/github/codeql-action
- Codecov: https://github.com/codecov/codecov-action
- Trivy: https://github.com/aquasecurity/trivy-action
- Slack: https://github.com/8398a7/action-slack
- Slack Action mantida: https://github.com/slackapi/slack-github-action
- GitHub Release Action: https://github.com/softprops/action-gh-release

---

## 1.9 — Corrigir completamente o workflow de release

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/release.yml`

### Problemas atuais

1. O `workflow_dispatch` recebe uma versão, mas o workflow usa `github.ref_name` como `tag_name`.
2. O passo de Docker apenas imprime mensagens; não faz realmente o tagging da imagem.
3. O release workflow não reproduz todos os gates principais de qualidade e segurança.
4. O workflow ainda usa `softprops/action-gh-release@v1`.

### Estratégia recomendada para a 1.0.0

Tratar a **tag Git como fonte de verdade** e fazer o release somente a partir de uma tag válida:

```text
main verde
  ↓
git tag -a v1.0.0
  ↓
push da tag
  ↓
release workflow
  ↓
testes + typecheck + build + audit + security scan
  ↓
Docker image 1.0.0
  ↓
GitHub Release v1.0.0
```

### Implementação

[ ] Preferir trigger por `push.tags: ['v*.*.*']` como caminho oficial.

[ ] Remover `workflow_dispatch` de versão automática, ou fazer o dispatch operar sobre uma tag previamente criada e validada.

[ ] Validar semantic versioning da tag.

[ ] Verificar que a versão da tag bate com `package.json`.

[ ] Atualizar `softprops/action-gh-release` para `v3`.

[ ] Gerar `CHANGELOG.md` de forma determinística.

[ ] Criar a imagem Docker com tags reais, pelo menos:

```text
:1.0.0
:v1.0.0
:<git-sha>
```

[ ] Definir explicitamente se `latest` será movido; para portfólio, é aceitável movê-lo na release estável.

[ ] Fazer o passo Docker realmente executar `buildx build --push` ou equivalente.

[ ] Publicar o digest final da imagem no resumo do GitHub Actions.

[ ] Remover qualquer `echo "✅ tagged"` que não corresponda a uma operação real.

### Critério de aceite

Uma pessoa que baixar o código e criar `v1.0.0` precisa obter automaticamente:

- release GitHub `v1.0.0`;
- changelog correto;
- imagem Docker com tag `1.0.0`;
- digest da imagem registrado;
- workflow verde.

---

# 2. SEGURANÇA E CONSISTÊNCIA — P1

Itens recomendados para entrar na própria 1.0.0, mas abaixo dos bloqueadores acima.

---

## 2.1 — Garantir `token_type` em todos os modos JWT

**Arquivo:** `src/infrastructure/external-services/jwtTokenService.ts` e signers relacionados.

[ ] Fazer `access` e `refresh` serem semanticamente distintos também em HS256.

[ ] Não depender exclusivamente de segredo diferente para diferenciar os dois tipos.

[ ] Testar tentativa de usar refresh token onde access token é exigido.

[ ] Testar tentativa inversa.

[ ] Manter ES256 obrigatório em produção se essa é a política atual.

[ ] Garantir que testes de segurança principais usem o mesmo modo criptográfico de produção quando possível.

---

## 2.2 — Mitigar enumeração por timing em login/registro

**Arquivos prováveis:** serviço de autenticação + módulo de hash + testes de segurança.

[ ] Para usuário inexistente, executar comparação com hash Argon2id dummy de custo equivalente.

[ ] Fazer o caminho de usuário existente e inexistente ter custo aproximado semelhante.

[ ] Criar teste de regressão que impeça retorno imediato do caso inexistente.

[ ] Medir p50/p95/p99 de ambos os caminhos e registrar a diferença observada.

> Não é necessário prometer “timing idêntico”; o objetivo é reduzir a diferença explorável.

---

## 2.3 — Corrigir Swagger/OpenAPI

**Arquivo:** `src/interfaces/config/swagger.ts`

[ ] Corrigir `apis: ['./src/routes/*.ts']` para o caminho real das rotas.

[ ] Verificar geração real do spec contra os arquivos em `src/application/routes/`.

[ ] Garantir que as schemas referenciadas existam.

[ ] Validar o documento OpenAPI gerado.

[ ] Fazer pelo menos um teste automatizado da presença dos principais endpoints:

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
GET  /auth/profile
PUT  /auth/password
DELETE /auth/account
```

[ ] Confirmar que `/api-docs` abre sem warnings de referência quebrada.

[ ] Fazer a versão exibida no Swagger derivar da mesma versão do pacote, evitando dois lugares manuais para `1.0.0`.

---

## 2.4 — Revisar `TRUST_PROXY`

**Arquivo:** `src/interfaces/config/appConfig.ts`

[ ] Confirmar valor de produção em `.env.prod.example`.

[ ] Nunca usar `TRUST_PROXY=true` em produção sem proxy confiável explicitamente definido.

[ ] Testar spoofing de `X-Forwarded-For`.

[ ] Confirmar que o rate limiting por IP usa o endereço real somente quando a topologia justifica confiança no proxy.

---

# 3. TESTES QUE DEVEM FECHAR A RELEASE

Executar em ambiente limpo, com Docker disponível e sem depender de artefatos gerados de uma execução anterior.

## 3.1 Gates locais básicos

[ ] `npm ci`

[ ] `npm run lint`

[ ] `npm run typecheck`

[ ] `npm run build`

[ ] `npm audit --audit-level=high`

[ ] `npx audit-ci --config .audit-ci.json`

[ ] `npm run test:secrets`

---

## 3.2 Suíte funcional

[ ] `npm run test:unit`

[ ] `npm run test:integration`

[ ] `npm run test:e2e`

[ ] `npm run test:e2e:down`

[ ] `npm run test:coverage:fast`

### Critério mínimo

Nenhum teste vermelho. Não aceitar “falha conhecida” na suíte que será usada como prova da 1.0.0.

---

## 3.3 Suíte de segurança

[ ] `npm run test:credential-theft:unit`

[ ] `npm run test:credential-theft:real-redis`

[ ] `npm run test:credential-theft`

[ ] Teste de rotação de refresh token.

[ ] Teste de reuso de refresh token.

[ ] Teste de revogação de usuário.

[ ] Teste de troca de senha com sessões antigas.

[ ] Teste de refresh após exclusão do usuário.

[ ] Teste de JWT `token_type`.

---

## 3.4 Suíte de infraestrutura/resiliência

[ ] `npm run test:infra`

[ ] `npm run test:redis`

[ ] `npm run test:redis:volume-loss`

[ ] `npm run test:backup`

[ ] `npm run test:config-backup`

[ ] `npm run test:deploy`

[ ] `npm run test:replica-session`

### D20

O teste `npm run test:redis:volume-loss` deve continuar documentando a limitação aceita, e não ser tratado como “serviço quebrado”. A documentação precisa continuar afirmando corretamente que a revogação armazenada apenas no Redis pode ser perdida com a perda do volume.

---

## 3.5 Carga e capacidade

[ ] `npm run test:ddos`

[ ] `npm run test:capacity`

[ ] `npm run bench:hash`

[ ] `npm run bench:login`

### Registrar no release report

- VUs usados.
- p95/p99.
- RSS máximo.
- quantidade de hashes simultâneos.
- 429 observados.
- 503 por sobrecarga observados.
- 5xx inesperados.
- falhas de liveness/readiness.
- número real de réplicas observadas.
- resultado do controle após revogação.

Não usar uma métrica comparada por caminhos de rede diferentes como “melhoria” sem registrar a diferença de topologia.

---

# 4. CI/CD — DEFINIÇÃO DE PRONTO

## 4.1 Pull Request

[ ] Checkout.

[ ] `npm ci`.

[ ] Secret scanning.

[ ] ESLint.

[ ] TypeScript typecheck.

[ ] `npm audit`.

[ ] `audit-ci`.

[ ] unit tests.

[ ] integration tests.

[ ] E2E.

[ ] coverage upload.

[ ] Docker build de candidato, se fizer parte da política do repositório.

[ ] Trivy scan do candidato, com gate real.

[ ] Nenhuma imagem de PR deve ser publicada permanentemente no registry sem necessidade.

---

## 4.2 Main

[ ] Tudo do PR.

[ ] Build Docker multi-arch.

[ ] Scan de segurança.

[ ] Publicação da imagem.

[ ] Digest registrado.

[ ] Nenhum deploy automático para production sem aprovação/ação explícita.

---

## 4.3 Deploy manual

[ ] `staging` e `production` são mutuamente exclusivos por execução.

[ ] Secrets separados por ambiente.

[ ] Known hosts configurado.

[ ] Não usar `*` como `known_hosts` em produção.

[ ] Pull por digest.

[ ] Backup antes do deploy.

[ ] Readiness após deploy.

[ ] Smoke test.

[ ] Rollback automático quando o smoke/readiness falhar.

[ ] Resumo do commit, ator, versão e digest implantados.

---

# 5. HARDENING DO REPOSITÓRIO

## 5.1 Versões e identidade do projeto

[ ] Decidir se o nome oficial continuará `autentication` ou será corrigido para `micrologin`/`authentication`.

> Para a 1.0.0, não é obrigatório mudar o nome do pacote se isso gerar churn de lockfile e documentação. O importante é documentar a decisão.

[ ] `package.json.version = 1.0.0`.

[ ] README identifica claramente `v1.0.0` como versão estável.

[ ] Swagger usa a mesma versão.

[ ] Docker usa tags da versão.

[ ] Release GitHub usa `v1.0.0`.

---

## 5.2 Dependências

[ ] `npm ci` reproduz exatamente o lockfile.

[ ] `package-lock.json` está commitado.

[ ] Nenhum pacote desnecessário permanece em `dependencies`.

[ ] Dependências de runtime e `devDependencies` estão separadas corretamente.

[ ] Nenhum pacote de produção é usado apenas por testes.

[ ] `npm audit` e `audit-ci` estão verdes.

[ ] Actions do GitHub estão em versões suportadas.

[ ] Dependências não são atualizadas no meio do processo de release; congelar o lockfile antes da tag.

---

## 5.3 Secrets e arquivos sensíveis

[ ] `.env` não está versionado.

[ ] `.env.prod` não está versionado.

[ ] arquivos PEM reais não estão versionados.

[ ] logs de teste não contêm secrets.

[ ] dumps de banco não estão no Git.

[ ] Gitleaks passa.

[ ] exemplos/documentação não contêm credenciais reutilizáveis.

---

# 6. DOCUMENTAÇÃO DA 1.0.0

Antes de criar a tag final, revisar estes arquivos:

[ ] `README.md`

[ ] `docs/ARQUITETURA.md`

[ ] `docs/SEGURANCA.md`

[ ] `docs/REDIS.md`

[ ] `docs/ROTACAO.md`

[ ] `docs/BACKUP.md`

[ ] `docs/CONFIG.md`

[ ] `docs/metricas.md`

[ ] `MICROLOGIN_ANALISE_E_ROADMAP.md`

### O README deve deixar claro

[ ] O que o serviço faz.

[ ] Stack utilizada.

[ ] Como subir localmente.

[ ] Como executar testes.

[ ] Como gerar chaves JWT.

[ ] Como configurar Redis/Mongo.

[ ] Como fazer deploy.

[ ] Como fazer rollback.

[ ] Limitações conhecidas.

[ ] Política de logout: encerra todas as sessões.

[ ] Limite D20 do Redis.

[ ] O que é demonstração de portfólio e o que não é promessa de SaaS de escala ilimitada.

### Depois da 1.0.0

[ ] Mover/renomear roadmap histórico para uma seção de histórico ou manter claramente como documento de auditoria anterior.

[ ] Não deixar no README uma lista de “TODOs” que pareça bloquear a versão estável quando forem apenas melhorias futuras.

---

# 7. RELATÓRIO FINAL DA RELEASE

Criar um arquivo:

```text
RELEASE_1.0.0_REPORT.md
```

Ele deve conter:

## Ambiente

- Node.js.
- npm.
- Docker.
- Docker Compose.
- OS do runner.

## Testes

Tabela com:

| Categoria | Comando | Resultado | Observação |
|---|---|---|---|
| Lint | `npm run lint` | | |
| Typecheck | `npm run typecheck` | | |
| Unit | `npm run test:unit` | | |
| Integration | `npm run test:integration` | | |
| E2E | `npm run test:e2e` | | |
| Credential theft | `npm run test:credential-theft` | | |
| Infra | `npm run test:infra` | | |
| Redis | `npm run test:redis` | | |
| Redis volume-loss | `npm run test:redis:volume-loss` | | |
| Backup | `npm run test:backup` | | |
| Config backup | `npm run test:config-backup` | | |
| Deploy | `npm run test:deploy` | | |
| Replica session | `npm run test:replica-session` | | |
| DDoS | `npm run test:ddos` | | |
| Capacity | `npm run test:capacity` | | |
| Dependency audit | `npm audit --audit-level=high` | | |
| audit-ci | `npx audit-ci --config .audit-ci.json` | | |
| Secrets | `npm run test:secrets` | | |

## Segurança

Registrar:

- algoritmo JWT de produção;
- configuração do Argon2id;
- limite de concorrência do Argon2;
- rate limit;
- in-flight limit;
- TTL dos tokens;
- comportamento de revogação;
- limitação D20;
- status do Trivy;
- status do secret scanning.

## Imagem

Registrar:

```text
registry:
image tag:
image digest:
platforms:
```

## Git

Registrar:

```text
commit:
tag:
release URL:
```

---

# 8. FREEZE DA 1.0.0

Depois que todos os bloqueadores estiverem verdes:

[ ] Fazer `git status` e garantir working tree limpo.

[ ] Confirmar branch `main` atualizada.

[ ] Confirmar que todos os commits importantes foram mergeados.

[ ] Confirmar que CI do último commit da `main` está verde.

[ ] Confirmar que não há issue marcada como blocker da 1.0.0.

[ ] Atualizar `CHANGELOG.md`.

[ ] Atualizar `package.json` para `1.0.0` se ainda não estiver.

[ ] Executar novamente `npm ci`.

[ ] Executar novamente o conjunto de gates local.

[ ] Commit final:

```bash
git add .
git commit -m "chore(release): v1.0.0"
```

[ ] Criar tag anotada:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
```

[ ] Conferir:

```bash
git show --stat --oneline v1.0.0
```

[ ] Enviar:

```bash
git push origin main
git push origin v1.0.0
```

[ ] Não alterar mais o commit apontado pela tag.

---

# 9. PÓS-RELEASE

Após o workflow terminar:

[ ] GitHub Release `v1.0.0` existe.

[ ] Release não está marcada como draft/prerelease por engano.

[ ] Changelog está correto.

[ ] Assets esperados estão presentes.

[ ] Imagem Docker `1.0.0` existe.

[ ] Digest da imagem bate com o registrado no workflow.

[ ] Pull da imagem funciona.

[ ] Container inicia a partir da imagem publicada.

[ ] `/health` responde `healthy`.

[ ] `/readiness` responde `healthy`.

[ ] Smoke funcional passa contra a imagem publicada.

[ ] Rollback continua funcional.

[ ] Documentar o commit/tag efetivamente lançado.

---

# 10. MATRIZ FINAL DE DECISÃO

A versão pode ser chamada de **1.0.0 estável de portfólio** somente quando:

| Área | Condição |
|---|---|
| Código | Sem bloqueadores P0 conhecidos |
| Auth | Login, registro, refresh, logout, troca e exclusão provados |
| Argon2 | Limite real de concorrência comprovado |
| JWT | Access/refresh corretamente separados |
| Revogação | Falhas de infraestrutura tratadas sem sucesso falso |
| Mongo/Redis | Sem sequência que permita estado inseguro silencioso |
| Testes | Suíte crítica 100% verde |
| Segurança | Gitleaks, audit-ci e Trivy funcionando como gates |
| CI | PR/main/release coerentes |
| Deploy | Staging/production não podem se atropelar |
| Docker | Imagem versionada e reproduzível por lockfile |
| Release | Tag, GitHub Release e imagem apontam para a mesma versão |
| Docs | README e documentação condizem com o código atual |
| Limitações | D20 e outras limitações aceitas estão explícitas |

---

# 11. O QUE NÃO FAZER ANTES DA 1.0.0

Não abrir uma nova frente de complexidade sem necessidade.

Evitar neste ciclo:

- Kubernetes.
- múltiplos Redis;
- múltiplos Mongo;
- KMS externo;
- OpenTelemetry completo;
- painel web novo;
- sistema de permissões sofisticado;
- OAuth/social login;
- integração externa de e-mail/SMS;
- microsserviços adicionais;
- refatoração total da arquitetura;
- troca de framework sem necessidade.

Esses itens pertencem a uma eventual `1.1+`, caso exista motivo real.

---

# 12. ORDEM EXATA DE EXECUÇÃO

Use esta sequência para não ficar corrigindo uma coisa e quebrando outra:

```text
1.  Corrigir semáforo real de Argon2
2.  Corrigir troca de senha
3.  Corrigir exclusão + refresh após exclusão
4.  Corrigir uncaughtException
5.  Corrigir workflow de environment
6.  Corrigir audit-ci
7.  Transformar Trivy em gate
8.  Atualizar actions do GitHub
9.  Corrigir release.yml
10. Corrigir token_type em JWT
11. Corrigir Swagger
12. Rodar testes unitários
13. Rodar integração
14. Rodar E2E
15. Rodar segurança
16. Rodar infraestrutura
17. Rodar réplica
18. Rodar DDoS
19. Rodar capacidade
20. Atualizar documentação
21. Criar RELEASE_1.0.0_REPORT.md
22. Fazer CI final da main
23. Congelar código
24. Criar tag v1.0.0
25. Push da tag
26. Conferir GitHub Release
27. Conferir imagem Docker
28. Executar smoke pós-release
```

---

# 13. CHECKLIST DE ENCERRAMENTO

Marque somente depois de todas as etapas acima:

- [ ] Todos os P0 concluídos.
- [ ] Todos os testes críticos verdes.
- [ ] CI verde no último commit da `main`.
- [ ] Release workflow corrigido e validado.
- [ ] Docker release real, não apenas simulado por `echo`.
- [ ] Documentação atualizada.
- [ ] `RELEASE_1.0.0_REPORT.md` criado.
- [ ] `v1.0.0` criado em commit correto.
- [ ] GitHub Release publicada.
- [ ] Imagem Docker versionada publicada.
- [ ] Smoke pós-release verde.
- [ ] Nenhum TODO restante classificado como blocker.

## Estado final

```text
[ ] NÃO PRONTO
[ ] CANDIDATO A RELEASE
[ ] 1.0.0 LANÇADA
```

---

## Referências técnicas atuais consultadas em 2026-10-02

- audit-ci: https://github.com/IBM/audit-ci
- CodeQL Action: https://github.com/github/codeql-action
- Codecov Action: https://github.com/codecov/codecov-action
- Trivy Action: https://github.com/aquasecurity/trivy-action
- action-slack arquivada: https://github.com/8398a7/action-slack
- Slack GitHub Action: https://github.com/slackapi/slack-github-action
- GitHub Release Action: https://github.com/softprops/action-gh-release
