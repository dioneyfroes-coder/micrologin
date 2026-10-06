# Micrologin — Plano de Correções para a Release 1.0.0

## Objetivo

Levar o projeto ao estado em que a versão `1.0.0` possa ser publicada como projeto final de portfólio sem continuar adicionando funcionalidades de escopo.

A prioridade é:

1. eliminar bloqueadores reais;
2. corrigir inconsistências do CI/CD;
3. validar o sistema em ambiente limpo;
4. remover dívida técnica pequena e ruído;
5. congelar o código;
6. criar a release `v1.0.0`.

> Regra desta fase: **não adicionar novas features**. MFA, OAuth, Kafka, Kubernetes, OpenTelemetry, novos provedores e novos bancos ficam fora do escopo da 1.0.0.

---

# Visão geral das fases

| Fase | Importância | Objetivo |
|---|---|---|
| Fase 0 | 🔴 P0 — Bloqueador | Corrigir falhas que podem invalidar a release |
| Fase 1 | 🟠 P1 — Alta | Fortalecer CI/CD e eliminar inconsistências importantes |
| Fase 2 | 🟡 P2 — Média | Limpeza e consistência técnica |
| Fase 3 | 🟢 P3 — Baixa | Melhorias de apresentação e manutenção |
| Fase 4 | 🔵 Release | Validação final, congelamento e publicação |

---

# FASE 0 — BLOQUEADORES DA 1.0.0

## ✅ P0.1 — Remover o `npm audit` que conflita com a política de allowlist (concluído — commit `cb54d04`)

### Problema

O CI usa simultaneamente:

```yaml
npm audit --audit-level=moderate
```

e:

```yaml
npx audit-ci --config .audit-ci.json
```

O `audit-ci` respeita a allowlist configurada, enquanto o `npm audit` não usa a mesma política. Isso pode fazer o pipeline rejeitar uma vulnerabilidade explicitamente aceita pelo projeto.

### Passos

1. Abrir:

```text
.github/workflows/ci-cd.yml
```

2. Localizar o step:

```yaml
- name: 🔒 Security audit
  run: npm audit --audit-level=moderate
```

3. Remover esse step.

4. Manter como gate oficial:

```yaml
- name: Dependency security audit
  run: npx audit-ci --config .audit-ci.json
```

5. Verificar que `.audit-ci.json` contém somente vulnerabilidades explicitamente aceitas.

### Validação

```bash
npx audit-ci --config .audit-ci.json
```

Resultado esperado: `exit code 0`.

### Critério de conclusão

- [x] `npm audit` cru removido do CI.
- [x] `audit-ci` permanece como política oficial.
- [x] Allowlist documentada.
- [x] CI passa.

---

## ✅ P0.2 — Impedir publicação de imagens Docker em Pull Requests (concluído — commit `e0778ae`)

### Problema

O pipeline também executa em `pull_request`, mas o build Docker está configurado para publicar a imagem. Isso pode falhar em forks, exigir permissões desnecessárias e poluir o GHCR com imagens temporárias.

### Objetivo

```text
Pull Request
    ↓
build
    ↓
test
    ↓
security scan
    ↓
sem push

main / release
    ↓
build
    ↓
security scan
    ↓
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

5. Revisar permissões para não dar `packages: write` onde ele não é necessário.

### Validação

Abrir um PR de teste e confirmar:

```text
PR → build ocorre
PR → testes ocorrem
PR → Trivy ocorre
PR → nenhum push ao GHCR
```

### Critério de conclusão

- [x] PR não publica imagem.
- [x] PR ainda executa build.
- [x] PR ainda executa security scan.
- [x] Main/release continuam publicando.

---

## ✅ P0.3 — Não mover `latest` antes do security gate (concluído — commit `5d957e4`)

### Problema

A pipeline de release pode executar:

```text
build
→ push 1.0.0
→ push v1.0.0
→ push SHA
→ push latest
→ Trivy
```

Se o Trivy falhar, `latest` já pode apontar para uma imagem rejeitada.

### Objetivo

```text
build
  ↓
candidate image
  ↓
Trivy
  ↓
PASSOU
  ↓
promote
  ├── 1.0.0
  ├── v1.0.0
  ├── SHA
  └── latest
  ↓
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

5. Configurar o Trivy para falhar segundo a política do projeto. Exemplo:

```yaml
exit-code: '1'
severity: 'HIGH,CRITICAL'
```

6. Somente após sucesso promover o mesmo digest para:

```text
1.0.0
v1.0.0
SHA
latest
```

7. Criar a GitHub Release somente depois da promoção.

### Critério de conclusão

- [x] Trivy ocorre antes de `latest`.
- [x] Imagem reprovada nunca vira `latest`.
- [x] O mesmo artefato/digest é promovido entre as tags.
- [x] GitHub Release só ocorre após todos os gates.

---

## ✅ P0.4 — Corrigir o SHA utilizado em `workflow_dispatch` (concluído — commit `965bea9`)

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

3. Se o workflow permite selecionar uma tag/ref, fazer checkout explícito dessa ref.

4. Após o checkout, determinar o SHA real:

```bash
git rev-parse HEAD
```

5. Usar esse valor em metadata, resumo da release, labels e validações.

### Validação

```bash
git rev-parse v1.0.0
```

Comparar com o SHA exibido pelo workflow.

### Critério de conclusão

- [x] Tag e commit são sempre correspondentes.
- [x] Execução manual não cria metadata enganosa.
- [x] Teste automatizado cobre o caso.

---

# FASE 1 — CORREÇÕES IMPORTANTES

## ✅ P1.1 — Alinhar Node.js com `@types/node` (concluído — commit `2040933`)

> Node 24 LTS em `@types/node` (`^24.7.0`), `NODE_VERSION: '24.x'` no CI, `node:24-alpine` no Dockerfile/scripts e docs atualizadas. Typecheck, lint, build e `npm test` validados (caveat Windows permanece).

### Problema

Há desalinhamento entre runtime e tipos: CI usa Node 22 enquanto `@types/node` está na linha 26. Isso permite que o TypeScript enxergue APIs que o runtime real pode não possuir.

### Recomendação

Escolher uma única linha. Para a 1.0.0, preferência: **Node 24 LTS**.

### Arquivos a revisar

```text
package.json
Dockerfile
.github/workflows/*.yml
README.md
```

### Passos

1. Definir a versão alvo.
2. Atualizar `@types/node`.
3. Atualizar matrix/variáveis do CI.
4. Atualizar imagem/base Docker.
5. Atualizar documentação.
6. Rodar:

```bash
npm run typecheck
npm test
npm run build
```

### Critério

```text
Node runtime = Node types = CI = Docker = documentação
```

---

## ✅ P1.2 — Tornar `verifyRefreshToken()` obrigatório (concluído — commit `aa3b8d0`)

### Problema

A interface declara:

```ts
verifyRefreshToken?(token: string): Promise<unknown>;
```

como opcional, mas validar refresh é parte da segurança.

### Passos

1. Abrir a interface de token.
2. Remover o `?`.
3. Atualizar implementações.
4. Atualizar mocks.
5. Atualizar doubles de teste.
6. Procurar usos:

```bash
grep -R "verifyRefreshToken" src tests
```

### Critério

- [x] Interface obrigatória.
- [x] Todas as implementações compilam.
- [x] Todos os testes passam.

---

## P1.3 — Formalizar a política de logout

### Situação

A invalidação por `sessionVersion` representa potencialmente logout de todas as sessões, e não apenas do dispositivo atual.

### Decisão recomendada para 1.0.0

Manter o mecanismo atual e documentar claramente:

```text
logout = invalidação de todas as sessões do usuário
```

Se no futuro for necessário logout individual, introduzir estado por sessão (`sessionId`, `deviceId` ou `jti`).

### Critério

- [ ] Comportamento documentado.
- [ ] Teste correspondente.
- [ ] README/API docs refletem o comportamento real.

---

## P1.4 — Documentar Redis como dependência de segurança

### Situação

A revogação depende do Redis. Perda completa do estado pode afetar a validade de sessões/revogações.

### Para 1.0.0

Não é necessário redesenhar a arquitetura. Classificar explicitamente como:

```text
Known limitation / accepted risk
```

Documentar:

- Redis necessário para o estado distribuído de sessão/revogação;
- impacto de perda do volume Redis;
- estratégia de recuperação;
- backup/restore existentes.

### Critério

- [ ] Risco documentado.
- [ ] Nenhuma documentação promete garantias que dependam da persistência perfeita do Redis.
- [ ] Backup/restore continuam testados.

---

# FASE 2 — LIMPEZA TÉCNICA

## P2.1 — Remover configuração Bcrypt obsoleta

### Problema

Existe configuração como:

```env
BCRYPT_SALT_ROUNDS=12
```

apesar de a implementação atual usar Argon2id.

### Passos

```bash
grep -R "BCRYPT" .
grep -R "bcrypt" .
```

Depois:

- [ ] remover variáveis sem uso;
- [ ] remover documentação antiga;
- [ ] remover comentários incorretos.

### Critério

Nenhuma configuração deve sugerir que bcrypt faz parte da política atual se não faz.

---

## P2.2 — Revisar comentários excessivos

### Objetivo

Manter comentários que expliquem decisões, trade-offs, limites, motivos de segurança e riscos aceitos. Reduzir comentários que apenas repetem o código.

### Regra

```text
Código → como
Teste → comportamento
Documentação → por quê
```

### Critério

- [ ] comentários redundantes removidos;
- [ ] decisões arquiteturais mantidas;
- [ ] histórico de bugs já resolvidos removido quando não agrega contexto.

---

## P2.3 — Avaliar divisão de `domain/index.ts`

### Possível estrutura

```text
src/domain/
├── entities/
│   └── User.ts
├── services/
│   └── AuthService.ts
├── ports/
│   ├── CryptoService.ts
│   ├── Logger.ts
│   ├── TokenService.ts
│   └── UserRepository.ts
├── errors/
│   └── DomainError.ts
└── index.ts
```

### Importante

Esta refatoração é **opcional para a 1.0.0**. Não faça perto do release se aumentar o risco.

### Critério

Só executar se o diff for controlado e nenhum comportamento mudar.

---

# FASE 3 — ATUALIZAÇÃO DO ECOSSISTEMA DE CI

## P3.1 — Atualizar GitHub Actions

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
2. Atualizar versões estáveis.
3. Não usar `@master` ou `@main` para actions de terceiros.
4. Atualizar testes de pinning/policy.
5. Rodar CI completo.

### Critério

- [ ] Actions mantidas.
- [ ] Nenhuma action arquivada/descontinuada.
- [ ] Sem referências flutuantes.
- [ ] Policy tests verdes.

---

## P3.2 — Verificar referências flutuantes

Executar:

```bash
grep -R "@master\|@main" .github/workflows
```

Resultado esperado:

```text
nenhuma ocorrência
```

---

# FASE 4 — VALIDAÇÃO COMPLETA

## P4.1 — Rodar validação local limpa

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

Depois executar os testes de integração previstos no projeto.

### Critério

Todos os comandos terminam com exit code `0`.

---

## P4.2 — Validar Docker do zero

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

Validar também login, refresh e revogação.

### Critério

- [ ] container inicia;
- [ ] healthcheck passa;
- [ ] readiness passa;
- [ ] Mongo funciona;
- [ ] Redis funciona;
- [ ] login funciona;
- [ ] refresh funciona;
- [ ] logout/revogação funciona.

---

## P4.3 — Validar cenários de segurança

### Login

- [ ] senha correta;
- [ ] senha incorreta;
- [ ] usuário inexistente;
- [ ] enumeração mitigada;
- [ ] concorrência Argon2;
- [ ] fila Argon2 cheia.

### Refresh

- [ ] refresh válido;
- [ ] refresh expirado;
- [ ] refresh revogado;
- [ ] refresh reutilizado;
- [ ] usuário removido;
- [ ] `token_type` incorreto.

### Sessões

- [ ] logout;
- [ ] troca de senha;
- [ ] exclusão;
- [ ] invalidação de tokens antigos.

### JWT

- [ ] assinatura inválida;
- [ ] issuer inválido;
- [ ] audience inválida;
- [ ] algoritmo incorreto;
- [ ] access usado como refresh;
- [ ] refresh usado como access.

---

# FASE 5 — VALIDAÇÃO DO CI/CD

## P5.1 — Testar Pull Request

Confirmar:

```text
PR
↓
lint
↓
typecheck
↓
tests
↓
build
↓
Trivy
↓
audit-ci
↓
sem publicação
```

---

## P5.2 — Testar merge na `main`

Confirmar:

```text
main
↓
build
↓
test
↓
scan
↓
push
```

Imagem publicada somente após os gates necessários.

---

## P5.3 — Testar release candidata

Antes de `1.0.0`, usar uma tag de teste, por exemplo:

```text
v0.9.99
```

Validar:

```text
tag
↓
build
↓
candidate
↓
Trivy
↓
promotion
↓
release
```

### Critério

- [ ] candidate criada;
- [ ] scan executado;
- [ ] scan bloqueia vulnerabilidade real;
- [ ] promoção ocorre somente após aprovação;
- [ ] release criada somente após sucesso;
- [ ] SHA corresponde à tag.

---

# FASE 6 — DOCUMENTAÇÃO FINAL

## P6.1 — README

O README deve responder rapidamente:

1. O que é?
2. Para que serve?
3. Arquitetura.
4. Stack.
5. Como executar.
6. Como testar.
7. Como executar Docker.
8. Modelo de segurança.
9. Limitações conhecidas.
10. Como funciona o CI/CD.

Evitar promessas como:

```text
production-grade
zero vulnerability
zero downtime
100% secure
```

Preferir descrições factuais.

---

## P6.2 — Documentar riscos aceitos

Criar ou revisar:

```text
docs/KNOWN_LIMITATIONS.md
```

Exemplos:

- dependência do Redis para estado de sessão/revogação;
- ausência de MFA;
- ausência de OAuth;
- ausência de recuperação de senha;
- limitações do ambiente demonstrativo.

Isso demonstra maturidade arquitetural sem fingir que o projeto resolve problemas que estão fora do escopo.

---

# FASE 7 — FREEZE DA 1.0.0

Quando todas as fases anteriores estiverem verdes:

## 7.1 — Criar branch de release

```bash
git checkout main
git pull
git checkout -b release/1.0.0
```

## 7.2 — Último review

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

Nenhum item crítico deve permanecer.

---

# FASE 8 — RELEASE FINAL

## 8.1 — Atualizar versão

No `package.json`:

```json
"version": "1.0.0"
```

Atualizar arquivos que reproduzam a versão explicitamente.

---

## 8.2 — Commit

```bash
git add .
git commit -m "release: prepare v1.0.0"
```

---

## 8.3 — Merge

```bash
git checkout main
git merge --no-ff release/1.0.0
git push origin main
```

---

## 8.4 — Tag

Depois que o CI da `main` estiver verde:

```bash
git tag -a v1.0.0 -m "Micrologin v1.0.0"
git push origin v1.0.0
```

---

# CHECKLIST FINAL DA RELEASE

## P0 — Obrigatório

- [x] `npm audit` conflitante removido.
- [x] `audit-ci` funcionando.
- [x] PR não publica imagens.
- [x] Trivy executa antes de `latest`.
- [x] `latest` só aponta para imagem aprovada.
- [x] `workflow_dispatch` usa o SHA real da tag/ref.
- [x] Release só nasce após todos os gates.

## P1 — Muito importante

- [x] Node e `@types/node` alinhados.
- [x] `verifyRefreshToken()` obrigatório.
- [ ] Semântica de logout documentada.
- [ ] Limitação do Redis documentada.
- [ ] Testes de segurança atualizados.

## P2 — Recomendado

- [ ] Configuração Bcrypt morta removida.
- [ ] Comentários excessivos revisados.
- [ ] `domain/index.ts` avaliado.
- [ ] Documentação revisada.

## P3 — Manutenção

- [ ] GitHub Actions atualizadas.
- [ ] Nenhum `@master`/`@main`.
- [ ] Policy tests atualizados.
- [ ] Dependências revisadas.

## Validação final

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] integração
- [ ] Docker build
- [ ] Docker runtime
- [ ] health
- [ ] readiness
- [ ] security tests
- [ ] CI em PR
- [ ] CI em `main`
- [ ] release candidata
- [ ] release `v1.0.0`

---

# Critério para declarar `1.0.0` pronta

A versão pode ser considerada pronta quando:

```text
Código
  ↓
Testes verdes
  ↓
Build reproduzível
  ↓
Docker validado
  ↓
CI validado
  ↓
Security gates verdes
  ↓
Release pipeline validado
  ↓
Documentação consistente
  ↓
Nenhum P0/P1 aberto
  ↓
FREEZE
  ↓
v1.0.0
```

Depois da tag `v1.0.0`, qualquer mudança que altere comportamento deve ir para uma nova versão:

```text
1.0.1
1.1.0
2.0.0
```

A `1.0.0` deve ser tratada como baseline estável, não como o começo de uma fila infinita de melhorias.

---

## Nota — execução local no Windows

O projeto é feito para Linux (CI e runtime). Para rodar na máquina de
desenvolvimento sem Docker, o `.env` aponta para Mongo/Redis nativos e o gate
`npx audit-ci --config .audit-ci.json` sai 0.

Sete suítes unitárias **não passam no Windows** por incompatibilidade de
plataforma, e isso é esperado — o CI (Linux) é a fonte da verdade:

- `jwt-key-provisioning`, `dependency-secrets-provisioning`,
  `dependency-secrets-rotation` — checam modo `600`; o NTFS não honra modo POSIX
  (lê `0o666`), e o `jwt-key-provisioning` ainda chama `openssl` por binário.
- `capacity-gc-parser`, `ddos-survival-driver`, `replica-session-driver` — passam
  caminho absoluto do Windows a `import()`/loader ESM, que exige `file://`
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
- `openapi-spec` — casa glob com `/`; no Windows o separador é `\`.

O resto da suíte (58 suítes, 916 testes) passa. As suítes Windows-dependentes
ficam como caveat: corrigi-las não é adaptação local, é portabilidade, e muda o
código por uma plataforma que não é a de produção.
