# Arquitetura e fluxo de autenticação

Descreve o que o código faz, não o que ele poderia fazer. Toda afirmação aqui
tem um arquivo correspondente; onde há limite conhecido, o limite está escrito.

---

## 1. Camadas

```text
                    ┌──────────────────────────────────────────────┐
  requisição HTTP   │  interfaces/  config centralizada              │
  ───────────────► │  appConfig · rateLimitConfig · redisConfig    │
                    │  helmet · cors · swagger                      │
                    └──────────────────────────────────────────────┘
                                      │ lê configuração
                                      ▼
                    ┌──────────────────────────────────────────────┐
                    │  application/                                 │
                    │                                              │
                    │  middleware (ordem importa, ver §2):          │
                    │    requestLogger → normalizeInput →           │
                    │    detectThreats → advancedRateLimit          │
                    │                                              │
                    │  routes/authRoutes                            │
                    │    → AuthMiddleware  (autentica)              │
                    │    → validation        (formato/tamanho)      │
                    │    → AuthWebController (orquestra)            │
                    └──────────────────────────────────────────────┘
                                      │ chama casos de uso
                                      ▼
                    ┌──────────────────────────────────────────────┐
                    │  domain/           ← não importa nada de fora │
                    │                                              │
                    │  portas (interfaces que o domínio declara):  │
                    │    UserRepository                            │
                    │    CryptoService                             │
                    │    TokenService                              │
                    │    Logger                                    │
                    │                                              │
                    │  AuthService: regras de negócio              │
                    └──────────────────────────────────────────────┘
                                      ▲ implementa as portas
                                      │
                    ┌──────────────────────────────────────────────┐
                    │  infrastructure/                              │
                    │  adapters/MongoUserAdapter   → MongoDB        │
                    │  adapters/PasswordHasher      → argon2id       │
                    │  external-services/JWTTokenService → Redis   │
                    └──────────────────────────────────────────────┘

  shared/    src/shared/utils/  — policy de username e senha, health
             check, logger, outcomes de autenticação. Sem dependência
             de camada: tanto domain quanto application importam.
```

A regra que sustenta o desenho: **`domain/` não importa `infrastructure/` nem
`application/`.** Ele declara o que precisa (`UserRepository`, `TokenService`) e
quem monta o objeto decide a implementação. `core/bootstrap.ts` e o
`ServiceContainer` fazem essa ligação.

---

## Topologia de produção

```text
cliente -- HTTPS :443 / HTTP :80 --> auth-proxy (nginx)
                  | limit_req / limit_conn / TLS
                  +--> auth-service:3000 (réplicas)
                     |--> MongoDB (deps-network)
                     +--> Redis (deps-network)
```

No `docker-compose.prod.yml`, somente `auth-proxy` publica portas no host. A
API fica em `auth-network` com `expose: 3000`, e também alcança as dependências
pela rede interna `deps-network`. O proxy termina TLS usando
`PROXY_TLS_CERT_DIR` (arquivos `fullchain.pem` e `privkey.pem`), redireciona
HTTP para HTTPS e substitui `X-Forwarded-For` pelo IP do peer; por isso o app
usa `TRUST_PROXY=1`. Réplicas são resolvidas pelo DNS do Compose no upstream.

O upstream nginx OSS usa falhas passivas (`max_fails`/`fail_timeout`); ele não
consulta o healthcheck `/readiness` do Compose. Scale e failover precisam ser
exercitados com Docker antes de afirmar remoção ativa de réplicas.

---

## 2. Ordem dos middlewares

A ordem em `src/app.ts:setupMiddleware` não é arbitrária:

```text
1. requestLogger      gera X-Request-Id e mede duração → alimenta o manifesto
2. express.json       limite de 100kb; erro de JSON inválido vira 400
3. normalizeInput     remove caractere de controle; NÃO toca em credencial
4. detectThreats      sinaliza padrão suspeito; NÃO bloqueia
5. advancedRateLimit  quem de fato bloqueia
```

`normalizeInput` vem antes de `detectThreats` de propósito: o monitor lê
`req.body`, e um payload com caractere de controle quebraria o `JSON.stringify`
que ele faz para casar os padrões.

`detectThreats` vem antes do rate limit porque é só observação: um evento
suspeito deve ser registrado mesmo que a requisição seja barrada em seguida.

---

## 3. Fluxo: registro

```text
POST /register
  → validateRegister          formato, tamanho, força da senha
  → AuthWebController.register
      → AuthService.register
          → normalizeUsername      trim + lowercase  (fonte única)
          → exists(username)       UserRepository
          → hash(plainText)        CryptoService (argon2id)
          → save(user)             UserRepository
      ← 201 { user }
```

Senha nunca é normalizada: é valor opaco, e transformá-la quebraria a
comparação com o hash.

---

## 4. Fluxo: login

```text
POST /login
  → validateLogin
  → AuthWebController.login
      → AuthService.authenticateUser
          → normalizeUsername
          → findByUsername          UserRepository
          → compare(senha, hash)    CryptoService
          → revogação disponível?   Redis (fail-closed)
             │  fora  ──► 503 REVOCATION_UNAVAILABLE  (não 401)
             ▼
          → generateTokenPair
      → securityAuditLogger.logLoginAttempt(rótulo canônico)
      ← 200 { accessToken, refreshToken } | 401 | 503
```

O rótulo do desfecho é decidido **uma vez**, em
`src/shared/utils/authOutcomes.ts`, e viaja pronto para a auditoria e para o
log estruturado. `/login` não distingue "usuário não encontrado" de "senha
errada" na resposta: distinguir enumeraria contas. A recusa por revogação
indisponível entra na auditoria como `unavailable`, não como falha de
credencial — o alerta de força bruta não pode disparar por causa de uma queda
do Redis. O `503` em vez de `401` existe para o status dizer "a culpa é da
infraestrutura" sem jamais revelar a causa na resposta.

---

## 5. Fluxo: refresh com consumo único

O caminho mais sensível do serviço.

```text
POST /refresh
  → validateRefresh
  → AuthWebController.refresh
      → AuthService.refreshSession
          → verifyRefreshToken      assinatura + expiração
          → revogado?               Redis: token_blacklist:jti:<jti>
             │  já rotacionado  ────┐
             │  já revogado (logout)│
             ▼                      │
        marca `rotated` com SET NX │  ← acontece ANTES de emitir
             │                      │
          falha                    └─► 401 REFRESH_TOKEN_REUSED
          sucesso                      401 REFRESH_TOKEN_INVALID
             │
          → verifyUser + versão da sessão (sv)
             │
          → emite par NOVO
      ← 200 { accessToken, refreshToken }
```

Duas requisições com o mesmo refresh token: uma recebe `200`, a outra `401
REFRESH_TOKEN_REUSED`. Um refresh token vazado e reutilizado é sempre
rejeitado — é essa a propriedade que o `SET NX` antes da emissão garante.

Se o Redis estiver fora, isso vira `503 REVOCATION_UNAVAILABLE` em produção
(fail-closed). Ver README, "Política de revogação quando o Redis está
indisponível".

---

## 6. Fluxo: logout

```text
POST /logout   (Authorization e/ou refreshToken, ambos opcionais)
  → AuthMiddleware.optionalAuth
  → AuthWebController.logout
      → resolve a identidade do refresh token PRIMEIRO
      → AuthService.endSession
          → revoga o refresh e, com ele, toda a sessão
             (access e refresh compartilham o dono da sessão)
      ← 200 { message } mesmo sem token nenhum
```

A ordem importa e já foi corrigida uma vez: resolver a identidade pelo access
token antes do refresh fazia um logout enviado **apenas com o refresh token**
deixar o access token vivo até expirar. Sem
nenhum token, a resposta é `200` com mensagem — não é erro do cliente, e
diferenciar revelaria se o par existia.

---

## 7. Fluxo: troca de senha

```text
PUT /password   (access token obrigatório)
  → validateChangePassword
  → AuthService.changePassword
      → compara a senha atual         (step-up)
      → nova senha não pode ser igual à anterior
      → grava o histórico da senha
      → revokeUserTokens(userId)      incrementa sv
  → todas as sessões, inclusive a atual, morrem
```

É a resposta a suspeita de comprometimento: troca de senha não deve deixar
sessão viva. O `sv` é contador, não relógio — comparação por timestamp
rejeitaria tokens emitidos no mesmo segundo da revogação, que é exatamente o
caso de quem acabou de trocar a senha.

---

## 8. Onde o estado mora

| Estado | Onde | Alcance | Perde ao reiniciar |
| --- | --- | --- | --- |
| Usuários | MongoDB | global | não |
| Blacklist de token | Redis `token_blacklist:*` | global | não |
| Versão de sessão | Redis `user_session_version:*` | global | não |
| Rate limit | Redis, com queda para memória | global, ou por worker se o Redis cair | a memória, sim |
| Eventos de auditoria | memória do processo | **por worker** | sim |
| Agregado de requisições | memória do processo | **por worker** | sim |

As duas últimas linhas são o limite honesto do desenho: com PM2 em cluster são N
cópias, não uma. O manifesto de `GET /observability` reporta o agregado do
processo que respondeu, e por isso ele é por processo.

Nenhum desses estados é alcançável sem credencial (decisão `D18` em
[SEGURANCA.md](SEGURANCA.md)). O Mongo autentica com um usuário `readWrite`
restrito ao banco do serviço (`authSource=admin`), criado na primeira
inicialização do volume; o Redis usa ACL com `user default off` e um usuário
nomeado sem `@admin`/`@dangerous`. As senhas chegam por arquivo
(`MONGODB_PASSWORD_PATH`/`REDIS_PASSWORD_PATH`), não pela URI, e em produção o
arranque recusa sem credencial e sem `MONGODB_TLS`/`REDIS_TLS` ou
`DEPENDENCY_NETWORK_ISOLATED=true` — a rede `deps-network` `internal` do compose
não publica porta e não dá rota para fora do host, que é a outra forma de o dado
não trafegar em claro.

---

## 9. Projeção em hardware grande (120 núcleos / 120 GB)

Seção **teórica**, por extrapolação a partir do que está medido em
[`metricas.md`](metricas.md) num i5-7200U com 4 núcleos, 2.0 CPU de orçamento e
1 GiB. Nenhum número aqui foi medido em máquina de 120 núcleos. O que muda é a
conclusão, e ela é contraintuitiva.

### O que escala e o que não escala

Medido em 4 CPU: o throughput do hash satura por **núcleo** (22/s → 37/s de c=1
para c=8, e c=32 não melhora), e `UV_THREADPOOL_SIZE` não interfere — o
`@node-rs/argon2` usa pool próprio. Então:

| Recurso | Comportamento ao crescer | Quem limita hoje |
| --- | --- | --- |
| Núcleos | escala ~linearmente até o limite de banda de memória | 2.0 CPU no compose |
| RAM | **não melhora throughput**; só permite `m` maior, e `m` maior custa CPU | não é o gargalo |
| `m` (memória por hash) | custo *linear em CPU* por hash | 64 MiB medido |
| `t` (passadas) | custo *linear em CPU* por hash | 1, no mínimo |
| `p` (paralelismo) | não dá ganho em servidor — divide o mesmo CPU | 1 |

**A consequência central: num servidor de 120 núcleos, o `/login` deixa de ser
limitado por CPU e o gargalo vira banda de memória.** Argon2id é memory-hard de
propósito — cada hash varre `m` KiB muitas vezes. Com 120 hashers em paralelo, a
soma é `120 × 64 MiB = 7.5 GB` varrendo a hierarquia de memória ao mesmo tempo.
Enquanto a máquina tiver RAM para absorver (`mem_limit` por worker × workers),
isso é rápido; quando o working set ultrapassa o que cabe em cache e o bandwidth
satura, mais núcleos **não** compram throughput. O ponto de virada é bandwidth de
memória, não contagem de núcleos.

Estimativa de ordem de grandeza, assumindo o custo de 36 ms/hash medido em
2.0 CPU e escalando por núcleo: `120 núcleos ÷ 36 ms ≈ 3.300 logins/s` de
teto **antes** de o bandwidth virar limite. Com 2.0 CPU de orçamento em 4
núcleos o serviço entregava ~22 logins/s, e a razão entre as duas estimativas
(150x) é o número de núcleos, não uma nova medição.

### O que teria que mudar no código

Nada da segurança. Três coisas de operação, nesta ordem de impacto:

1. **`cpus` do compose.** Continua em 2.0, então 118 dos 120 núcleos ficariam
   ociosos. Subir para o número de núcleos desejado é a mudança de maior
   retorno. Continua sendo decisão de disponibilidade: o resto da máquina
   (Mongo, Redis, TLS) disputa o mesmo hardware.

2. **`PM2_INSTANCES`.** O padrão é 4 workers (`ecosystem.config.cjs`), pensado
   para 4 núcleos. Com 120 núcleos e 2.0 CPU de orçamento, 4 workers é
   desperdício; o número de workers deve acompanhar o `cpus`, não o total de
   núcleos. Cada worker tem seu próprio heap, seu próprio agregado de
   `GET /observability` e sua própria memória de auditoria — a seção 8 mostra que
   esse estado é **por worker**, então mais workers significa mais estado não
   compartilhado, e é aí que a horizontalização cobra.

3. **Teto de memória do hash (`ARGON2_MEMORY_BUDGET_KIB`).** Hoje é uma
   constante de 768 MiB, derivada de `1 GiB de mem_limit − 256 MiB de folga`.
   Com 120 GB ela é uma constante sem significado: não muda sozinha com o hardware e
   a validação do arranque passaria a recusar configurações que caberiam folgadas
   num servidor grande. Hoje ela **impede** de usar a RAM do servidor, que é
   exatamente o recurso que o atacante não tem. Este é o ponto onde a decisão
   `D16` precisaria ser reavaliada com medição no hardware real, e não
   extrapolada: `m` maior só faz sentido se o objetivo declarado for resistir a
   ataque de dicionário com GPU, e isso é escolha de política, não de throughput.

### O que a aplicação faria, em uma frase

Com 120 núcleos e 120 GB, e com `cpus`, `PM2_INSTANCES` e o teto de memória
acompanhados, o serviço passaria de ~22 logins/s para uma casa de **milhares**,
com p95 de login perto do custo de um hash isolado (~36 ms) em vez dos 78.7 ms
medidos — porque a latência deixaria de ter fila de espera, que é onde ela
nasce hoje. E mesmo assim, **manter `m=64MiB, t=1` continua sendo a escolha
correta**: num servidor grande, memória ociosa não é problema, mas CPU por hash
ainda é, e o atacante paga a mesma tabela de custos que o servidor. A RAM extra
permitiria `m` maior, e essa é uma decisão de política de segurança a tomar com
medição própria, não um efeito de ter comprado hardware.

## Onde está o resto

- Decisões de segurança, threat model e riscos aceitos: [`SEGURANCA.md`](SEGURANCA.md)
- Comportamento de revogação, modelo de sessão e política de senha: [`../README.md`](../README.md)
- Guia do dashboard de segurança: [`DASHBOARD_SEGURANCA_GUIA.md`](DASHBOARD_SEGURANCA_GUIA.md)
- Números medidos e extrapolação de hardware: [`metricas.md`](metricas.md)
