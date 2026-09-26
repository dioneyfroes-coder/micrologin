# Authentication Microservice

Projeto de portfólio em Node.js para demonstrar uma API de autenticação com arquitetura hexagonal, JWT (access + refresh), validação de senha, rate limiting com Redis, revogação de tokens e integração com MongoDB/Redis.

> Este repositório é uma demonstração de arquitetura e organização de código. Não representa uma solução de autenticação pronta para produção sem revisão adicional e ajustes específicos do ambiente.

## O que o projeto inclui

- registro, autenticação e perfil de usuários
- identidade única e case-insensitive: username é normalizado (`trim` + `lowercase`) em registro, login, atualização e consulta ao banco
- JWT com access token, refresh token, revogação pontual e revogação por usuário (blacklist no Redis)
- fluxo HTTP completo de renovação/revogação: `POST /refresh` e `POST /logout`
- política única de username: 3 a 30 caracteres, apenas letras, números, `_` e `-` (fonte única em `shared/utils/usernamePolicy.ts`)
- validação de senha com política forte (12+ caracteres, complexidade, lista de senhas comuns)
- rate limiting por IP e por login, com backend Redis e fallback em memória quando o Redis está indisponível
- monitoramento auxiliar de segurança com limites de memória (auditoria e anomalias sem crescimento ilimitado)
- health check e métricas Prometheus (endpoint de métricas protegível via `METRICS_TOKEN`)
- documento Swagger e resposta HTTP padronizada via `HttpError`
- suítes de testes unitários, integração e E2E
- CI/CD com GitHub Actions onde **lint e audit falham o pipeline** quando há erros reais
- Docker Compose para desenvolvimento e produção, sem credenciais hardcoded (`.env.prod`)

## Stack

- Node.js 22+
- Express
- MongoDB + Mongoose
- Redis (node-redis 5)
- JWT (jsonwebtoken)
- bcrypt
- Jest
- Docker / Docker Compose
- GitHub Actions

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
└── shared/                   # utils (health check, métricas, password, username policy)
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
| PUT    | `/update`      | Bearer                 | Atualiza username/senha                   |
| DELETE | `/delete`      | Bearer                 | Remove o usuário                          |
| GET    | `/health`      | —                      | Health check                              |
| GET    | `/metrics`     | `METRICS_TOKEN` (opcional) | Métricas Prometheus                   |
| GET    | `/observability` | `METRICS_TOKEN` (opcional) | Snapshot JSON de observabilidade **por logs** (janela rolante de requisições: volumes, P50/P95/P99, taxas de erro, top rotas) + health + segurança + memória/uptime. Path próprio, sem coletor externo. |
| GET    | `/security/*` | `SECURITY_DASHBOARD_TOKEN` | Dashboard, auditoria e diagnóstico de segurança |

Rotas de segurança (auditoria/monitoramento) ficam em `src/application/routes/securityRoutes.ts` (montadas em `/security/*`) e exigem o header `X-Security-Token`. Um guia prático de uso do dashboard de segurança está em [`docs/DASHBOARD_SEGURANCA_GUIA.md`](docs/DASHBOARD_SEGURANCA_GUIA.md), com exemplos em [`examples/`](examples).

Falhas de login retornam `401 AUTHENTICATION_FAILED` com a mensagem `Credenciais inválidas`; falhas de registro retornam `400 REGISTRATION_FAILED` com a mensagem `Não foi possível criar a conta`, sem revelar se a conta existe.

O username é a identidade da conta e é normalizado para minúsculas em todas as entradas (registro, login, atualização e consulta ao banco): `Alice`, `alice` e `  ALICE  ` são a mesma conta. A senha é um valor opaco e nunca é transformada (sem escaping, sem "sanitização"): o que o cliente envia é exatamente o que é validado e hasheado.

## Política de revogação quando o Redis está indisponível

A blacklist de tokens e a revogação por usuário vivem no Redis. O que acontece quando ele cai é uma decisão explícita, controlada por `SESSION_FAIL_OPEN`:

| `SESSION_FAIL_OPEN` | Comportamento |
| --- | --- |
| `false` (padrão em produção) | **fail-closed**: verificação de token, `POST /refresh` e `POST /logout` respondem `503 REVOCATION_UNAVAILABLE` em vez de aceitar tokens sem controle de revogação |
| `true` (padrão em dev/test) | **fail-open**: o serviço continua disponível e a revogação é degradada (com log explícito do risco) |

Erros do próprio Redis (conexão perdida, `isReady: false`) seguem a mesma política, e a recuperação é automática quando o Redis volta. O rate limiting tem decisão própria: cai para o armazenamento em memória **por processo**, portanto não é global entre workers — trate-o como proteção de borda, não como controle distribuído.

## Modelo de sessão

- **Identidade do token:** cada JWT recebe um `jti` próprio (inclusive access e refresh, que não compartilham identificador). A blacklist é chaveada por `token_blacklist:jti:<jti>` — o token completo nunca é usado como chave de armazenamento. Tokens legados sem `jti` caem para `token_blacklist:sha256:<hash>` e também são consultados na chave antiga, durante a transição.
- **Validade da entrada:** o TTL da blacklist é o menor entre o solicitado e o tempo de vida restante do token, ou seja, a entrada morre com o token.
- **Rotação de refresh com consumo único:** `POST /refresh` grava o marcador `rotated` com `SET NX` **antes** de emitir o novo par. Duas requisições simultâneas com o mesmo refresh token resultam em uma `200` e uma `401` (`REFRESH_TOKEN_REUSED`); se o token já havia sido revogado por logout, a resposta é `REFRESH_TOKEN_INVALID`. Um refresh token vazado e reutilizado é, portanto, sempre rejeitado.
- **Revogação por usuário:** `logout` também registra `user_tokens_revoked:<userId>`, que invalida todos os tokens emitidos antes do logout (inclusive os que nunca passaram pela blacklist).

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
  "security": { "riskLevel": "MINIMAL", "blockedRequests": 0, "failedLogins": 1 },
  "logging": { "format": "structured", "level": "info", "request_id_header": "X-Request-Id" }
}
```

A fonte do snapshot é a mesma dos logs estruturados (`requestLogger` alimenta um agregador em memória em `src/application/observability/`): nada depende de coletor externo. Erros de parsing JSON de payload agora respondem **400 `INVALID_JSON`** (antes 500, inflando a taxa de 5xx).

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
- `REDIS_URL` (preferida: `redis://:senha@host:6379/0`) ou o fallback `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`
- `JWT_SECRET`, `JWT_REFRESH_SECRET` (obrigatório e **diferente** de `JWT_SECRET` em produção; sem fallback silencioso), `JWT_EXPIRES`, `JWT_REFRESH_EXPIRES`
- `SESSION_FAIL_OPEN` (política de revogação sem Redis; padrão `false` em produção)
- `ALLOWED_ORIGINS`
- `METRICS_ENABLED`, `METRICS_ENDPOINT`, `METRICS_TOKEN` (em produção, configure um token)
- `SECURITY_DASHBOARD_TOKEN` (obrigatório em produção; envia-se no header `X-Security-Token`)
- `RATE_LIMIT_*_POINTS` (pontos por janela)

Nenhuma credencial real fica versionada: apenas exemplos (`.env.example` e `.env.prod.example`) são commitados; `.env` e `.env.prod` ficam no `.gitignore`.

## Testes

```bash
npm test                    # toda a suite (unit + integração)
npm run test:unit           # suítes unitárias
npm run test:integration    # suíte de integração
npm run test:coverage       # cobertura (text + html + lcov)
npm run lint                # ESLint em src/ e tests/
```

O pipeline de CI usa `test:unit:fast`, `test:integration:app` e `test:coverage:fast` (com `--runInBand` para CI).

## CI/CD

O workflow [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) executa:

1. **code-quality**: ESLint, `npm audit` e `audit-ci` — **falham o pipeline** quando encontram erros reais (sem `continue-on-error`)
2. **tests**: unitários rápidos, integração e upload de cobertura para Codecov
3. **build**: build e push da imagem multi-plataforma (amd64/arm64) para GHCR
4. **security**: scan de vulnerabilidades com Trivy
5. **deploy**: jobs de staging e produção existem como template; o deploy real e o blue-green ainda não estão implementados

### Política de branches (main-only)

- apenas a branch `main` existe; **sem** `develop` ou `feature/*`
- no GitHub, a proteção da `main` (PR + code review + checks de CI) é uma recomendação de operação e depende da configuração externa; ela não está aplicada pelo repositório
- branches de trabalho são **efêmeras**: criadas para um PR pequeno e apagadas após o merge em `main`
- o CI dispara em push/PR para `main`; os jobs de deploy também disparam no push à `main`, mas hoje são placeholders

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