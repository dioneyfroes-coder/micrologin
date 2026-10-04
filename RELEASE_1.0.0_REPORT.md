# RELEASE 1.0.0 — relatório de release

O que foi **medido** nesta árvore, com o comando que mediu. O que não foi
medido está escrito como não medido. Nenhum número deste arquivo é estimado.

- Item a item do checklist, com a evidência de cada um:
  [`MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md`](MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md).
- Estas medições são de **duas passagens**: uma antes do commit, outra depois do
  `npm ci` do freeze. Onde os números divergiram, o relatório traz os dois.

## Ambiente

| Item | Valor |
|---|---|
| Node.js | `v22.23.3` |
| npm | `10.9.9` |
| Docker | `29.8.2` (build `7fc2dff`) |
| Docker Compose | `v5.5.1` |
| SO do runner | Ubuntu 26.04.1 LTS, kernel `7.0.0-38-generic`, `x86_64` |
| `package.json` | `micrologin@1.0.0` |

O CI de GitHub roda em `ubuntu-latest` com Node pela matriz do
`.github/workflows/ci.yml`. **O runner desta tabela não é o runner do CI** — os
números de capacidade e de DDoS abaixo são desta máquina, não do runner do CI.

## Testes

Tudo executado em 2026-10-04, nesta árvore.

| Categoria | Comando | Resultado | Observação |
|---|---|---|---|
| Lint | `npm run lint` | ✅ exit 0 | `eslint src/ tests/`, sem aviso |
| Typecheck | `npm run typecheck` | ✅ exit 0 | `tsc --noEmit`, `strict` |
| Unit | `npm run test:unit` | ✅ **925 passed / 925**, 64 suites | 51,6 s |
| Integration | `npm run test:integration` | ✅ **42 passed / 42**, 7 suites | 5,2 s |
| E2E | `npm run test:e2e` | ✅ **16 passed / 16** | Mongo + Redis reais do compose, portas 27020/6380 |
| Credential theft | `npm run test:credential-theft` | ✅ **14 passed / 14** | inclui `real-redis`: revogação gravada no Redis real, não em memória |
| Infra | `npm run test:infra` | ✅ **13/13** | Redis caiu → 503 sem fail-open; rotação de Redis e Mongo no ar |
| Redis | `npm run test:redis` | ✅ | blacklist sobreviveu ao restart; `user_session_version` relido do volume |
| Redis volume-loss | `npm run test:redis:volume-loss` | ✅ | **mede o custo do limite D20**, que é o objetivo do drill |
| Backup | `npm run test:backup` | ✅ | **RTO medido: 1s e 2s** em duas execuções (restore → login 200) |
| Config backup | `npm run test:config-backup` | ✅ | devolveu o valor **EM EXECUÇÃO**, não o do disco editado |
| Deploy | `npm run test:deploy` | ✅ | v1 → v2 → v3 quebrada → **rollback para v2**, imagem e config |
| Replica session | `npm run test:replica-session` | ✅ | revogação cruzada em **3 réplicas reais** atrás do proxy |
| DDoS | `npm run test:ddos` | ✅ | 3254 checks 100%; liveness p95 5,5 ms → 6,3 ms sob ataque |
| Capacity | `npm run test:capacity` | ✅ | matriz 100/200/400 VUs concluída; artefatos em `artifacts/capacity/` |
| Dependency audit | `npm audit --audit-level=high` | ⚠️ **exit 1** — 30 high | ver Security Note. **Removido do gate do release**: como step, ele reprovaria sempre |
| audit-ci | `npx audit-ci --config .audit-ci.json` | ✅ **Passed** | **é o gate de dependências do `release.yml`**; 1 advisory allowlisted, expiry `2027-01-01` |
| Build (gate do release) | `npm run build` | ✅ exit 0 | step do job `quality`, conferido porque `image` depende dele |
| Secrets | `npm run test:secrets` | ✅ | gitleaks v8.24.0: 103 commits, 4,57 MB, nenhum leak |
| Coverage | `npm run test:coverage:fast` | ✅ **967 passed / 967**, 71 suites | statements 87,5 % · branches 83,76 % · functions 89,92 % · lines 87,49 % |

### Security Note — o `npm audit` cru não é verde, e isso é registrado como está

`npm audit --audit-level=high` **falha** com 30 `high`. O gate do projeto é o
`audit-ci`, que passa. A diferença importa e não deve ser lida como
"dependência vulnerável ignorada":

- `npm audit --omit=dev --audit-level=high` → **3 high**, todos da árvore
  `pm2 → chokidar → braces`, advisory `GHSA-vfj7-8cjw-p6xm` (ReDoS por
  stack exhaustion em glob profundamente aninhado).
- As outras **27 são de `devDependencies`** (`jest`, `lint-staged`,
  `micromatch`).
- Não existe versão corrigida para instalar: a faixa vulnerável inclui a última
  versão publicada de `braces`. Por isso a exceção é datada, não permanente.
- **Correção feita nesta revisão:** a nota do `.audit-ci.json` afirmava que "todos
  os caminhos são de `devDependencies`, incluindo `pm2/chokidar`". Isso era falso
  — `pm2` é dependência de **produção**. A nota foi reescrita para dizer que 3 dos
  30 high estão na árvore de produção e que nenhuma entrada de requisição HTTP
  alcança o código afetado (globs do próprio repositório em teste/lint; no pm2,
  o `ecosystem.config.cjs` e os arquivos de processo observados no host).

**Isto continua sendo uma dívida declarada, não um item fechado.**

## Segurança

| Item | Valor | Onde |
|---|---|---|
| Algoritmo JWT de produção | **ES256**; HS256 recusado na validação em produção | `appConfig.ts:302` |
| `kid` | `JWT_ES256_KID`, default `v1`; janela com `JWT_ES256_PREVIOUS_KID` | `appConfig.ts:431-434` |
| Argon2id | `memoryCost` 65536 KiB (64 MiB) · `timeCost` 1 · `parallelism` 1 | `appConfig.ts:467-469` |
| Orçamento de memória do Argon2 | `ARGON2_MEMORY_BUDGET_KIB` = 786432 KiB (768 MiB), conta `memoryCost × concorrência` | `appConfig.ts:282` |
| Limite de concorrência do Argon2 | `ARGON2_MAX_CONCURRENCY`, default **8**, fila FIFO de `ARGON2_MAX_QUEUE`, default **64** | `argon2Limiter.ts:38,47` |
| Excesso de fila | **503** + `Retry-After` (não 429: "agora não consigo", não "devagar") | `argon2Limiter.ts:27` |
| Rate limit em produção | IP 100/60 s, block 300 s · usuário 200/60 s, block 600 s · login **5/900 s**, block 1800 s | `rateLimitConfig.ts` |
| Rate limit compartilhado | Redis, prefixo `rl_` | `rateLimitConfig.ts` |
| In-flight limit | `MAX_IN_FLIGHT_REQUESTS`, default **1024** | `appConfig.ts:186` |
| TTL access token | `JWT_EXPIRES`, default **15m** | `appConfig.ts:436` |
| TTL refresh token | `JWT_REFRESH_EXPIRES`, default **7d** | `appConfig.ts:437` |
| Heap por processo | **512 MB**, derivado da medição de GC (não escolhido no compose) | `ecosystem.config.cjs:37` |
| `token_type` | Claim conferida em qualquer algoritmo, inclusive HS256 (D33) | `jwtTokenService.ts` |
| Revogação — logout | Encerra a sessão inteira a partir do refresh token | coberto por E2E |
| Revogação — troca de senha | Revoga **antes** de persistir; revogação não confirmada → 503 **sem** alterar a senha (D31) | `AuthService.changePassword` |
| Revogação — exclusão | Revoga **antes** de remover; token órfão é revogado no refresh (D31) | `AuthService.deleteUser` |
| Enumeração por timing | Mitigada em `/login` e `/register` por `compareDummy` (D34) | `AuthService` |
| `TRUST_PROXY` | Variável** **não é mais decorativa**: com ela ligada e mal configurada, o rate limit por IP ficava sem dono (D24) | item 2.4 |

### Limitação D20 — declarada, com o custo medido

A perda do volume do Redis **faz a revogação valer de novo** até o TTL expirar.
Medido pelo drill `test:redis:volume-loss` nesta árvore:

```text
access token revogado ......... volta a valer por até o TTL dele
refresh token já consumido .... volta a valer e renova access tokens até expirar
TTL do access token renovado ... 899770 ms (~15.0 min, medido na resposta)
Erros no log do app após o evento ... 0
```

O drill é **verde justamente porque o limite continua valendo**. Se um dia ele
reprovar por a revogação ter sobrevivido à perda de volume, a D20 foi fechada e
a documentação precisa ir junto.

### Status do Trivy

**Gate.** Roda na stage `production` do `Dockerfile` (que nasce de `base`, sem
histórico de comandos), faz upload do SARIF com `security-events: write` e
`if: always()`, e falha o job. O `exit-code` foi removido de propósito: o default
da action é o que se quer. O scan aponta para o **digest** da imagem, não para tag
mutável. Não executado localmente nesta revisão: exige o registry.

### Status do secret scanning

**Verde e executado.** `npm run test:secrets` → gitleaks v8.24.0 em 103 commits
(4,57 MB) sem leak, nenhum arquivo de material versionado, e `.env.example` /
`.env.prod.example` com credencial vazia, caminho de arquivo ou placeholder.

## Imagem

```text
registry:        ghcr.io
image tag:       ghcr.io/dioneyfroes-coder/micrologin:1.0.0
                 ghcr.io/dioneyfroes-coder/micrologin:v1.0.0
                 ghcr.io/dioneyfroes-coder/micrologin:<sha do commit>
                 ghcr.io/dioneyfroes-coder/micrologin:latest
image digest:    (a preencher pelo workflow — published no $GITHUB_STEP_SUMMARY)
platforms:       linux/amd64, linux/arm64
```

`docker-compose.prod.yml` consome `IMAGE_REF` por digest, com a tag como fallback.
**Nada foi publicado**: digest e URL da release só existem depois do push da tag.

## Git

```text
commit:      o commit que carrega este relatório — ou seja, o próprio commit de
             freeze. O SHA não pode estar escrito dentro do arquivo que ele
             carrega; consulte `git rev-parse v1.0.0^{commit}`.
tag:         v1.0.0 (movida de e29032f — ver abaixo)
release URL: (preenchida pelo workflow)
```

Push da revisão de documentação: `4ba1e85..fe488b1` na `main`. O commit de
freeze é o que a tag `v1.0.0` passa a apontar.

### Decisão da tag — `v1.0.0` já existia

`v1.0.0` estava em `e29032f`, **91 commits atrás** de `main`, sem release, imagem
nem digest associados. **Decisão: mover a tag para o commit de freeze.** A
alternativa `v1.0.1` foi descartada porque `release.yml` exige que a tag e o
`package.json` concordem, e o checklist inteiro já declara `1.0.0`.

**O que isso custa:** `e29032f` deixa de ser recuperável por tag. O commit
continua no histórico, alcançável pelo SHA.

**Efeito no changelog do pipeline:** `release.yml:120` resolve a tag anterior com
`git describe --tags --abbrev=0 "${TAG}^"`. Depois do movimento não sobra nenhuma
outra tag, então a resolução devolve vazio e o corpo da release assume o ramo
`else` de `Generate changelog` (`release.yml:366`): *"Primeira versão publicada a
partir deste repositório"* — o que é exato. O `CHANGELOG.md` versionado é outro
arquivo, com o histórico completo, e o pipeline não o sobrescreve: ele só o usa
como `body_path`.

## O que NÃO foi provado

Honestidade vale mais que uma tabela toda verde.

- **O `release.yml` tinha um gate que não podia passar, e isso foi encontrado
  antes de mexer na tag.** O job `quality` rodava
  `npm audit --audit-level=moderate` como step de gate — medido em **exit 1**
  nesta árvore. O `npm audit` não tem mecanismo de exceção, e a única advisory
  `moderate+` (`braces`) está allowlisted até 2027-01-01 justamente por não
  ter versão corrigida. Como `quality` está em `needs` de `image`, e `image` em
  `needs` de `release`, **a release nunca teria sido publicada** — e o operador
  só descobriria isso **depois** da tag `v1.0.0` reescrita e `e29032f`
  irrecuperável. O step foi removido; o `audit-ci` cobre o mesmo threshold
  (`moderate: true`) com a exceção. Um teste que **exigia** o step quebrado foi
  invertido para falhar se ele voltar. Detalhes em "Achados durante a execução".
- **`test:ddos` falhou 1 vez em 7 execuções, e não se sabe por quê.** A primeira
  execução depois do `npm ci` do freeze terminou com `exit 1` e
  `checks: 99.69% (3301 de 3311)` — 10 checks falharam. As **seis** execuções
  seguintes passaram com `100.00%`. O nome dos checks que falharam **se
  perdeu**: a saída foi filtrada com `grep` e só sobrou o contador. Os checks do
  script são `status < 500` em login/refresh/register/forwarded-IP e
  `status === 200` em liveness; a hipótese mais provável é o liveness cedendo
  algumas vezes durante o flood, mas **é hipótese, não medição**. Ver o registro
  em "Achados durante a execução" do checklist. Não é bloqueante — a propriedade
  testada foi verificada seis vezes seguidas — mas é a pendência mais relevante
  que este relatório carrega.
- **O pipeline de release nunca foi executado de ponta a ponta.** É a causa raiz
  dos dois problemas acima: um gate que ninguém executou não é evidência, é
  hipótese. Os gates que rodam foram conferidos um a um contra a árvore local
  (`npm audit --audit-level=moderate` foi medido e reprovado; `build`,
  `audit-ci` e `test:secrets` foram medidos e passaram), mas o encadeamento
  completo — `validate → quality → tests → image → security → release` — não tem
  execução registrada.
- **O RTO do backup não é constante.** Duas execuções no mesmo dia, na mesma
  máquina: **1s e 2s**. A documentação passou a dizer 1–2s. Um número único
  seria apresentar uma medição como se fosse especificação.
- **Staging e produção: nada foi executado.** Não existe `STAGING_DEPLOY_HOST`
  nem `PRODUCTION_DEPLOY_HOST` configurado, nem secrets correspondentes. Os itens
  1.5, 2.4, 4.3 e todos os de pós-release que dependem de servidor real seguem
  **pendentes por falta de infraestrutura**, não por defeito.
- **CI não foi verificado.** Sem token e sem `gh` CLI, e a API do GitHub sem
  autenticação responde com rate limit. O gate "CI verde no último commit da
  `main`" **não foi checado** — precisa ser conferido por quem tem acesso antes
  de mover a tag.
- **`workflow_dispatch` de staging: não executado** (mesma razão).
- **Release completa: não executada.** `buildx build --push`, digest, upload de
  SARIF e criação da GitHub Release exigem tag real e registry. O comando de build
  foi **verificado por inspeção e por teste de política**, não executado.
- **Trivy em imagem real: não executado** localmente.
- **`npm audit` cru continua falhando** (30 high, 3 deles em produção), conforme
  detalhado na Security Note. O que passa é o `audit-ci` com exceção datada — e
  o `npm audit` deixou de ser gate do release por isso.
- **`tests/integration/login-throttle.test.ts` é dependente de tempo.** Passa em
  `test:integration` e falhou em runs agregados de cobertura no passado. É
  pré-existente (reproduzido na árvore limpa em `9c879bc`), não é regressão dos
  itens 1.2/1.3, e **não é bloqueante para a 1.0.0**. O teste deveria usar
  relógio injetável.
- **Enumeração por timing não foi mitigada em `updateUserProfile`.** Omitida de
  propósito aqui para não parecer fechada; está registrada como pendência em
  [`docs/SEGURANCA.md`](docs/SEGURANCA.md).
- **DR-frio completo não é coberto.** O restore funciona em um Mongo já
  autenticado em pé; restaurar em volume virgem não é exercitado
  ([`docs/BACKUP.md`](docs/BACKUP.md)).
- **Mongo single-node.** Não há replica set; a disponibilidade do banco é a
  disponibilidade de um processo.
