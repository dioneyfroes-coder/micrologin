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

Executados nesta árvore. Unit reexecutado em 2026-10-05, depois dos 19 testes
de regressão do pipeline; as demais categorias são de 2026-10-04.

| Categoria | Comando | Resultado | Observação |
|---|---|---|---|
| Lint | `npm run lint` | ✅ exit 0 | `eslint src/ tests/`, sem aviso |
| Typecheck | `npm run typecheck` | ✅ exit 0 | `tsc --noEmit`, `strict` |
| Unit | `npm run test:unit` | ✅ **944 passed / 944**, 65 suites | 45,2 s |
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
| Imagem de produção | `docker build .` (stage `production`) | ✅ exit 0 | buildada de verdade, sem `--push`; argon2 nativo e OpenAPI (21 endpoints) conferidos **dentro** da imagem |
| Boot da imagem | `npm run test:deploy` | ✅ | o `deploy.sh` espera `/health` antes de dar sucesso, e a imagem que sobe é a de produção |
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

**Gate.** Roda na stage `production` do `Dockerfile`, faz upload do SARIF com
`security-events: write` e `if: always()`, e falha o job quando acha algo. O scan
aponta para o **digest** da imagem, não para tag mutável.

**Executado, e reprovou uma vez.** No run `37217066854` o gate reprovou com 10
`HIGH`. Todas as 10 estavam em `/usr/local/lib/node_modules/npm/node_modules/` —
a árvore que o npm da imagem base embarca, não o nosso código nem o nosso
lockfile. **Zero vulnerabilidades de SO** (Alpine 3.24.2, 28 pacotes). O nosso
`node_modules` estava limpo: brace-expansion 1.1.21, picomatch 2.3.2,
ip-address 10.7.2, todos acima da versão corrigida.

Não dava para consertar pelo caminho óbvio. As correções exigem pacote
`>=21.5.1` e brace-expansion `>=5.0.11`; `npm install -g npm@latest` só resolve
quando o npm publicar essa árvore. E **`node:24-alpine` não resolve** — medido:
traz npm 11.19.0, que embarca pacote 21.5.1 (corrigido) e não embarca mais
picomatch, mas embarca brace-expansion 5.0.7, e 4 dos 5 CVEs daquele pacote só
fecham a partir de 5.0.11.

A correção foi **remover o npm da imagem de runtime**. Ele é preciso para o
`npm ci --omit=dev` e nunca é usado em runtime (o `CMD` é `node dist/app.js`).
Some o código vulnerável em vez de silenciar o scanner.

Medido com o mesmo gate e a mesma versão do Trivy (`v0.75.0`): **exit 1** antes,
**exit 0** depois. E a imagem sem npm sobe — `readiness` 200 contra o Mongo e o
Redis reais, 222 pacotes de produção intactos.

### Status do secret scanning

**Verde e executado.** `npm run test:secrets` → gitleaks v8.24.0 em 103 commits
(4,57 MB) sem leak, nenhum arquivo de material versionado, e `.env.example` /
`.env.prod.example` com credencial vazia, caminho de arquivo ou placeholder.

## Imagem

```text
registry:        ghcr.io
image tag:       ghcr.io/dioneyfroes-coder/micrologin:1.0.0
                 ghcr.io/dioneyfroes-coder/micrologin:v1.0.0
                 ghcr.io/dioneyfroes-coder/micrologin:1392e2b
                 ghcr.io/dioneyfroes-coder/micrologin:latest
image digest:    sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b
platforms:       linux/amd64
```

As quatro tags respondem em `ghcr.io`, e o digest acima é o que o corpo da
release referencia.

**O `curl` cru no manifest dá 401, mas `docker pull` funciona.** O token
anônimo que o `ghcr.io` emite carrega identidade vazia (`0:...`) e o `curl` não
negocia o escopo. Quem consumir a imagem por script precisa de um cliente que
faça a troca de token — `docker pull` e `docker manifest inspect` funcionam.

### Smoke pós-release, com o comando que mediu

Imagem puxada de `ghcr.io` **por digest** (não por tag), na rede do compose, com
o mesmo ambiente que o serviço recebe:

```text
readiness .............. 200
checks ................. ready | mongo: connected | redis: healthy
login payload vazio ... HTTP 400
rota inexistente ..... HTTP 404
npm na imagem ......... AUSENTE
node ................... v22.23.3
deps de produção ....... 222 pacotes
digest rodando ......... sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b
```

O `400` no login com payload vazio é o comportamento certo: é a validação de
entrada respondendo, o que prova que a rota existe e que o grafo de módulos
carregou. Um `500` ali seria o app quebrado.

Uma ressalva de método: na primeira tentativa o `readiness` deu `000` e o log
mostrou `MongooseServerSelectionError: getaddrinfo ENOTFOUND mongo`, o que
parecia imagem quebrada. Era o teste — em produção o app exige credencial de
Mongo e Redis, e o teste não tinha passado. A validação de configuração estava
funcionando corretamente.

`docker-compose.prod.yml` consome `IMAGE_REF` por digest, com a tag como fallback.

### Rollback

`npm run test:deploy` — v1 → v2 → v3 com Mongo na porta errada. O deploy da v3
aborta no health check e o rollback restaura imagem, digest e env da v2. Todas as
etapas verdes.

Rodar esse drill depois da release rendeu o quarto defeito do processo: **o
cleanup do drill nunca removeu uma imagem sequer.** Ele terminava com
`--filter "reference=deploy-drill*"`, e o glob do filtro `reference` do Docker
segue o `filepath.Match` do Go, em que `*` **não** atravessa `/`, enquanto o
filtro compara contra `repo:tag` — que tem barra. Medido com as 10 imagens do
drill existindo: `deploy-drill*` → 0, `deploy-drill/*` → 7. Cada execução vazava
~3,4 GB, e o drill roda em CI.

O que escondeu o defeito: filtro que não casa nada devolve vazio, e vazio parece
"já estava limpo". Com `2>/dev/null`, `|| true` e o pipeline sem `pipefail`, o
zero parecia um sucesso silencioso. Depois da correção, o mesmo drill termina com
0 imagens `deploy-drill/*` e 0 containers.

## Git

```text
commit:      1392e2b — e a tag aponta para ele, verificado por
             git rev-parse v1.0.0^{commit}
tag:         v1.0.0 (movida de e29032f — ver abaixo)
release URL: https://github.com/dioneyfroes-coder/micrologin/releases/tag/v1.0.0
digest:      sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b
run:         37221333414 — os seis jobs verdes
publicada:   2026-10-04T17:42:35Z
```

Commits enviados nesta passagem de freeze, todos na `main`:
`fe488b1` (revisão de documentação), `12a4b95` (RTO e intermitência do
`test:ddos`), `d15c562` (gate `npm audit` removido do release), `8445b36`
(preflight de DDoS documentado e imagem de produção exercitada), `dedea92`
(build só em `linux/amd64`), `bca1014` (tag movida, registrado sem verificação),
`f680df8` (`JWT_SECRET` dos jobs), `3324ef1` (um `--tag` por tag) e `1392e2b`
(npm fora da imagem de runtime). A tag aponta para o último.

### Como a release foi efetivada

A tag foi movida **três vezes**, e cada movimento foi uma resposta a uma falha
real do pipeline — nenhuma delas no código do serviço:

|_run_| `head` | Onde parou |
|---|---|---|
| `37214687216` | `dedea92` | `tests` — `JWT_SECRET` de 16 caracteres, mínimo 32 |
| `37216423853` | `f680df8` | `image` — um `--tag` para quatro tags; buildx recusa |
| `37217066854` | `3324ef1` | `security` — 10 HIGH no npm embarcado da base |
| `37221333414` | `1392e2b` | **verde, dos seis jobs** |

O detalhe de cada defeito está em
[`MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md`](MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md),
seção "Os quatro defeitos".

O ponto que importa registrar: **o segundo defeito tinha teste, e o teste
passava.** Ele executava o `run:` de verdade com docker stubado e conferia
substring — e a string errada, separada por vírgula, contém as substrings
`:1.0.0` e `:v1.0.0`. Um teste que passa com o comando quebrado não é evidência
de nada. O stub agora valida cada referência com o mesmo critério do buildx, e
foi verificado reintroduzindo o defeito.

### Decisão da tag — `v1.0.0` já existia

`v1.0.0` estava em `e29032f`, **91 commits atrás** de `main`, sem release, imagem
nem digest associados. **Decisão: mover a tag para o commit de freeze.** A
alternativa `v1.0.1` foi descartada porque `release.yml` exige que a tag e o
`package.json` concordem, e o checklist inteiro já declara `1.0.0`.

**Executado:** a tag aponta para `1392e2b`, local e no remote. Confirmado por
`git ls-remote --tags origin`, que resolve `refs/tags/v1.0.0^{}` para
`1392e2b`, e por `git rev-parse v1.0.0^{commit}`.
A tag é anotada; o objeto tag tem SHA próprio, e o commit, outro.
`on: push: tags: 'v*.*.*'` casa com `v1.0.0`, então o `Release` foi disparado pelo
push.

**O que isso custou:** `e29032f` deixou de ser recuperável **por tag**. O commit
continua no histórico e é ancestral de `main`, então a reversão
(`git tag -f -a v1.0.0 -m "..." e29032f && git push --force origin v1.0.0`)
continua disponível. A operação é destrutiva, mas não irrecuperável.

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
- **O `test:ddos` no pipeline de release não verifica resiliência a DDoS, e
  isso é deliberado.** O job `tests` roda
  `npm run test:ddos -- --preflight-only`, e esse flag retorna em
  `scripts/ddos-survival-test.mjs` **antes** de checar Docker, k6, bash e
  openssl — ele resolve e imprime a URL alvo, e passa com ou sem k6
  instalado. Um teste novo executa o script com um `PATH` sem nenhum desses
  binários para provar que o retorno acontece antes das checagens. A suíte real
  sobe um stack efêmero e precisa de host provisionado, o que não existe num
  runner do Actions. **Não promovê-lo a gate foi decisão, não esquecimento:** o
  teste falhou 1 vez em 7, então como gate a release passaria a falhar 1 em 7.
  O comentário no `release.yml` diz isso na cara de quem for ler.
- **A imagem de produção foi construída e exercitada nesta árvore**, o que o
  relatório anterior afirmava apenas por inspeção. `docker build` do stage
  `production` conclui (exit 0) e, dentro da imagem: o `@node-rs/argon2` nativo
  carrega e faz hash/verify corretos — o que confirma que `npm ci --omit=dev`
  traz o binário musl certo; e o spec OpenAPI é gerado a partir de
  `dist/application/routes/*.js` com **21 endpoints**, que era o risco real, já
  que `src/` não é copiado para a imagem. O boot completo também está coberto:
  `test:deploy` sobe a imagem de produção e espera `/health` antes de dar
  sucesso, e passou.
- **A imagem é `linux/amd64` só, e isso foi decisão.** O `image` job publicava
  `--platform linux/amd64,linux/arm64` com **dois** defeitos. O primeiro: o
  `buildx` constrói todas as plataformas numa única invocação, então um arm64
  quebrado derrubaria a release inteira — inclusive para quem só puxa amd64. O
  segundo: não havia **nada** consumindo arm64. Nenhum `docker-compose*.yml`
  pinando plataforma, nenhum script de deploy tocando arm64, nenhum
  `STAGING_DEPLOY_HOST` nem `PRODUCTION_DEPLOY_HOST` configurado. E ele nunca
  foi verificado — a máquina não tem QEMU, então a única evidência era o lock
  mostrar `linux-arm64-musl` com `resolved` e `integrity`.

  Note que o risco era de build, não de segurança: como o `@node-rs/argon2` traz
  binário pré-compilado para musl, é bem provável que o arm64 *funcionasse*. O
  que não podia é publicar, no caminho crítico de uma release, uma plataforma
  sem consumidor e sem verificação, comprando um modo de falha em troca de nada.
  Quando alguém precisar de arm64, ele entra como item próprio, com build e
  verificação próprios — não de graça dentro do build de hoje.
- **O código-fonte é cross-platform; a imagem não é.** Node roda em Linux,
  macOS e Windows, e o lock traz variantes `darwin-*` e `win32-*`, então
  `npm test` funciona nos três. Mas o `Dockerfile` se compromete com
  `node:22-alpine` — que é **musl**, não glibc — e com uma arquitetura de CPU.
  O `@node-rs/argon2` é a prova materialize da diferença: 13 pacotes
  plataformaspecíficos no lock, cada um com `cpu`, `os` e `integrity` próprios,
  porque N-API padroniza a *interface* de chamada, não o *artefato compilado*.
  Não existe bytecode sem arquitetura em addon nativo. E o musl é o canto mais
  afiado: um addon que compila via `node-gyp` precisaria de `python3`, `make` e
  `g++`, que o Alpine não tem — o projeto escapa disso por usar `@node-rs`, não
  o `argon2` do node-gyp. Universalidade que depende de qual pacote você
  escolheu não é universalidade.
- **~~O pipeline de release nunca foi executado de ponta a ponta.~~ Resolvido.**
  Era a causa raiz dos dois problemas acima: um gate que ninguém executou não é
  evidência, é hipótese. Rodou quatro vezes, e cada execução reprovou por um
  defeito distinto — `JWT_SECRET` curto, um `--tag` para quatro tags, 10 HIGH do
  npm da imagem base. O run `37221333414` fechou o encadeamento completo —
  `validate → quality → tests → image → security → release` — com os seis jobs
  verdes, e a release existe em `ghcr.io` com digest registrado.
- **O RTO do backup não é constante.** Duas execuções no mesmo dia, na mesma
  máquina: **1s e 2s**. A documentação passou a dizer 1–2s. Um número único
  seria apresentar uma medição como se fosse especificação.
- **Staging e produção: o `workflow_dispatch` não foi executado**, porque não
  existe `STAGING_DEPLOY_HOST` nem `PRODUCTION_DEPLOY_HOST` configurado. Isso
  **não** é pendência de release, e é importante não apresentar como se fosse:
  `npm run test:deploy` já exercita o `deploy.sh` de ponta a ponta com o mesmo
  código de produção — três imagens, backup de configuração, readiness, smoke, e
  uma v3 com Mongo na porta errada abortando no health check, com rollback
  restaurando imagem, digest e env da v2. Rodar o dispatch adicionaria apenas o
  transporte SSH e o registry autenticado, não uma prova melhor da lógica de
  deploy. Usar um servidor de produção para provar que deploy funciona seria o
  oposto de prudência.
- **~~CI não foi verificado.~~ Resolvido.** O limitador era a API sem
  autenticação; a verificação foi feita pelo HTML público do Actions. Quatro
  execuções, cada uma reprovando por um defeito distinto, e o run
  `37221333414` com os seis jobs verdes.
- **~~Release completa: não executada.~~ Resolvido.** `buildx build --push`, o
  digest, o upload de SARIF e a criação da GitHub Release rodaram no run
  `37221333414`. Digest publicado
  `sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b`,
  Release `v1.0.0` publicada em `2026-10-04T17:42:35Z`.
- **~~Trivy em imagem real: não executado.~~ Resolvido** pelo job `security` do
  mesmo run, contra a imagem recém-construída. Foi ele que reprovou nos 10 HIGH
  do npm da imagem base — a execução que faltava era a que acharia o defeito.
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
