# Operação: rodar, testar, publicar e voltar atrás

Runbook do projeto. O `README.md` é a leitura de 60 segundos; este arquivo é o
que se consulta com o terminal aberto.

Índice: [rodar localmente](#1-rodar-localmente) ·
[variáveis de ambiente](#2-variáveis-de-ambiente) ·
[chaves JWT](#3-gerar-as-chaves-jwt) ·
[testes](#4-testes) ·
[CI/CD](#5-cicd) ·
[deploy](#6-deploy) ·
[rollback](#7-rollback) ·
[branches](#8-política-de-branches)

---

## 1. Rodar localmente

Com Docker:

```bash
cp .env.example .env   # opcional — o compose já injeta as variáveis dev
npm run docker:up       # sobe auth-service + MongoDB + Redis (hot reload via tsx)
```

Portas publicadas pelo compose dev: `3000` (API), `27017` (MongoDB), `6379`
(Redis). O container de dev roda `npm run dev` (tsx watch) e monta `./src` em
`/app/src`.

Sem Docker:

```bash
npm install
cp .env.example .env
npm run dev            # NODE_ENV=development, tsx watch
npm test
```

O `X-Request-Id` só é aceito como UUID válido (máx. 36 caracteres); caso
contrário o serviço descarta o valor, registra o descarte e gera o próprio id. O
id de requisição é chave de correlação de alerta, não campo livre de cliente.

---

## 2. Variáveis de ambiente

Copie [.env.example](../.env.example) para `.env`. Nenhuma credencial real fica
versionada: só os exemplos (`.env.example`, `.env.prod.example`) são commitados.

- `PORT`, `NODE_ENV`
- `URI_MONGODB`, `MONGODB_MAX_POOL_SIZE`
- `MONGODB_USER`, `MONGODB_PASSWORD` (ou `MONGODB_PASSWORD_PATH`),
  `MONGODB_AUTH_SOURCE`, `MONGODB_TLS` — credencial das dependências por
  arquivo; obrigatória em produção
- `REDIS_URL` (preferida: `redis://host:6379/0`, com a senha vinda de arquivo)
  ou o fallback `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`
- `REDIS_USERNAME`, `REDIS_PASSWORD_PATH`, `REDIS_TLS` — usuário de ACL e senha
  por arquivo
- `DEPENDENCY_NETWORK_ISOLATED` (`true` declara rede dedicada sem porta publicada
  como transporte; no lugar de `MONGODB_TLS`/`REDIS_TLS`)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` (obrigatório e **diferente** de
  `JWT_SECRET` em produção; sem fallback silencioso), `JWT_EXPIRES`,
  `JWT_REFRESH_EXPIRES`
- `JWT_ALGORITHM` (em produção, só `ES256` — HS256 é recusado na validação; o
  default fora de produção é `HS256`), `JWT_ES256_PRIVATE_KEY_PATH`,
  `JWT_ES256_PUBLIC_KEY_PATH`, `JWT_ES256_KID`
- `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`,
  `PASSWORD_PEPPER`/`PASSWORD_PEPPER_VERSION` e o par anterior
  `PASSWORD_PEPPER_PREVIOUS`/`PASSWORD_PEPPER_PREVIOUS_VERSION`
- `ARGON2_MAX_CONCURRENCY` (hashes argon2id **simultâneos** por processo, default
  8) e `ARGON2_MAX_QUEUE` (fila de espera, default 64). É o mesmo número que a
  validação de memória do arranque usa como multiplicador — o orçamento de
  memória e o limite aplicado não podem ser dois números diferentes
- `SESSION_FAIL_OPEN` (política de revogação sem Redis; padrão `false` em
  produção)
- `ALLOWED_ORIGINS`
- `METRICS_TOKEN` (em produção, configure um token: protege o manifesto de
  `/observability`)
- `TRUST_PROXY` (padrão `false`). `true` em produção **recusa o arranque**: a
  confiança em toda a cadeia só é segura com um proxy reverso que reescreva o
  cabeçalho, e `TRUST_PROXY_ALLOW_UNRESTRICTED=true` é o opt-in explícito para
  quem assume essa responsabilidade
- `PROXY_TLS_CERT_DIR` (Compose de produção: diretório externo com
  `fullchain.pem`/`privkey.pem` para nginx; HTTPS publicado em 443)
- `INSTANCE_ID` (opcional; identifica uma réplica em `/observability`; por
  padrão usa o hostname do container)
- `HTTP_HEADERS_TIMEOUT`, `HTTP_REQUEST_TIMEOUT`, `HTTP_KEEP_ALIVE_TIMEOUT`,
  `HTTP_CONNECTIONS_CHECKING_INTERVAL`, `HTTP_LISTEN_BACKLOG`,
  `HTTP_MAX_REQUESTS_PER_SOCKET`, `HTTP_MAX_HEADERS_COUNT` (defaults no
  `.env.prod.example`)
- `NET_CORE_SOMAXCONN` (backlog do kernel nos containers de produção; default
  4096)
- `SECURITY_DASHBOARD_TOKEN` (obrigatório em produção; header `X-Security-Token`)
- `RATE_LIMIT_*_POINTS` (pontos por janela)

Os segredos das dependências são gerados por
`scripts/generate-dependency-secrets.sh <dir> --for-container` (Mongo/Redis) e
`scripts/generate-jwt-keys.sh <dir> <kid> --for-container` (ES256), e nunca
entram no repositório. A rotação é
`scripts/rotate-dependency-secrets.sh <dir> --for-container` (Redis com janela,
Mongo com `--mongo-only`), e a ordem de cada troca está em
[`ROTACAO.md`](ROTACAO.md).

---

## 3. Gerar as chaves JWT

Em produção o algoritmo é **ES256** (ECDSA P-256) e **HS256 é recusado na
validação de arranque**. A razão é a separação de papéis: quem assina tem a
chave privada, quem verifica só a pública, e nenhuma das duas está no mesmo
lugar.

```bash
# gera o par e ajusta o dono para o usuário que roda o app no container
scripts/generate-jwt-keys.sh /run/secrets 2026-q3 --for-container

# resultado
#   /run/secrets/jwt-es256-private.pem   modo 600, NUNCA versionar
#   /run/secrets/jwt-es256-public.pem    pode ser distribuída
```

Depois, no ambiente:

```bash
JWT_ALGORITHM=ES256
JWT_ES256_KID=2026-q3
JWT_ES256_PRIVATE_KEY_PATH=/run/secrets/jwt-es256-private.pem
JWT_ES256_PUBLIC_KEY_PATH=/run/secrets/jwt-es256-public.pem
```

Três coisas que costumam dar errado:

- **O `kid` precisa viajar com a chave.** Um token assinado com um par e
  verificado com outro de mesmo material e `kid` diferente não verifica.
- **A chave privada tem que chegar como arquivo, não como variável.** PEM tem
  quebras de linha e variável de ambiente não; o caminho `_PATH` existe para o
  material não viajar como texto de configuração.
- **O dono do arquivo importa em bind mount.** O container enxerga o uid do
  host, e um par em modo 600 de quem provisionou vira ilegível lá dentro — o app
  então recusa arrancar dizendo que a chave "é obrigatória", quando na verdade
  ela está ali e ele não tem permissão de lê-la. `--for-container` ajusta o dono
  para o uid 1001 do `nodeuser`.

Para desenvolvimento, HS256 com `JWT_SECRET` e `JWT_REFRESH_SECRET` basta. O que
**não** basta é confiar que os dois segredos distintos são o que separa access de
refresh: isso é consequência de como o HS256 funciona, não propriedade do token.
A claim `token_type` é conferida nos dois algoritmos justamente por isso (D33).

---

## 4. Testes

```bash
npm test                    # toda a suíte (unit + integração)
npm run test:unit           # suítes unitárias
npm run test:integration    # suíte de integração
npm run test:e2e            # E2E contra MongoDB e Redis reais (sobe via compose)
npm run test:infra          # resiliência de infra: derruba Redis e container de verdade
npm run test:deploy         # drill de deploy + rollback com três imagens
npm run test:backup         # backup/restauração do Mongo de ponta a ponta
npm run test:redis          # revogação sobrevive ao restart do Redis
npm run test:redis:volume-loss   # mede o custo do limite D20
npm run test:config-backup  # backup/restauração da config EM EXECUÇÃO
npm run test:credential-theft    # T1–T6 com JWT real
npm run test:secrets        # gitleaks + material/.env versionado
npm run test:ddos           # stack efêmero: k6 + oversized/malformed + Slowloris
npm run test:coverage       # cobertura (text + html + lcov)
npm run test:capacity       # baseline de capacidade por endpoint (k6 + RSS/heap)
npm run lint                # ESLint em src/ e tests/
```

### O que cada drill prova

**`test:infra`** (`scripts/infra-resilience-test.sh`) sobe um stack isolado com
a imagem de produção, derruba o Redis no meio do teste, reinicia o container e
observa o serviço por HTTP:

```text
credenciais → Redis recusa anônimo (NOAUTH) e senha errada (WRONGPASS),
              Mongo recusa leitura anônima, e o container do app lê as próprias
              senhas mas não a do root do Mongo
rotação     → a senha do Redis gira com janela (a antiga e a nova autenticam no
              mesmo Redis, e o app que estava no ar não sente nada), o app
              reinicia com a nova, e a janela fecha: a antiga é recusada.
              A do Mongo gira sem janela, na ordem servidor → arquivo → app, e
              o login continua funcionando
Redis para  → 503 REVOCATION_UNAVAILABLE no login (não 401, não 429),
              liveness 200, readiness 200 e degradado, container sem restart
Redis volta → autenticação e rate limit compartilhado restaurados sem
              reiniciar o processo
restart     → o container encerra em ~1s e volta a autenticar, mesmo com o
              Redis fora (o shutdown não depende de dependência disponível)
```

**`test:backup`** (`scripts/test-backup.sh`) sobe um stack isolado, **cria um
usuário, tira o backup cifrado, apaga o banco de verdade, prova que o login
passou a falhar, restaura e exige que o mesmo usuário volte a autenticar**. O
`backup.sh` cifra o dump gpg AES-256 pela saída (nada em claro no disco),
verifica cada arquivo recém-criado (decifra + gzip + `mongorestore --dryRun`),
poda `N` diários + `M` semanas, grava o manifest `last-backup.json` e expõe
`--check` como gancho de alerta de backup velho. O `restore.sh` valida o arquivo
em `--dryRun` antes de tocar nos dados e restaura com `--drop`. RPO/RTO medidos,
retenção e restauração pontual só com o dump cifrado: [`BACKUP.md`](BACKUP.md).

**`test:redis`** (`scripts/test-redis-persistence.sh`) **revoga a sessão de um
usuário, reinicia o container do Redis e exige que o token revogado continue
revogado** — com um segundo usuário de controle, nunca revogado, que tem que
continuar autenticando em 200. O controle existe porque, sem ele, "401 depois do
restart" seria ambíguo: o fail-closed barraria tudo por indisponibilidade e o
teste passaria por acidente. O que o Redis guarda e o que cada chave custa
perder: [`REDIS.md`](REDIS.md).

**`test:config-backup`** (`scripts/test-config-backup.sh`) sobe um stack com a
**mesma topologia de mount de produção** (`/run/secrets` e
`/run/secrets-deps`), captura a configuração EM EXECUÇÃO, **edita o env file sem
redeployar** (o controle negativo — disco e container divergidos), apaga env e
segredos, restaura pelo metadata da imagem e prova em runtime que o app voltou a
exibir a configuração capturada, não a do disco editado. O `backup-config.sh` lê
do container (fonte da verdade) e registra dono/modo de cada segredo. Runbook:
[`CONFIG.md`](CONFIG.md).

**`test:secrets`** (`scripts/secret-scan.sh`) roda três checagens que não são a
mesma coisa: gitleaks no conteúdo **e no histórico** (é o que acha segredo pelo
formato, inclusive no que já foi apagado), material de segredo no índice do git
(`git ls-files` — o `.gitignore` não protege contra `git add -f`), e valor de
credencial em `.env*` versionado, que tem que ser vazio, um caminho de arquivo ou
um placeholder.

**`test:ddos`** inicia o perfil `ddos` do stack isolado, cria
chaves/senhas/certificado temporários e os remove junto com os volumes ao
terminar. Requer Docker Compose v2, Bash, OpenSSL e k6. O destino é somente
loopback; o cenário recusa hosts externos. `DDOS_VUS`/`DDOS_DURATION` ajustam a
carga e `DDOS_BASE_URL` muda a porta local do proxy.

**`test:capacity`** (`scripts/capacity-baseline.sh`) mede quanto **um** worker
aguenta, com o stack de produção e k6 dentro do Docker:

```bash
npm run test:capacity -- --workers 1 --vus 100,200,400 \
  --endpoints health,login,refresh,register --duration 60s
```

Ele sobe o rate limit só durante a medição (medir 429 é medir o limiter, não o
endpoint), semeia os usuários de login, amostra `/observability` e
`docker stats` durante a carga, e no fim apaga as chaves `rl_*`, os usuários de
teste e devolve o container ao `.env.prod`. `--max-in-flight` varia o teto do
disjuntor de concorrência (default 1024) para medir o efeito dele. O bruto fica
em `artifacts/` (ignorado pelo git) e a tabela interpretada em
[`metricas.md`](metricas.md) §3.

### O que o CI roda e o que ele não roda

O pipeline usa `test:unit:fast`, `test:integration:app`, `test:coverage:fast`
(com `--runInBand`) e `test:secrets`.

`test:infra`, `test:backup`, `test:redis`, `test:config-backup` e `test:deploy`
ficam **fora do CI de propósito**: derrubam serviço de verdade, restauram um
banco apagado e reiniciam o Redis. O trabalho disso é provar que a versão que
você está para implantar reage como deve — rodados localmente ou no host de
deploy, antes do corte. No lugar desses drills, o CI fica com os gates de
configuração (`tests/unit/redis-persistence-config.test.ts` e
`tests/unit/config-backup-policy.test.ts`), que leem os composes e os scripts e
falham se as invariantes forem desligadas.

---

## 5. CI/CD

`.github/workflows/ci-cd.yml` executa:

1. **code-quality**: ESLint, `npm audit` e `audit-ci` — **falham o pipeline**
   quando encontram erros reais (sem `continue-on-error`)
2. **tests**: unitários rápidos, integração e upload de cobertura para Codecov
3. **build**: build e push da imagem para GHCR (`linux/amd64`)
4. **security**: scan com Trivy, na mesma referência de imagem que será implantada
   (o digest) — **reprova o pipeline** em HIGH/CRITICAL
5. **deploy**: deploy real por SSH, apenas em `workflow_dispatch`. Sem servidor
   configurado, o job falha com mensagem explícita em vez de reportar sucesso

O preflight DDoS no CI só verifica que o alvo default é loopback e que hosts
externos são recusados; não dispara carga nem contata serviços.

### Política de imagem (Trivy)

O gate do Trivy é sobre a **imagem inteira**, não sobre o código: pacote da base,
dependência da aplicação, o que estiver lá dentro. A política é
`severity: 'HIGH,CRITICAL'`, e três decisões a sustentam.

**`exit-code: '1'`.** `exit-code` não tem default no `aquasecurity/trivy-action`.
Sem ele, o passo termina em 0 com a SARIF cheia de achados, o job fica verde e o
deploy segue, porque `deploy` depende de `security`. Relatório que ninguém lê e
barreira que nunca barra levam ao mesmo resultado: imagem vulnerável em
produção.

**`severity: 'HIGH,CRITICAL'`.** Um pouco mais permissivo que o `moderate` do
`audit-ci`, e a assimetria é deliberada. O `audit-ci` governa dependências que
este projeto escolhe e fixa em lockfile — dá para assumir a escolha. O Trivy
governa a imagem completa, incluindo pacotes da base que o projeto não controla,
onde MEDIUM é ruído frequente. Nenhum dos dois é mais forte sozinho e, juntos,
não deixam buraco: dependência da aplicação continua coberta a partir de
moderate. O `severity` filtra o que o gate considera; o SARIF continua completo.

**`ignore-unfixed: true`.** Bloquear por vulnerabilidade sem correção disponível
não torna o software mais seguro: torna o gate ignorável, porque não existe ação
que a equipe possa tomar. O achado continua no SARIF; o que reprova é o que dá
para corrigir. Se um dia essa escolha não servir, é uma linha.

Duas camadas de versão, porque pinar uma não pina a outra: `trivy-action` está
em `@v0.36.0`, e o motor vai em `version: 'v0.75.0'` — o action embute `v0.70.0`
por default, e deixar no default significa que vulnerabilidade disclosed depois
do `v0.70.0` não é detectada e o gate passa em silêncio. O `version` é input do
próprio action, então não entra um segundo action na cadeia.

### Política de dependências

O gate é o `audit-ci`, com threshold **moderate**: reprova em moderate ou
superior. O `.audit-ci.json` declara **um** threshold só.

No `audit-ci`, `low`, `moderate`, `high` e `critical` não são quatro
interruptores independentes: o seletor devolve no primeiro `true`, na ordem
`low > moderate > high > critical`. Com as quatro em `true` — que era o estado
anterior deste arquivo — valia `low`, e as outras três chaves eram configuração
morta.

`low` ficou de fora porque, neste ecossistema, severidade baixa quase sempre
descreve pacote alcançável por caminho não usado ou DoS sem impacto em
superfície que o serviço não expõe. Bloquear por `low` com a allowlist vazia
transforma o gate em ruído, e gate que se acostuma a ser ignorado não é gate.
`high` seria mais permissivo, mas o serviço tem argon2id, pepper e sessão
revogável — não é a base para aceitar advisory transitivo de severidade média
sem decisão explícita.

A `allowlist` não é para ser preenchida por convenience. Uma exceção precisa de
advisory, motivo, escopo e validade — e `expiry` existe justamente para a
validade não ser um número que ninguém reavisa.

**O formato importa, e o padrão é o errado.** O audit-ci aceita, no seu exemplo
mais visível, `{ "ghsa": ["GHSA-..."], "justification": "...", "expiry": "..." }`
— e ignora esse registro **sem erro e sem efeito**: o gate continua reprovando
pelo mesmo advisory que "consta" na lista, e o diff parece innocuous. O que o
`schema.json` do audit-ci de fato define é `NSPRecord`: a chave é o advisory e o
valor é `{ active, expiry, notes }`. Foi o que a allowlist deste repositório
passou a usar, e `tests/unit/audit-ci-gate.test.ts` falha se a lista voltar ao
formato ignorado.

Hoje existem **duas** exceções, ambas datadas:

| advisory | pacote | validade | por quê |
| --- | --- | --- | --- |
| `GHSA-vfj7-8cjw-p6xm` | `braces <=3.0.3` | 2027-01-01 | ReDoS por stack exhaustion. A faixa vulnerável **inclui a última versão publicada**, então não há versão corrigida a instalar. Todo caminho é de `devDependencies` (`jest`/`micromatch`, `lint-staged`/`micromatch`, `pm2`/`chokidar`) e o padrão vem de globs do próprio repositório em tempo de teste/lint, não de entrada de requisição. |
| `GHSA-hp3w-g68c-fv3c` | `sprintf-js` | 2027-01-01 | DoS por precision specifier sem limite. A faixa vulnerável é **todas as versões publicadas** (pacote sem manutenção), então não há correção a instalar. O único caminho é de `devDependencies`: `jest` → `babel-plugin-istanbul` → `@istanbuljs/load-nyc-config` → `js-yaml@3` → `argparse@1` → `sprintf-js`; não entra na árvore de runtime nem na imagem final, e o alcançável é o texto estático do próprio programa em mensagem de erro do `argparse`. |

A exceção é por **advisory**, nunca por pacote: allowlist por nome de pacote
esconderia advisory nova do mesmo pacote, inclusive uma que já tivesse correção.
E o teste compara o conjunto `moderate+` da árvore com o conjunto allowlisted —
nem mais, nem menos — então advisory nova reprova e exceção que o tempo já
resolveu aparece como sobra a remover.

O `npm audit --audit-level=moderate` **não** roda mais no job. Ele não tem
mecanismo de exceção e reprovava sempre por causa das advisories já
allowlistadas — um pipeline vermelho por uma decisão já tomada não é sinal, é
ruído. O gate é só o `audit-ci`, que é quem aplica a política acima.

---

## 6. Deploy

O deploy é um script que roda **no servidor**, não no CI. O CI resolve a imagem
imutável, envia os scripts e chama o deploy por SSH:

```bash
# o que o CI executa no servidor
~/.deploy/remote-deploy.sh \
  --image ghcr.io/dioneyfroes-coder/micrologin@sha256:<digest> \
  --env-file /opt/micrologin/.env.prod \
  --compose-file /opt/micrologin/docker-compose.prod.yml \
  --base-url https://api.exemplo.com
```

O que ele faz, nesta ordem:

```text
flock                      → um deploy por vez neste host
registro de versão         → o que está no ar agora (/var/lib/micrologin/deployed-version)
backup da versão em vigor  → tag *-backup-<timestamp>
docker pull <digest>       → imagem imutável, nunca latest
docker compose up -d       → via IMAGE_REF
espera /readiness          → 200 em até DEPLOY_READY_TIMEOUT (default 120s)
smoke test funcional       → registro, login, perfil, refresh, reuso, logout
registro da versão nova
```

Se o readiness não vier ou o smoke falhar, o script volta para a versão anterior
**e refaz o smoke nela** antes de dizer que voltou. Um 429 do rate limit é
tratado como inconclusivo: a versão nova fica no ar e o pipeline acende vermelho
para alguém decidir, porque reverter um deploy bom por limite de capacidade
trocaria um problema de taxa por uma indisponibilidade.

O smoke test ([`scripts/smoke-test.sh`](../scripts/smoke-test.sh)) exercita o
serviço de verdade, porque um health check 200 numa instância que não autentica
ninguém é um deploy verde e inútil:

```bash
scripts/smoke-test.sh https://api.exemplo.com
```

Secrets por ambiente (staging e produção), todos com prefixo
`{STAGING|PRODUCTION}_`: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_KNOWN_HOSTS`, `DEPLOY_ENV_FILE`, `DEPLOY_COMPOSE_FILE`,
`DEPLOY_BASE_URL` e, se a imagem do GHCR for privada, `REGISTRY_USERNAME` e
`REGISTRY_TOKEN`. `DEPLOY_SSH_PORT` é opcional (default 22).

### Como o ambiente é escolhido

O job `deploy` só roda em `workflow_dispatch`, e o ambiente vem **do input
`environment`** (`staging` ou `production`, obrigatório, padrão `staging`):

1. o job resolve o prefixo dos secrets a partir do input
   (`production` → `PRODUCTION_*`, qualquer outro → `STAGING_*`);
2. o primeiro passo, **antes de qualquer acesso a rede**, compara o prefixo
   resolvido com o ambiente escolhido e aborta se divergirem;
3. só depois disso a chave SSH é instalada, o registry é authenticado e o
   servidor é contatado.

Uma execução toca **exatamente um** ambiente. O input não é uma preferência: ele
é a única fonte de verdade, e não existe caminho no qual o job leia secrets de
ambiente diferente do escolhido.

Os GitHub **Environments** (`staging` e `production`) seguem separados, e é neles
que se configura o que exige aprovação: uma regra de *required reviewers* em
`production` faz o deploy de produção esperar por revisão humana, o que o
workflow sozinho não pode garantir.

Para rodar o mesmo deploy localmente, sem CI:

```bash
scripts/remote-deploy.sh --image <imagem> --env-file .env.prod \
  --compose-file docker-compose.prod.yml --base-url http://localhost:3000
```

### O que está provado e o que não está

`npm run test:deploy` exercita o `deploy.sh` de ponta a ponta com o mesmo código
que roda em produção: três imagens distintas (v1 → v2 → v3), backup de
configuração, readiness, smoke, e a v3 com o Mongo na porta errada abortando no
health check — o rollback restaura imagem, digest e env da v2 e o runtime volta a
servir. Esse drill roda também no CI, e ele é o que garante que o cleanup das
imagens do drill funciona (`deploy-drill/*` tem que terminar em zero).

O `workflow_dispatch` com `environment=staging` **não foi executado**: este
repositório não tem servidor de staging nem de produção, e o job falha com
mensagem explícita em vez de reportar sucesso fictício. Isso não é pendência de
release — o drill já prova a lógica de deploy, e o dispatch acrescentaria apenas
o transporte SSH e o registry autenticado. Usar um servidor de produção para
validar o próprio deploy seria o oposto de prudência.

---

## 7. Rollback

O rollback é automático e também é um caminho manual — as duas coisas usam o
mesmo script.

**Automático.** Se `/readiness` não vier em `DEPLOY_READY_TIMEOUT` (default 120s)
ou o smoke test funcional falhar, `remote-deploy.sh` volta sozinho para a versão
anterior e **refaz o smoke nela** antes de dizer que voltou. O job do CI sai
vermelho; o servidor fica na versão boa.

**Manual.** Rodar o script com o digest anterior devolve o mesmo caminho:

```bash
# 1. qual versão está no ar agora
cat /var/lib/micrologin/deployed-version

# 2. reexecutar o deploy com o digest anterior
~/.deploy/remote-deploy.sh \
  --image ghcr.io/dioneyfroes-coder/micrologin@sha256:<digest-anterior> \
  --env-file /opt/micrologin/.env.prod \
  --compose-file /opt/micrologin/docker-compose.prod.yml \
  --base-url https://api.exemplo.com
```

Dois detalhes que fazem o rollback ser de verdade, e não a subida da imagem
errada com a configuração nova:

- **A imagem anterior é tagueada antes do `compose up`** (`*-backup-<timestamp>`),
  então ela existe localmente e o retorno não depende de o registry ainda ter o
  digest.
- **A configuração é restaurada antes do compose subir.** Uma versão que precisa
  de env diferente volta com o env dela; sem isso, "rollback" seria subir a
  imagem antiga com a configuração da nova. O caminho é o mesmo que o
  `test:deploy` exercita, e o metadata da config é lido do **container em
  execução** — o disco pode divergir do que está rodando
  ([`CONFIG.md`](CONFIG.md)).

---

## 8. Política de branches

- apenas a branch `main` existe; **sem** `develop` ou `feature/*`
- no GitHub, a proteção da `main` (PR + code review + checks de CI) é uma
  recomendação de operação e depende da configuração externa; ela não está
  aplicada pelo repositório
- branches de trabalho são **efêmeras**: criadas para um PR pequeno e apagadas
  após o merge em `main`
- o CI dispara em push/PR para `main`; o **deploy só roda em
  `workflow_dispatch`** — um job de deploy que roda sozinho e imprime sucesso
  sem deployar é pior do que nenhum job
