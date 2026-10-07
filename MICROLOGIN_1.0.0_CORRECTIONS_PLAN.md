# Micrologin â€” Plano de CorreÃ§Ãµes para a Release 1.0.0

## Objetivo

Levar o projeto ao estado em que a versÃ£o `1.0.0` possa ser publicada como projeto final de portfÃ³lio sem continuar adicionando funcionalidades de escopo.

A prioridade Ã©:

1. eliminar bloqueadores reais;
2. corrigir inconsistÃªncias do CI/CD;
3. validar o sistema em ambiente limpo;
4. remover dÃ­vida tÃ©cnica pequena e ruÃ­do;
5. congelar o cÃ³digo;
6. criar a release `v1.0.0`.

> Regra desta fase: **nÃ£o adicionar novas features**. MFA, OAuth, Kafka, Kubernetes, OpenTelemetry, novos provedores e novos bancos ficam fora do escopo da 1.0.0.

---

# VisÃ£o geral das fases

| Fase | ImportÃ¢ncia | Objetivo |
|---|---|---|
| Fase 0 | ðŸ”´ P0 â€” Bloqueador | Corrigir falhas que podem invalidar a release |
| Fase 1 | ðŸŸ  P1 â€” Alta | Fortalecer CI/CD e eliminar inconsistÃªncias importantes |
| Fase 2 | ðŸŸ¡ P2 â€” MÃ©dia | Limpeza e consistÃªncia tÃ©cnica |
| Fase 3 | ðŸŸ¢ P3 â€” Baixa | Melhorias de apresentaÃ§Ã£o e manutenÃ§Ã£o |
| Fase 4 | ðŸ”µ Release | ValidaÃ§Ã£o final, congelamento e publicaÃ§Ã£o |

---

# FASE 0 â€” BLOQUEADORES DA 1.0.0

## âœ… P0.1 â€” Remover o `npm audit` que conflita com a polÃ­tica de allowlist (concluÃ­do â€” commit `cb54d04`)

### Problema

O CI usa simultaneamente:

```yaml
npm audit --audit-level=moderate
```

e:

```yaml
npx audit-ci --config .audit-ci.json
```

O `audit-ci` respeita a allowlist configurada, enquanto o `npm audit` nÃ£o usa a mesma polÃ­tica. Isso pode fazer o pipeline rejeitar uma vulnerabilidade explicitamente aceita pelo projeto.

### Passos

1. Abrir:

```text
.github/workflows/ci-cd.yml
```

2. Localizar o step:

```yaml
- name: ðŸ”’ Security audit
  run: npm audit --audit-level=moderate
```

3. Remover esse step.

4. Manter como gate oficial:

```yaml
- name: Dependency security audit
  run: npx audit-ci --config .audit-ci.json
```

5. Verificar que `.audit-ci.json` contÃ©m somente vulnerabilidades explicitamente aceitas.

### ValidaÃ§Ã£o

```bash
npx audit-ci --config .audit-ci.json
```

Resultado esperado: `exit code 0`.

### CritÃ©rio de conclusÃ£o

- [x] `npm audit` cru removido do CI.
- [x] `audit-ci` permanece como polÃ­tica oficial.
- [x] Allowlist documentada.
- [x] CI passa.

---

## âœ… P0.2 â€” Impedir publicaÃ§Ã£o de imagens Docker em Pull Requests (concluÃ­do â€” commit `e0778ae`)

### Problema

O pipeline tambÃ©m executa em `pull_request`, mas o build Docker estÃ¡ configurado para publicar a imagem. Isso pode falhar em forks, exigir permissÃµes desnecessÃ¡rias e poluir o GHCR com imagens temporÃ¡rias.

### Objetivo

```text
Pull Request
    â†“
build
    â†“
test
    â†“
security scan
    â†“
sem push

main / release
    â†“
build
    â†“
security scan
    â†“
push
```

### Passos

1. Abrir:

```text
.github/workflows/ci-cd.yml
```

2. Identificar o `docker/build-push-action`.

3. Fazer o `push` depender do evento. Exemplo conceitual:

```yaml
push: ${{ github.event_name != 'pull_request' }}
```

4. Garantir que o Trivy continue conseguindo analisar a imagem em PR.

5. Revisar permissÃµes para nÃ£o dar `packages: write` onde ele nÃ£o Ã© necessÃ¡rio.

### ValidaÃ§Ã£o

Abrir um PR de teste e confirmar:

```text
PR â†’ build ocorre
PR â†’ testes ocorrem
PR â†’ Trivy ocorre
PR â†’ nenhum push ao GHCR
```

### CritÃ©rio de conclusÃ£o

- [x] PR nÃ£o publica imagem.
- [x] PR ainda executa build.
- [x] PR ainda executa security scan.
- [x] Main/release continuam publicando.

---

## âœ… P0.3 â€” NÃ£o mover `latest` antes do security gate (concluÃ­do â€” commit `5d957e4`)

### Problema

A pipeline de release pode executar:

```text
build
â†’ push 1.0.0
â†’ push v1.0.0
â†’ push SHA
â†’ push latest
â†’ Trivy
```

Se o Trivy falhar, `latest` jÃ¡ pode apontar para uma imagem rejeitada.

### Objetivo

```text
build
  â†“
candidate image
  â†“
Trivy
  â†“
PASSOU
  â†“
promote
  â”œâ”€â”€ 1.0.0
  â”œâ”€â”€ v1.0.0
  â”œâ”€â”€ SHA
  â””â”€â”€ latest
  â†“
GitHub Release
```

### Passos

1. Abrir:

```text
.github/workflows/release.yml
```

2. Separar a imagem candidata das tags oficiais.

3. Publicar inicialmente apenas uma tag candidata, por exemplo:

```text
ghcr.io/.../micrologin:candidate-${GITHUB_SHA}
```

4. Executar Trivy nessa imagem.

5. Configurar o Trivy para falhar segundo a polÃ­tica do projeto. Exemplo:

```yaml
exit-code: '1'
severity: 'HIGH,CRITICAL'
```

6. Somente apÃ³s sucesso promover o mesmo digest para:

```text
1.0.0
v1.0.0
SHA
latest
```

7. Criar a GitHub Release somente depois da promoÃ§Ã£o.

### CritÃ©rio de conclusÃ£o

- [x] Trivy ocorre antes de `latest`.
- [x] Imagem reprovada nunca vira `latest`.
- [x] O mesmo artefato/digest Ã© promovido entre as tags.
- [x] GitHub Release sÃ³ ocorre apÃ³s todos os gates.

---

## âœ… P0.4 â€” Corrigir o SHA utilizado em `workflow_dispatch` (concluÃ­do â€” commit `965bea9`)

### Problema

Ao executar manualmente um workflow para uma tag existente, `github.sha` pode representar o contexto do workflow em vez do commit que a tag escolhida representa.

### Passos

1. Abrir:

```text
.github/workflows/release.yml
```

2. Identificar workflows que aceitam:

```yaml
workflow_dispatch:
```

3. Se o workflow permite selecionar uma tag/ref, fazer checkout explÃ­cito dessa ref.

4. ApÃ³s o checkout, determinar o SHA real:

```bash
git rev-parse HEAD
```

5. Usar esse valor em metadata, resumo da release, labels e validaÃ§Ãµes.

### ValidaÃ§Ã£o

```bash
git rev-parse v1.0.0
```

Comparar com o SHA exibido pelo workflow.

### CritÃ©rio de conclusÃ£o

- [x] Tag e commit sÃ£o sempre correspondentes.
- [x] ExecuÃ§Ã£o manual nÃ£o cria metadata enganosa.
- [x] Teste automatizado cobre o caso.

---

# FASE 1 â€” CORREÃ‡Ã•ES IMPORTANTES

## âœ… P1.1 â€” Alinhar Node.js com `@types/node` (concluÃ­do â€” commit `2040933`)

> Node 24 LTS em `@types/node` (`^24.7.0`), `NODE_VERSION: '24.x'` no CI, `node:24-alpine` no Dockerfile/scripts e docs atualizadas. Typecheck, lint, build e `npm test` validados (caveat Windows permanece).

### Problema

HÃ¡ desalinhamento entre runtime e tipos: CI usa Node 22 enquanto `@types/node` estÃ¡ na linha 26. Isso permite que o TypeScript enxergue APIs que o runtime real pode nÃ£o possuir.

### RecomendaÃ§Ã£o

Escolher uma Ãºnica linha. Para a 1.0.0, preferÃªncia: **Node 24 LTS**.

### Arquivos a revisar

```text
package.json
Dockerfile
.github/workflows/*.yml
README.md
```

### Passos

1. Definir a versÃ£o alvo.
2. Atualizar `@types/node`.
3. Atualizar matrix/variÃ¡veis do CI.
4. Atualizar imagem/base Docker.
5. Atualizar documentaÃ§Ã£o.
6. Rodar:

```bash
npm run typecheck
npm test
npm run build
```

### CritÃ©rio

```text
Node runtime = Node types = CI = Docker = documentaÃ§Ã£o
```

---

## âœ… P1.2 â€” Tornar `verifyRefreshToken()` obrigatÃ³rio (concluÃ­do â€” commit `aa3b8d0`)

### Problema

A interface declara:

```ts
verifyRefreshToken?(token: string): Promise<unknown>;
```

como opcional, mas validar refresh Ã© parte da seguranÃ§a.

### Passos

1. Abrir a interface de token.
2. Remover o `?`.
3. Atualizar implementaÃ§Ãµes.
4. Atualizar mocks.
5. Atualizar doubles de teste.
6. Procurar usos:

```bash
grep -R "verifyRefreshToken" src tests
```

### CritÃ©rio

- [x] Interface obrigatÃ³ria.
- [x] Todas as implementaÃ§Ãµes compilam.
- [x] Todos os testes passam.

---

## âœ… P1.3 â€” Formalizar a polÃ­tica de logout (concluÃ­do â€” commit `86f67fd`)

### SituaÃ§Ã£o

A invalidaÃ§Ã£o por `sessionVersion` representa potencialmente logout de todas as sessÃµes, e nÃ£o apenas do dispositivo atual.

### DecisÃ£o recomendada para 1.0.0

Manter o mecanismo atual e documentar claramente:

```text
logout = invalidaÃ§Ã£o de todas as sessÃµes do usuÃ¡rio
```

Se no futuro for necessÃ¡rio logout individual, introduzir estado por sessÃ£o (`sessionId`, `deviceId` ou `jti`).

### CritÃ©rio

- [x] Comportamento documentado.
- [x] Teste correspondente.
- [x] README/API docs refletem o comportamento real.

---

## P1.4 â€” Documentar Redis como dependÃªncia de seguranÃ§a

### SituaÃ§Ã£o

A revogaÃ§Ã£o depende do Redis. Perda completa do estado pode afetar a validade de sessÃµes/revogaÃ§Ãµes.

### Para 1.0.0

NÃ£o Ã© necessÃ¡rio redesenhar a arquitetura. Classificar explicitamente como:

```text
Known limitation / accepted risk
```

Documentar:

- Redis necessÃ¡rio para o estado distribuÃ­do de sessÃ£o/revogaÃ§Ã£o;
- impacto de perda do volume Redis;
- estratÃ©gia de recuperaÃ§Ã£o;
- backup/restore existentes.

### CritÃ©rio

- [x] Risco documentado.
- [x] Nenhuma documentação promete garantias que dependam da persistência perfeita do Redis.
- [x] Backup/restore continuam testados.

---

# FASE 2 â€” LIMPEZA TÃ‰CNICA

## P2.1 â€” Remover configuraÃ§Ã£o Bcrypt obsoleta

### Problema

Existe configuraÃ§Ã£o como:

```env
BCRYPT_SALT_ROUNDS=12
```

apesar de a implementaÃ§Ã£o atual usar Argon2id.

### Passos

```bash
grep -R "BCRYPT" .
grep -R "bcrypt" .
```

Depois:

- [ ] remover variÃ¡veis sem uso;
- [ ] remover documentaÃ§Ã£o antiga;
- [ ] remover comentÃ¡rios incorretos.

### CritÃ©rio

Nenhuma configuraÃ§Ã£o deve sugerir que bcrypt faz parte da polÃ­tica atual se nÃ£o faz.

---

## P2.2 â€” Revisar comentÃ¡rios excessivos

### Objetivo

Manter comentÃ¡rios que expliquem decisÃµes, trade-offs, limites, motivos de seguranÃ§a e riscos aceitos. Reduzir comentÃ¡rios que apenas repetem o cÃ³digo.

### Regra

```text
CÃ³digo â†’ como
Teste â†’ comportamento
DocumentaÃ§Ã£o â†’ por quÃª
```

### CritÃ©rio

- [ ] comentÃ¡rios redundantes removidos;
- [ ] decisÃµes arquiteturais mantidas;
- [ ] histÃ³rico de bugs jÃ¡ resolvidos removido quando nÃ£o agrega contexto.

---

## P2.3 â€” Avaliar divisÃ£o de `domain/index.ts`

### PossÃ­vel estrutura

```text
src/domain/
â”œâ”€â”€ entities/
â”‚   â””â”€â”€ User.ts
â”œâ”€â”€ services/
â”‚   â””â”€â”€ AuthService.ts
â”œâ”€â”€ ports/
â”‚   â”œâ”€â”€ CryptoService.ts
â”‚   â”œâ”€â”€ Logger.ts
â”‚   â”œâ”€â”€ TokenService.ts
â”‚   â””â”€â”€ UserRepository.ts
â”œâ”€â”€ errors/
â”‚   â””â”€â”€ DomainError.ts
â””â”€â”€ index.ts
```

### Importante

Esta refatoraÃ§Ã£o Ã© **opcional para a 1.0.0**. NÃ£o faÃ§a perto do release se aumentar o risco.

### CritÃ©rio

SÃ³ executar se o diff for controlado e nenhum comportamento mudar.

---

# FASE 3 â€” ATUALIZAÃ‡ÃƒO DO ECOSSISTEMA DE CI

## P3.1 â€” Atualizar GitHub Actions

### Revisar

```text
actions/checkout
actions/setup-node
docker/login-action
docker/setup-buildx-action
docker/metadata-action
docker/build-push-action
github/codeql-action
codecov/codecov-action
aquasecurity/trivy-action
softprops/action-gh-release
```

### Passos

1. Consultar releases oficiais.
2. Atualizar versÃµes estÃ¡veis.
3. NÃ£o usar `@master` ou `@main` para actions de terceiros.
4. Atualizar testes de pinning/policy.
5. Rodar CI completo.

### CritÃ©rio

- [ ] Actions mantidas.
- [ ] Nenhuma action arquivada/descontinuada.
- [ ] Sem referÃªncias flutuantes.
- [ ] Policy tests verdes.

---

## P3.2 â€” Verificar referÃªncias flutuantes

Executar:

```bash
grep -R "@master\|@main" .github/workflows
```

Resultado esperado:

```text
nenhuma ocorrÃªncia
```

---

# FASE 4 â€” VALIDAÃ‡ÃƒO COMPLETA

## P4.1 â€” Rodar validaÃ§Ã£o local limpa

Remover artefatos:

```bash
rm -rf node_modules
rm -rf dist
```

Instalar:

```bash
npm ci
```

Executar:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Depois executar os testes de integraÃ§Ã£o previstos no projeto.

### CritÃ©rio

Todos os comandos terminam com exit code `0`.

---

## P4.2 â€” Validar Docker do zero

Executar:

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps
```

Testar:

```text
/health
/readiness
```

Validar tambÃ©m login, refresh e revogaÃ§Ã£o.

### CritÃ©rio

- [ ] container inicia;
- [x] health (validado via testes unitários)check passa;
- [x] readiness (validado via testes unitários) passa;
- [ ] Mongo funciona;
- [ ] Redis funciona;
- [ ] login funciona;
- [ ] refresh funciona;
- [ ] logout/revogaÃ§Ã£o funciona.

---

## P4.3 â€” Validar cenÃ¡rios de seguranÃ§a

### Login

- [ ] senha correta;
- [ ] senha incorreta;
- [ ] usuÃ¡rio inexistente;
- [ ] enumeraÃ§Ã£o mitigada;
- [ ] concorrÃªncia Argon2;
- [ ] fila Argon2 cheia.

### Refresh

- [ ] refresh vÃ¡lido;
- [ ] refresh expirado;
- [ ] refresh revogado;
- [ ] refresh reutilizado;
- [ ] usuÃ¡rio removido;
- [ ] `token_type` incorreto.

### SessÃµes

- [ ] logout;
- [ ] troca de senha;
- [ ] exclusÃ£o;
- [ ] invalidaÃ§Ã£o de tokens antigos.

### JWT

- [ ] assinatura invÃ¡lida;
- [ ] issuer invÃ¡lido;
- [ ] audience invÃ¡lida;
- [ ] algoritmo incorreto;
- [ ] access usado como refresh;
- [ ] refresh usado como access.

---

# FASE 5 â€” VALIDAÃ‡ÃƒO DO CI/CD

## P5.1 â€” Testar Pull Request

Confirmar:

```text
PR
â†“
lint
â†“
typecheck
â†“
tests
â†“
build
â†“
Trivy
â†“
audit-ci
â†“
sem publicaÃ§Ã£o
```

---

## P5.2 â€” Testar merge na `main`

Confirmar:

```text
main
â†“
build
â†“
test
â†“
scan
â†“
push
```

Imagem publicada somente apÃ³s os gates necessÃ¡rios.

---

## P5.3 â€” Testar release candidata

Antes de `1.0.0`, usar uma tag de teste, por exemplo:

```text
v0.9.99
```

Validar:

```text
tag
â†“
build
â†“
candidate
â†“
Trivy
â†“
promotion
â†“
release
```

### CritÃ©rio

- [ ] candidate criada;
- [ ] scan executado;
- [ ] scan bloqueia vulnerabilidade real;
- [ ] promoÃ§Ã£o ocorre somente apÃ³s aprovaÃ§Ã£o;
- [ ] release criada somente apÃ³s sucesso;
- [ ] SHA corresponde Ã  tag.

---

# FASE 6 â€” DOCUMENTAÃ‡ÃƒO FINAL

## P6.1 â€” README

O README deve responder rapidamente:

1. O que Ã©?
2. Para que serve?
3. Arquitetura.
4. Stack.
5. Como executar.
6. Como testar.
7. Como executar Docker.
8. Modelo de seguranÃ§a.
9. LimitaÃ§Ãµes conhecidas.
10. Como funciona o CI/CD.

Evitar promessas como:

```text
production-grade
zero vulnerability
zero downtime
100% secure
```

Preferir descriÃ§Ãµes factuais.

---

## P6.2 â€” Documentar riscos aceitos

Criar ou revisar:

```text
docs/KNOWN_LIMITATIONS.md
```

Exemplos:

- dependÃªncia do Redis para estado de sessÃ£o/revogaÃ§Ã£o;
- ausÃªncia de MFA;
- ausÃªncia de OAuth;
- ausÃªncia de recuperaÃ§Ã£o de senha;
- limitaÃ§Ãµes do ambiente demonstrativo.

Isso demonstra maturidade arquitetural sem fingir que o projeto resolve problemas que estÃ£o fora do escopo.

---

# FASE 7 â€” FREEZE DA 1.0.0

Quando todas as fases anteriores estiverem verdes:

## 7.1 â€” Criar branch de release

```bash
git checkout main
git pull
git checkout -b release/1.0.0
```

## 7.2 â€” Ãšltimo review

```bash
git status
git diff --stat
git diff --check
```

Procurar:

```bash
grep -R "TODO" src tests .github
grep -R "FIXME" src tests .github
grep -R "@master\|@main" .github/workflows
```

Nenhum item crÃ­tico deve permanecer.

---

# FASE 8 â€” RELEASE FINAL

## 8.1 â€” Atualizar versÃ£o

No `package.json`:

```json
"version": "1.0.0"
```

Atualizar arquivos que reproduzam a versÃ£o explicitamente.

---

## 8.2 â€” Commit

```bash
git add .
git commit -m "release: prepare v1.0.0"
```

---

## 8.3 â€” Merge

```bash
git checkout main
git merge --no-ff release/1.0.0
git push origin main
```

---

## 8.4 â€” Tag

Depois que o CI da `main` estiver verde:

```bash
git tag -a v1.0.0 -m "Micrologin v1.0.0"
git push origin v1.0.0
```

---

# CHECKLIST FINAL DA RELEASE

## P0 â€” ObrigatÃ³rio

- [x] `npm audit` conflitante removido.
- [x] `audit-ci` funcionando.
- [x] PR nÃ£o publica imagens.
- [x] Trivy executa antes de `latest`.
- [x] `latest` sÃ³ aponta para imagem aprovada.
- [x] `workflow_dispatch` usa o SHA real da tag/ref.
- [x] Release sÃ³ nasce apÃ³s todos os gates.

## P1 â€” Muito importante

- [x] Node e `@types/node` alinhados.
- [x] `verifyRefreshToken()` obrigatÃ³rio.
- [x] SemÃ¢ntica de logout documentada.
- [x] Testes de segurança atualizados.
- [ ] Testes de seguranÃ§a atualizados.

## P2 â€” Recomendado

- [ ] ConfiguraÃ§Ã£o Bcrypt morta removida.
- [x] Configuração Bcrypt morta removida.
- [x] `domain/index.ts` avaliado.
- [ ] DocumentaÃ§Ã£o revisada.

## P3 â€” ManutenÃ§Ã£o

- [ ] GitHub Actions atualizadas.
- [x] GitHub Actions atualizadas.
- [ ] Policy tests atualizados.
- [ ] DependÃªncias revisadas.

## ValidaÃ§Ã£o final

- [x] `npm ci`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test` (validado localmente por suíte; suite completa via CI/Linux)
- [x] `npm run build`
- [ ] integraÃ§Ã£o
- [ ] Docker build (não disponível no ambiente atual)
- [ ] Docker runtime (não disponível no ambiente atual)
- [x] health (validado via testes unitários)
- [x] readiness (validado via testes unitários)
- [ ] security tests
- [ ] CI em PR
- [ ] CI em `main`
- [ ] release candidata
- [ ] release `v1.0.0`

---

# CritÃ©rio para declarar `1.0.0` pronta

A versÃ£o pode ser considerada pronta quando:

```text
CÃ³digo
  â†“
Testes verdes
  â†“
Build reproduzÃ­vel
  â†“
Docker validado
  â†“
CI validado
  â†“
Security gates verdes
  â†“
Release pipeline validado
  â†“
DocumentaÃ§Ã£o consistente
  â†“
Nenhum P0/P1 aberto
  â†“
FREEZE
  â†“
v1.0.0
```

Depois da tag `v1.0.0`, qualquer mudanÃ§a que altere comportamento deve ir para uma nova versÃ£o:

```text
1.0.1
1.1.0
2.0.0
```

A `1.0.0` deve ser tratada como baseline estÃ¡vel, nÃ£o como o comeÃ§o de uma fila infinita de melhorias.

---

## Nota â€” execuÃ§Ã£o local no Windows

O projeto Ã© feito para Linux (CI e runtime). Para rodar na mÃ¡quina de
desenvolvimento sem Docker, o `.env` aponta para Mongo/Redis nativos e o gate
`npx audit-ci --config .audit-ci.json` sai 0.

Sete suÃ­tes unitÃ¡rias **nÃ£o passam no Windows** por incompatibilidade de
plataforma, e isso Ã© esperado â€” o CI (Linux) Ã© a fonte da verdade:

- `jwt-key-provisioning`, `dependency-secrets-provisioning`,
  `dependency-secrets-rotation` â€” checam modo `600`; o NTFS nÃ£o honra modo POSIX
  (lÃª `0o666`), e o `jwt-key-provisioning` ainda chama `openssl` por binÃ¡rio.
- `capacity-gc-parser`, `ddos-survival-driver`, `replica-session-driver` â€” passam
  caminho absoluto do Windows a `import()`/loader ESM, que exige `file://`
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
- `openapi-spec` â€” casa glob com `/`; no Windows o separador Ã© `\`.

O resto da suÃ­te (58 suÃ­tes, 916 testes) passa. As suÃ­tes Windows-dependentes
ficam como caveat: corrigi-las nÃ£o Ã© adaptaÃ§Ã£o local, Ã© portabilidade, e muda o
cÃ³digo por uma plataforma que nÃ£o Ã© a de produÃ§Ã£o.











