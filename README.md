# Authentication Microservice

Projeto de portfólio em Node.js para demonstrar uma API de autenticação com arquitetura hexagonal, JWT (access + refresh), validação de senha, rate limiting com Redis, revogação de tokens e integração com MongoDB/Redis.

**Versão:** `1.0.0` — primeira versão estável do serviço. O que fecha uma versão
estável aqui está registrado em
[`MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md`](MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md):
significa suíte de release verde e limitações conhecidas declaradas — em
particular o [limite D20 da revogação](docs/SEGURANCA.md#d20--revogação-em-nó-único-o-limite-aceito-e-o-que-fecha-a-lacuna).
Não significa "pronto para SaaS em escala ilimitada".

> Este repositório é uma demonstração de arquitetura e organização de código. Não representa uma solução de autenticação pronta para produção sem revisão adicional e ajustes específicos do ambiente.

## O que o projeto inclui

- registro, autenticação e perfil de usuários
- identidade única e case-insensitive: username é normalizado (`trim` + `lowercase`) em registro, login, atualização e consulta ao banco
- JWT com access token, refresh token, revogação pontual e revogação por usuário (blacklist no Redis)
- fluxo HTTP completo de renovação/revogação: `POST /refresh` e `POST /logout`
- política única de username: 3 a 30 caracteres, apenas letras, números, `_` e `-` (fonte única em `shared/utils/usernamePolicy.ts`)
- hash de senha em **argon2id** (m=64MiB, t=1, p=1), único algoritmo do projeto, com reescrita silenciosa quando os parâmetros mudam — 3.4x a memória por tentativa do atacante em relação aos mínimos da OWASP, com a mesma latência de login ([D16](docs/SEGURANCA.md))
- parâmetros do hash validados contra o `mem_limit` do container no arranque, e alerta de memória do `/health` como fração desse mesmo teto
- como o serviço se comportaria em hardware grande (120 núcleos / 120 GB): extrapolação a partir de medição real, em [`ARQUITETURA.md`](docs/ARQUITETURA.md#9-projeção-em-hardware-grande-120-núcleos--120-gb)
- política de senha forte em fonte única (12+ caracteres, máximo de 72 bytes, composição, lista de senhas comuns) e troca de senha com step-up, histórico de 5 hashes e encerramento das sessões
- rate limiting por IP e por login, com backend Redis e fallback em memória quando o Redis está indisponível
- monitoramento auxiliar de segurança com limites de memória (auditoria e anomalias sem crescimento ilimitado)
- health check e manifesto de observabilidade por logs (protegível via `METRICS_TOKEN`)
- documento Swagger e resposta HTTP padronizada via `HttpError`
- suítes de testes unitários, integração e E2E
- CI/CD com GitHub Actions onde **lint e audit falham o pipeline** quando há erros reais
- Docker Compose para desenvolvimento e produção, sem credenciais hardcoded (`.env.prod`)

## Stack

- Node.js 22+
- Express
- MongoDB + Mongoose
- Redis (node-redis 5)
- JWT (jsonwebtoken / jose)
- argon2id (@node-rs/argon2)
- Jest
- Docker / Docker Compose
- GitHub Actions

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | camadas, ordem dos middlewares, fluxo de login/refresh/logout e onde o estado mora |
| [`docs/SEGURANCA.md`](docs/SEGURANCA.md) | threat model, riscos aceitos e log de decisões (o que foi decidido e o que foi recusado) |
| [`docs/ROTACAO.md`](docs/ROTACAO.md) | rotação da chave ES256, do pepper e das senhas de Mongo/Redis, e onde o material privado deve viver |
| [`docs/BACKUP.md`](docs/BACKUP.md) | backup/restauração do Mongo (Fase 2.1): RPO/RTO medidos, retenção, `--check` de alerta e o drill |
| [`docs/REDIS.md`](docs/REDIS.md) | o que o Redis guarda e o que se perde sem ele (Fase 2.2): persistência da revogação, RPO/RTO medidos, por que não há backup de Redis |
| [`docs/CONFIG.md`](docs/CONFIG.md) | backup/restauração da configuração EM EXECUÇÃO (Fase 2.3): container é a fonte da verdade, dono dos segredos, rollback de imagem+config e o drill |
| [`docs/DASHBOARD_SEGURANCA_GUIA.md`](docs/DASHBOARD_SEGURANCA_GUIA.md) | como usar `GET /security/*` e o dashboard |
| [`MICROLOGIN_ANALISE_E_ROADMAP.md`](MICROLOGIN_ANALISE_E_ROADMAP.md) | análise e plano de fases executado |

---

## Estrutura principal

```text
src/
├── app.ts                    # Bootstrap da aplicação (init Redis, rate limiter, injeção no JWT)
├── core/                     # ServiceContainer (DI), bootstrap
├── application/              # controllers, middleware e rotas
│   ├── controllers/
│   ├── middleware/           # validação, normalização de entrada, rate limit, auditoria, monitoramento
│   └── routes/
├── domain/                   # entidades, validações e serviço de domínio
├── infrastructure/           # adapters (mongo/redis), JWT, cache
├── interfaces/               # config centralizada (app, rate limit, redis)
└── shared/                   # utils (health check, logger, auth outcomes, password/username policy)
```

Organização em arquitetura hexagonal: o domínio fica isolado, a aplicação orquestra casos de uso e a infraestrutura implementa as portas de cache, banco e JWT. A config Redis tem fonte única (`interfaces/config/redisConfig.ts`), usada por `connection.ts`, `appConfig` e `rateLimitConfig`.

## Endpoints principais

As rotas são montadas na raiz da aplicação:

| Método | Rota       | Proteção               | Descrição                                  |
| ------ | ---------- | ---------------------- | ------------------------------------------ |
| POST   | `/register`    | —                      | Cria usuário (username + senha forte)    |
| POST   | `/login`       | rate limit login       | Autentica e emite access + refresh token |
| POST   | `/refresh`     | —                      | Renova o par de tokens via refresh token |
| POST   | `/logout`      | opcional (Bearer)      | Revoga access token, refresh token e tokens do usuário |
| GET    | `/profile`     | Bearer                 | Obtém perfil do usuário                   |
| PUT    | `/update`      | Bearer                 | Atualiza apenas o username               |
| PUT    | `/password`    | Bearer                 | Troca a senha (exige a atual) e encerra as sessões |
| DELETE | `/delete`      | Bearer                 | Remove o usuário                          |
| GET    | `/health`      | —                      | Health check detalhado (Mongo, Redis, memória, uptime) |
| GET    | `/liveness`    | —                      | Liveness: 200 se o processo responde. Não consulta dependência. |
| GET    | `/readiness`   | —                      | Readiness: 200 com Mongo de pé, 503 sem. Redis degradado não tira de prontidão. |
| GET    | `/observability` | `METRICS_TOKEN` (opcional) | Snapshot JSON de observabilidade **por logs** (janela rolante de requisições: volumes, P50/P95/P99, taxas de erro, top rotas) + health + segurança + memória/uptime. Path próprio, sem coletor externo. |
| GET    | `/security/*` | `SECURITY_DASHBOARD_TOKEN` | Dashboard, auditoria e diagnóstico de segurança |

Rotas de segurança (auditoria/monitoramento) ficam em `src/application/routes/securityRoutes.ts` (montadas em `/security/*`) e exigem o header `X-Security-Token`. Um guia prático de uso do dashboard de segurança está em [`docs/DASHBOARD_SEGURANCA_GUIA.md`](docs/DASHBOARD_SEGURANCA_GUIA.md), com exemplos em [`examples/`](examples).

Falhas de login retornam `401 AUTHENTICATION_FAILED` com a mensagem `Credenciais inválidas`; falhas de registro retornam `400 REGISTRATION_FAILED` com a mensagem `Não foi possível criar a conta`, sem revelar se a conta existe. A única exceção é a recusa por **indisponibilidade de revogação** (Redis fora, fail-closed): login devolve `503 REVOCATION_UNAVAILABLE` — o corpo continua genérico, mas o status diz "a culpa é nossa, tente de novo", em vez de "a senha está errada".

O username é a identidade da conta e é normalizado para minúsculas em todas as entradas (registro, login, atualização e consulta ao banco): `Alice`, `alice` e `  ALICE  ` são a mesma conta. A senha é um valor opaco e nunca é transformada (sem escaping, sem "sanitização"): o que o cliente envia é exatamente o que é validado e hasheado.

## Política de revogação quando o Redis está indisponível

A blacklist de tokens e a revogação por usuário vivem no Redis. O que acontece quando ele cai é uma decisão explícita, controlada por `SESSION_FAIL_OPEN`:

| `SESSION_FAIL_OPEN` | Comportamento |
| --- | --- |
| `false` (padrão em produção) | **fail-closed**: verificação de token, `POST /refresh` e `POST /logout` respondem `503 REVOCATION_UNAVAILABLE` em vez de aceitar tokens sem controle de revogação |
| `true` (padrão em dev/test) | **fail-open**: o serviço continua disponível e a revogação é degradada (com log explícito do risco) |

Erros do próprio Redis (conexão perdida, `isReady: false`) seguem a mesma política. A conexão **nunca desiste** de reconectar (backoff dobrando, teto 5s): quem tem prazo de vida é o processo, não a conexão, e uma queda de meio segundo não pode deixar a autenticação devolvendo 503 até alguém reiniciar o container. O health check para de mentir quando o Redis cai: `/health` reporta `degrated` (via PING/PONG real, não lendo um cache que engole erro), `/readiness` continua `200` (o remédio é restaurar o Redis, não reiniciar o processo) e `/liveness` continua `200`. Quando o Redis volta, o serviço se recupera sozinho — inclusive o rate limiting, que retorna ao armazenamento compartilhado.

O rate limiting tem decisão própria: cai para o armazenamento em memória **por processo** quando o Redis some (e sobe de volta quando ele volta). Enquanto em memória, o limite não é global entre workers — trate-o como proteção de borda, não como controle distribuído. A queda não vira mentira: um erro do **driver** (conexão recusada, cliente fechado) é distinguido do objeto de recusa do `rate-limiter-flexible`, então a indisponibilidade do Redis nunca responde `429` para o cliente nem entra na auditoria como "violação de rate limit".

## Modelo de sessão

- **Identidade do token:** cada JWT recebe um `jti` próprio (inclusive access e refresh, que não compartilham identificador). A blacklist é chaveada por `token_blacklist:jti:<jti>` — o token completo nunca é usado como chave de armazenamento. Tokens legados sem `jti` caem para `token_blacklist:sha256:<hash>` e também são consultados na chave antiga, durante a transição.
- **Validade da entrada:** o TTL da blacklist é o menor entre o solicitado e o tempo de vida restante do token, ou seja, a entrada morre com o token.
- **Rotação de refresh com consumo único:** `POST /refresh` grava o marcador `rotated` com `SET NX` **antes** de emitir o novo par. Duas requisições simultâneas com o mesmo refresh token resultam em uma `200` e uma `401` (`REFRESH_TOKEN_REUSED`); detectar reuso revoga todas as sessões do usuário, inclusive o par recém-emitido na disputa, e exige novo login. Se o token já havia sido revogado por logout, a resposta é `REFRESH_TOKEN_INVALID`. `AUTO_REVOKE_ON_REUSE=false` mantém a rejeição e o evento de segurança, mas desativa a revogação automática.
- **Revogação por usuário (versão de sessão):** o token carrega a claim `sv` e o Redis guarda `user_session_version:<userId>`, incrementado a cada revogação em massa. Token com versão anterior à atual é rejeitado. Contador, não relógio: comparação por timestamp rejeitaria tokens emitidos no mesmo segundo da revogação — que é justamente o caso de quem acabou de trocar a senha. Tokens emitidos antes dessa versão (sem `sv`) ainda usam a regra por timestamp em `user_tokens_revoked:<userId>`, que expira sozinha.

## Política de senha e troca de senha

A política está em um único objeto (`PASSWORD_POLICY`, em `src/shared/utils/passwordPolicy.ts`):

| Regra | Valor | Por quê |
| --- | --- | --- |
| Mínimo | 12 caracteres | acima do mínimo de 8 da NIST, já que há exigência de composição |
| Máximo | **72 bytes** | o argon2id não trunca, então o teto é escolha do serviço: protege de entrada desnecessariamente grande e mantém a política estável em vez de mudar junto com o algoritmo (D16) |
| Composição | maiúscula, minúscula, número, símbolo | camada extra à checagem de senha comum |
| Senhas comuns | 27 entradas, sem diferenciar caixa | cobre o caso offline, sem rede no caminho de registro |
| Expiração | nunca | rotação forçada empurra para padrões piores (NIST SP 800-63B) |
| Histórico | 5 hashes (FIFO) | impede reuso sem guardar um arquivo de credenciais |

Senha é valor opaco: nenhum limite, escape ou normalização é aplicado ao valor que vai para o hash.

`PUT /password` exige a **senha atual** (step-up) — um access token vazado não basta para tomar a conta permanentemente. Ao trocar:

1. a senha anterior vai para o histórico e `passwordChangedAt` é atualizado;
2. reuso da senha atual ou de qualquer uma das últimas 5 é recusado (`PASSWORD_REUSED`);
3. **todas as sessões são encerradas**: os tokens emitidos antes da troca deixam de valer e é preciso fazer login de novo.

### Reescrita de hash no login

O `compare` lê os parâmetros do hash guardado. Se eles estiverem mais fracos que
os em vigor, o login **reescreve o hash com os parâmetros atuais na mesma
requisição** — depois de a senha ser provada, que é o único momento em que ela
está em claro. Subir `ARGON2_MEMORY_COST` ou `ARGON2_TIME_COST` endurece a base
sem travar ninguém e sem pedir troca de senha. Não há campo novo no documento
nem tabela de migração.

Reescrever o hash não é trocar senha: o histórico de senhas e
`passwordChangedAt` ficam intactos, e as sessões do usuário **não** são
encerradas. Se a escrita falhar, o login é entregue normalmente e a tentativa se
repete no próximo acesso.

O algoritmo é fixo: argon2id é o único caminho de gravação e de verificação, e
não há variável de ambiente para trocá-lo.

`PUT /update` atualiza somente o username; enviar `password` nesse endpoint é recusado com `400`.

Exemplo do `/observability`:

```bash
curl -H "x-metrics-token: $METRICS_TOKEN" http://localhost:3000/observability
curl -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" http://localhost:3000/security/stats
```

```json
{
  "service": { "name": "auth-service", "version": "43fa497027ef-...", "environment": "production" },
  "requests": {
    "total": 1024,
    "by_status": { "200": 1010, "401": 11, "500": 3 },
    "errors": { "4xx": 11, "5xx": 3, "rate_pct": 1.37 },
    "latency_ms": { "p50": 6.2, "p95": 22.1, "p99": 48.9 },
    "by_route": [{ "method": "POST", "route": "/login", "count": 501 }]
  },
  "health": { "status": "healthy", "services": { "mongodb": { "status": "healthy" }, "redis": { "status": "healthy" } } },
  "security": { "riskLevel": "MINIMAL", "blockedRequests": 0, "failedLogins": 1, "unavailableLogins": 0 },
  "logging": { "format": "structured", "level": "info", "request_id_header": "X-Request-Id" }
}
```

A fonte do snapshot é a mesma dos logs estruturados (`requestLogger` alimenta um agregador em memória em `src/application/observability/`): nada depende de coletor externo. Erros de parsing JSON de payload agora respondem **400 `INVALID_JSON`** (antes 500, inflando a taxa de 5xx).

### Eventos de autenticação

Cada evento de login, renovação de token e troca de senha é publicado **já com o desfecho traduzido**, num vocabulário fechado definido em `src/shared/utils/authOutcomes.ts`:

```text
login           → success | failure | unavailable | error
token_refresh   → success | invalid | reused | unavailable | error
password_change → success | current_password_invalid | rejected | error
```

`reused` (refresh reaproveitado) é separado de `invalid` porque reuso é sinal de comprometimento, não erro de usuário; `unavailable` é separado de `failure`/`invalid` porque "não deu para revogar" (Redis fora) e "a credencial é ruim" são operações diferentes. Valor fora da lista vira `error`, para não criar cardinalidade infinita de rótulos.

A tradução acontece uma única vez, em `authEventSink`, que publica o evento estruturado no fluxo de logs (`auth_kind`, `auth_outcome`, `auth_code`). O destino é uma porta: `setAuthEventSink` troca quem consome sem tocar nos chamadores, e nem o domínio sabe que existe consumidor. Não há scrape, coletor nem formato de saída embutido — o manifesto de `/observability` e os logs estruturados são o que existe hoje.

O mesmo cuidado vale para a auditoria: `loginAttempts` é sempre a soma de
`successfulLogins`, `failedLogins` e `unavailableLogins` — uma queda do Redis
não aparece como pico de senha errada no alerta de força bruta.

O `X-Request-Id` enviado pelo cliente só é aceito se for um UUID válido (máx. 36 caracteres); caso contrário, o serviço descarta o valor, registra o descarte e gera o próprio id — o id de requisição é chave de correlação de alerta, não campo livre de cliente.

A documentação Swagger fica disponível quando `SWAGGER_ENABLED=true`.

## Como rodar localmente

Com Docker:

```bash
cp .env.example .env   # opcional — o compose já injeta as variáveis dev
npm run docker:up       # sobe auth-service + MongoDB + Redis (hot reload via tsx)
```

> Portas publicadas pelo compose dev: `3000` (API), `27017` (MongoDB), `6379` (Redis).
> O container de dev roda `npm run dev` (tsx watch) e monta `./src` em `/app/src`.

Sem Docker:

```bash
npm install
cp .env.example .env
npm run dev            # NODE_ENV=development, tsx watch
npm test
```

### Variáveis de ambiente

Copie [.env.example](.env.example) para `.env` e ajuste conforme seu ambiente.

Principais campos:

- `PORT`, `NODE_ENV`
- `URI_MONGODB`, `MONGODB_MAX_POOL_SIZE`
- `MONGODB_USER`, `MONGODB_PASSWORD` (ou `MONGODB_PASSWORD_PATH`), `MONGODB_AUTH_SOURCE`, `MONGODB_TLS` — credencial das dependências por arquivo (Fase 1.3; obrigatória em produção)
- `REDIS_URL` (preferida: `redis://host:6379/0`, com a senha vinda de arquivo) ou o fallback `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`
- `REDIS_USERNAME`, `REDIS_PASSWORD_PATH`, `REDIS_TLS` — usuário de ACL e senha por arquivo
- `DEPENDENCY_NETWORK_ISOLATED` (`true` declara rede dedicada sem porta publicada como transporte; no lugar de `MONGODB_TLS`/`REDIS_TLS`)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` (obrigatório e **diferente** de `JWT_SECRET` em produção; sem fallback silencioso), `JWT_EXPIRES`, `JWT_REFRESH_EXPIRES`
- `SESSION_FAIL_OPEN` (política de revogação sem Redis; padrão `false` em produção)
- `ALLOWED_ORIGINS`
- `METRICS_TOKEN` (em produção, configure um token: protege o manifesto de `/observability`)
- `TRUST_PROXY` (padrão `false`: não confiar em `X-Forwarded-For`; atrás de proxy, use o número de saltos ou a faixa CIDR do proxy). `true` em produção **recusa o arranque**: a confiança em toda a cadeia só é segura com um proxy reverso que reescreva o cabeçalho, e `TRUST_PROXY_ALLOW_UNRESTRICTED=true` é o opt-in explícito para quem assume essa responsabilidade
- `PROXY_TLS_CERT_DIR` (Compose de produção: diretório externo com `fullchain.pem`/`privkey.pem` para nginx; HTTPS publicado em 443)
- `INSTANCE_ID` (opcional; identifica uma réplica em `/observability`; por default usa hostname do container)
- `HTTP_HEADERS_TIMEOUT`, `HTTP_REQUEST_TIMEOUT`, `HTTP_KEEP_ALIVE_TIMEOUT`, `HTTP_CONNECTIONS_CHECKING_INTERVAL`, `HTTP_LISTEN_BACKLOG`, `HTTP_MAX_REQUESTS_PER_SOCKET`, `HTTP_MAX_HEADERS_COUNT` (limites de headers, recebimento e reutilização de conexões Node; defaults no `.env.prod.example`)
- `NET_CORE_SOMAXCONN` (backlog do kernel nos containers de produção; default 4096)
- `SECURITY_DASHBOARD_TOKEN` (obrigatório em produção; envia-se no header `X-Security-Token`)
- `RATE_LIMIT_*_POINTS` (pontos por janela)

Nenhuma credencial real fica versionada: apenas exemplos (`.env.example` e `.env.prod.example`) são commitados; `.env` e `.env.prod` ficam no `.gitignore`. Os segredos das dependências são gerados por `scripts/generate-dependency-secrets.sh <dir> --for-container` (Mongo/Redis) e `scripts/generate-jwt-keys.sh <dir> <kid> --for-container` (ES256), e nunca entram no repositório. A rotação é `scripts/rotate-dependency-secrets.sh <dir> --for-container` (Redis com janela, Mongo com `--mongo-only`), e a ordem de cada troca está em [`docs/ROTACAO.md`](docs/ROTACAO.md). O backup do Mongo é cifrado com a passphrase em `--passphrase-file` e nunca em linha de comando — ver [`docs/BACKUP.md`](docs/BACKUP.md).

## Testes

```bash
npm test                    # toda a suite (unit + integração)
npm run test:unit           # suítes unitárias
npm run test:integration    # suíte de integração
npm run test:e2e            # E2E contra MongoDB e Redis reais (sobe via compose)
npm run test:infra          # resiliência de infraestrutura (derruba Redis e container de verdade)
npm run test:backup         # backup/restauração do Mongo de ponta a ponta (apaga o banco e restaura)
npm run test:redis          # persistência da revogação (revoga, reinicia o Redis e exige que continue revogado)
npm run test:config-backup  # backup/restauração da config EM EXECUÇÃO (devolve o valor do container, não o do disco)
npm run test:secrets        # varredura de segredo: gitleaks + material/.env versionado
npm run test:ddos           # stack efêmero: k6 + oversized/malformed + Slowloris + recuperação
npm run test:coverage       # cobertura (text + html + lcov)
npm run test:capacity       # baseline de capacidade por endpoint (k6 + RSS/heap)
npm run lint                # ESLint em src/ e tests/
```

`test:capacity` (`scripts/capacity-baseline.sh`) mede quanto **um** worker aguenta,
com o stack de produção e k6 dentro do Docker:

```bash
npm run test:capacity -- --workers 1 --vus 100,200,400 \
  --endpoints health,login,refresh,register --duration 60s
```

Ele sobe o rate limit só durante a medição (medir 429 é medir o limiter, não o
endpoint), semeia os usuários de login, amostra `/observability` e
`docker stats` durante a carga, e no fim apaga as chaves `rl_*`, os usuários de
teste e devolve o container ao `.env.prod`. `--max-in-flight` varia o teto do
disjuntor de concorrência (default 1024) para medir o efeito dele. O bruto fica em `artifacts/`
(ignorado pelo git) e a tabela interpretada em
[`docs/metricas.md`](docs/metricas.md) §3. O último baseline: **22 logins/s por
2.0 CPU** (argon2id), e `/refresh` perdendo vazão em 400 VUs.

`test:ddos` inicia o perfil `ddos` do stack isolado, cria chaves/senhas/certificado
temporários e os remove junto com os volumes ao terminar. Requer Docker Compose
v2, Bash, OpenSSL e k6. O destino é somente loopback; o cenário recusa hosts
externos. `DDOS_VUS`/`DDOS_DURATION` ajustam a carga e `DDOS_BASE_URL` muda a
porta local do proxy.

`test:infra` (`scripts/infra-resilience-test.sh`) sobe um stack isolado com a
imagem de produção, para o Redis no meio do teste e reinicia o container,
observando o serviço por HTTP:

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

`test:secrets` (`scripts/secret-scan.sh`) roda as três checagens que não são a
mesma coisa: gitleaks no conteúdo **e no histórico** (é o que acha segredo pelo
formato, inclusive no que já foi apagado), material de segredo no índice do git
(`git ls-files` — o `.gitignore` não protege contra `git add -f`), e valor de
credencial em `.env*` versionado, que tem que ser vazio, um caminho de arquivo ou
um placeholder. É o mesmo comando no CI e local, e é ele que impede a chave nova
de acabar num `.env` commitado. A rotação de chaves e senhas está descrita em
[`docs/ROTACAO.md`](docs/ROTACAO.md).

`test:backup` (`scripts/test-backup.sh`) é o drill da Fase 2.1: sobe um stack
isolado, **cria um usuário, tira o backup cifrado, apaga o banco de verdade,
prova que o login passou a falhar, restaura e exige que o mesmo usuário volte a
autenticar**. O `backup.sh` cifra o dump gpg AES-256 pela saída (nada em claro no
disco), verifica cada arquivo recém-criado (decifra + gzip + `mongorestore
--dryRun`), poda `N` diários + `M` semanas, grava o manifest `last-backup.json`
e expõe `--check` como gancho de alerta de backup velho. O `restore.sh` valida o
arquivo em `--dryRun` antes de tocar nos dados e restaura com `--drop`. Tudo —
RPO/RTO medidos, retenção, restauração pontual só com o dump cifrado — está em
[`docs/BACKUP.md`](docs/BACKUP.md).

`test:redis` (`scripts/test-redis-persistence.sh`) é o drill da Fase 2.2: sobe um
stack isolado, **revoga a sessão de um usuário, reinicia o container do Redis e
exige que o token revogado continue revogado** — com um segundo usuário de
controle, nunca revogado, que tem que continuar autenticando em 200. O controle
existe porque, sem ele, "401 depois do restart" seria ambíguo: o fail-closed
barraria tudo por indisponibilidade e o teste passaria por acidente. O Redis de
produção agora grava o estado de revogação com AOF `everysec` + snapshot RDB em
volume nomeado, porque o efeito de perder esse estado era silencioso — o token
revogado voltava a valer depois de um restart, sem erro e sem log. O que o Redis
guarda, o que cada chave custa perder, e por que não há backup dele estão em
[`docs/REDIS.md`](docs/REDIS.md).

`test:config-backup` (`scripts/test-config-backup.sh`) é o drill da Fase 2.3:
sobe um stack isolado com a **mesma topologia de mount de produção** (`/run/secrets`
e `/run/secrets-deps`), captura a configuração EM EXECUÇÃO, **edita o env file sem
redeployar** (o controle negativo — disco e container divergidos), apaga env e
segredos, restaura pelo metadata da imagem (o caminho que os deploys usam no
rollback) e prova em runtime que o app voltou a exibir a configuração capturada,
não a do disco editado. O `backup-config.sh` lê do container (fonte da verdade) e
registra dono/modo de cada segredo; o `restore-config.sh` valida sha/caminho antes
de escrever e reaplica o dono por container descartável. O rollback dos deploys
restaura a config **antes** de subir o compose (`deploy.sh` usa o mesmo tag;
`remote-deploy.sh` taggeia por digest e exige a passphrase). Runbook em
[`docs/CONFIG.md`](docs/CONFIG.md).

O pipeline de CI usa `test:unit:fast`, `test:integration:app`,
`test:coverage:fast` (com `--runInBand` para CI) e `test:secrets`. O `test:infra`,
o `test:backup`, o `test:redis` e o `test:config-backup` ficam fora do CI de
propósito: derrubam serviço de verdade, restauram um banco apagado e reiniciam o
Redis — o trabalho disso é provar que a versão que você está para implantar reage
como deve — rodados localmente ou no host de deploy, antes do corte. No lugar
desses drills, o CI fica com os gates de configuração
(`tests/unit/redis-persistence-config.test.ts` e
`tests/unit/config-backup-policy.test.ts`), que leem os composes e os scripts e
falham se as invariantes forem desligadas.

## CI/CD

O workflow [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) executa:

1. **code-quality**: ESLint, `npm audit` e `audit-ci` — **falham o pipeline** quando encontram erros reais (sem `continue-on-error`)

#### Política de imagem (Trivy)

O gate do Trivy é sobre a **imagem inteira**, não sobre o código: pacote da base,
dependência da aplicação, o que estiver lá dentro. Três decisões, e o motivo de
cada uma:

**`exit-code: '1'`.** `exit-code` não tem default no `aquasecurity/trivy-action`.
Sem ele, o passo termina em 0 com a SARIF cheia de achados, o job fica verde e
o deploy segue, porque `deploy` depende de `security`. Relatório que ninguém lê
e barreira que nunca barra levam ao mesmo resultado: imagem vulnerável em
produção.

**`severity: 'HIGH,CRITICAL'`.** Um pouco mais permissivo que o `moderate` do
`audit-ci`, e a assimetria é deliberada. O `audit-ci` governa dependências que
este projeto escolhe e fixa em lockfile — dá para assumir a escolha. O Trivy
governa a imagem completa, incluindo pacotes da base que o projeto não controla,
onde MEDIUM é ruído frequente. Nenhum dos dois é mais forte sozinho e, juntos,
não deixam buraco: dependência da aplicação continua coberta a partir de
moderate. O `severity` filtra o que o gate considera; o relatório SARIF continua
completo.

**`ignore-unfixed: true`.** Bloquear por vulnerabilidade sem correção
disponível não torna o software mais seguro: torna o gate ignorável, porque não
existe ação que a equipe possa tomar. O achado continua aparecendo no SARIF; o
que reprova é o que dá para corrigir. Se um dia essa escolha não servir, é uma
linha.

Duas camadas de versão, porque pinar uma não pina a outra: `trivy-action` está
em `@v0.36.0`, e o motor vai em `version: 'v0.75.0'` — o action embute `v0.70.0`
por default, e deixar no default significa que vulnerabilidade disclosed depois
do `v0.70.0` não é detectada e o gate passa em silêncio. O `version` é input do
próprio action, então não entra um segundo action na cadeia de dependências.

#### Política de dependências

O gate é o `audit-ci`, com threshold **moderate**: reprova em moderate ou
superior. O `.audit-ci.json` declara **um** threshold só.

Isso é uma escolha com consequência, e vale saber por quê. No `audit-ci`, `low`,
`moderate`, `high` e `critical` não são quatro interruptores independentes: o
seletor devolve no primeiro `true`, na ordem `low > moderate > high > critical`.
Com as quatro em `true` — que era o estado anterior deste arquivo — valia
`low`, ou seja, reprovar por qualquer advisory de qualquer severidade, e as
outras três chaves eram configuração morta.

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
— e ignora esse registro **sem erro e sem efeito**: o gate continua reprovando pelo
mesmo advisory que "consta" na lista, e o diff parece innocuous. O que o
`schema.json` do audit-ci de fato define é `NSPRecord`: a chave é o advisory e o
valor é `{ active, expiry, notes }`. Foi o que a allowlist deste repositório
passou a usar, e `tests/unit/audit-ci-gate.test.ts` falha se a lista voltar ao
formato ignorado.

Hoje existe **uma** exceção, e ela é datada:

| advisory | pacote | validade | por quê |
| --- | --- | --- | --- |
| `GHSA-vfj7-8cjw-p6xm` | `braces <=3.0.3` | 2027-01-01 | ReDoS por stack exhaustion. A faixa vulnerável **inclui a última versão publicada**, então não há versão corrigida a instalar. Todo caminho é de `devDependencies` (`jest`/`micromatch`, `lint-staged`/`micromatch`, `pm2`/`chokidar`) e o padrão compilado vem de globs do próprio repositório em tempo de teste/lint, não de entrada de requisição. |

A exceção é por **advisory**, nunca por pacote: allowlist por nome de pacote
esconderia advisory nova do mesmo pacote, inclusive uma que já tivesse correção.
E o teste compara o conjunto `moderate+` da árvore com o conjunto allowlisted —
nem mais, nem menos — então advisory nova reprova e exceção que o tempo já
resolveu aparece como sobra a remover.

`npm audit --audit-level=moderate` roda no mesmo job. Ele é mais fraco que o
`audit-ci` (não tem mecanismo de exceção), então é o `audit-ci` que decide; ele
fica como relatório direto do registry. Por isso ele ainda sai vermelho com
`braces`, e isso é esperado: a única advisory `moderate+` da árvore é a que está
na tabela acima.
2. **tests**: unitários rápidos, integração e upload de cobertura para Codecov
3. **build**: build e push da imagem multi-plataforma (amd64/arm64) para GHCR
4. **security**: scan de vulnerabilidades com Trivy, na mesma referência de imagem que será implantada (o digest) — **reprova o pipeline** em HIGH/CRITICAL (`exit-code: '1'`, `ignore-unfixed: true`)
5. **deploy**: deploy real por SSH, apenas em `workflow_dispatch` (ver abaixo). Sem servidor configurado, o job falha com mensagem explícita em vez de reportar sucesso

### Deployment

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

Se o readiness não vier ou o smoke falhar, o script volta para a versão
anterior **e refaz o smoke nela** antes de dizer que voltou. Um 429 do rate
limit é tratado como inconclusivo: a versão nova fica no ar e o pipeline
acende vermelho para alguém decidir, porque reverter um deploy bom por limite
de capacidade trocaria um problema de taxa por uma indisponibilidade.

O smoke test ([`scripts/smoke-test.sh`](scripts/smoke-test.sh)) exercita o
serviço de verdade, porque um health check 200 numa instância que não
autentica ninguém é um deploy verde e inútil:

```bash
scripts/smoke-test.sh https://api.exemplo.com
```

Secrets por ambiente (staging e produção), todos com prefixo
`{STAGING|PRODUCTION}_`: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_KNOWN_HOSTS`, `DEPLOY_ENV_FILE`, `DEPLOY_COMPOSE_FILE`,
`DEPLOY_BASE_URL` e, se a imagem do GHCR for privada, `REGISTRY_USERNAME` e
`REGISTRY_TOKEN`. `DEPLOY_SSH_PORT` é opcional (default 22).

#### Como o ambiente é escolhido

O job `deploy` só roda em `workflow_dispatch`, e o ambiente vem **do input
`environment`** da tela de execução (`staging` ou `production`, obrigatório,
padrão `staging`):

1. o job resolve o prefixo dos secrets a partir do input
   (`production` → `PRODUCTION_*`, qualquer outro valor → `STAGING_*`);
2. o primeiro passo, **antes de qualquer acesso a rede**, compara o prefixo
   resolvido com o ambiente escolhido e aborta se divergirem;
3. só depois disso a chave SSH é instalada, o registry é authenticado e o
   servidor é contatado.

Uma execução toca **exatamente um** ambiente. O input não é uma preferência: ele
é a única fonte de verdade, e não existe caminho no qual o job leia secrets de
ambiente diferente do escolhido. Antes da 1.0.0 o job usava uma matrix fixa com
os dois ambientes e ignorava o input — escolher `staging` rodava staging **e**
produção, com os secrets de produção.

Os GitHub **Environments** (`staging` e `production`) seguem separados, e é
neles que se configura o que exige aprovação: uma regra de *required reviewers*
em `production` faz o deploy de produção esperar por revisão humana, o que o
workflow sozinho não pode garantir.

Deploy e produção saem com o mesmo caminho do restante do pipeline
(`scripts/remote-deploy.sh`: pull por digest, backup da versão em vigor,
`docker compose up -d`, espera por `/readiness`, smoke test e reversão
automática em caso de falha).

Para rodar o mesmo deploy localmente, sem CI:

```bash
scripts/remote-deploy.sh --image <imagem> --env-file .env.prod \
  --compose-file docker-compose.prod.yml --base-url http://localhost:3000
```

### Política de branches (main-only)

- apenas a branch `main` existe; **sem** `develop` ou `feature/*`
- no GitHub, a proteção da `main` (PR + code review + checks de CI) é uma recomendação de operação e depende da configuração externa; ela não está aplicada pelo repositório
- branches de trabalho são **efêmeras**: criadas para um PR pequeno e apagadas após o merge em `main`
- o CI dispara em push/PR para `main`; o **deploy só roda em `workflow_dispatch`**, porque não há servidor configurado neste repositório — um job de deploy que roda sozinho e imprime sucesso sem deployar é pior do que nenhum job

## Resiliência

- `npm run test:backup` prova dump cifrado, perda e restauração real do usuário no Mongo.
- `npm run test:redis` prova que revogações sobrevivem ao restart do Redis; perda do volume permanece risco documentado.
- `npm run test:credential-theft:unit` cobre T1–T6 com JWT real e Redis em memória, incluindo fail-closed. `npm run test:credential-theft` também executa E2E com Mongo/Redis reais.
- `npm run test:ddos` cria stack de resiliência efêmero e mede flood por rota, 429, liveness, malformed/oversized, Slowloris, memória, recuperação e `RestartCount`. É uma prova de host; requer Docker Compose, Bash, OpenSSL e k6.
- O Compose de produção contém nginx, TLS, limites de taxa/conexões e API sem porta pública. `nginx -t`, `docker compose --scale` e failover ainda precisam ser executados em host com Docker.

O preflight DDoS no CI só verifica que o alvo default é loopback e que hosts
externos são recusados; não dispara carga nem contata serviços.

## Observações importantes

- este projeto é um estudo de arquitetura e autenticação
- não substitui um provedor de identidade completo (Auth0, Keycloak, Cognito)
- o foco está em clareza, organização e demonstração de decisões técnicas
- os controles incluídos não devem ser tratados como solução de produção sem validação adicional de segurança e operação

## Licença

Copyright (c) 2026 Dioney Froes — Todos os direitos reservados.

Este é um projeto de código **proprietário**. O uso comercial, a
reprodução, modificação e distribuição do código, total ou parcial,
exigem autorização prévia e expressa por escrito do autor. As marcas
de procedência autoral (Provenance-ID: ML-7F29, ML-7F2A, ML-A31C)
devem ser preservadas. Consulte o arquivo [`LICENSE`](LICENSE).