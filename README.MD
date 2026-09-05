# Authentication Microservice

Projeto de portfólio em Node.js para demonstrar uma API de autenticação com arquitetura hexagonal, JWT (access + refresh), validação de senha, rate limiting com Redis, revogação de tokens e integração com MongoDB/Redis.

> Este repositório é uma demonstração de arquitetura e organização de código. Não representa uma solução de autenticação pronta para produção sem revisão adicional e ajustes específicos do ambiente.

## O que o projeto inclui

- registro, autenticação e perfil de usuários
- JWT com access token, refresh token, revogação pontual e revogação por usuário (blacklist no Redis)
- fluxo HTTP completo de renovação/revogação: `POST /refresh` e `POST /logout`
- política única de username: 3 a 30 caracteres, apenas letras, números, `_` e `-` (fonte única em `shared/utils/usernamePolicy.js`)
- validação de senha com política forte (12+ caracteres, complexidade, lista de senhas comuns)
- rate limiting por IP e por login, com backend Redis e fallback em memória
- monitoramento auxiliar de segurança com limites de memória (auditoria e anomalias sem crescimento ilimitado)
- health check e métricas Prometheus (endpoint de métricas protegível via `METRICS_TOKEN`)
- documento Swagger e resposta HTTP padronizada via `HttpError`
- testes unitários e de integração (176 testes em 25 suítes)
- CI/CD com GitHub Actions onde **lint e audit falham o pipeline** quando há erros reais
- Docker Compose para desenvolvimento e produção, sem credenciais hardcoded (`.env.docker` / `.env.prod`)

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
├── app.js                    # Bootstrap da aplicação (init Redis, rate limiter, injeção no JWT)
├── core/                     # ServiceContainer (DI), bootstrap
├── application/              # controllers, middleware e rotas
│   ├── controllers/
│   ├── middleware/           # validação, rate limit, auditoria, monitoramento
│   └── routes/
├── domain/                   # entidades, validações e serviço de domínio
├── infrastructure/           # adapters (mongo/redis), JWT, cache
├── interfaces/               # config centralizada (app, rate limit, redis)
└── shared/                   # utils (health check, métricas, password, username policy)
```

Organização em arquitetura hexagonal: o domínio fica isolado, a aplicação orquestra casos de uso e a infraestrutura implementa as portas de cache, banco e JWT. A config Redis tem fonte única (`interfaces/config/redisConfig.js`), usada por `connection.js`, `appConfig` e `rateLimitConfig`.

## Endpoints principais

Base path configurável (padrão `/api`):

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

Rotas de segurança (auditoria/monitoramento) ficam em `src/application/routes/securityRoutes.js`.

A documentação Swagger fica disponível quando `SWAGGER_ENABLED=true`.

## Como rodar localmente

Com Docker:

```bash
npm install
cp .env.example .env
npm run docker:up   # sobe aplicação, MongoDB, Redis, Prometheus e Grafana (usa .env.docker)
npm run dev
```

Sem Docker:

```bash
npm install
cp .env.example .env
npm test
```

### Variáveis de ambiente

Copie [.env.example](.env.example) para `.env` e ajuste conforme seu ambiente.

Principais campos:

- `PORT`, `NODE_ENV`
- `URI_MONGODB`, `MONGODB_MAX_POOL_SIZE`
- `REDIS_URL` (preferida: `redis://:senha@host:6379/0`) ou o fallback `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`
- `JWT_SECRET`, `JWT_EXPIRES`, `JWT_REFRESH_EXPIRES`
- `ALLOWED_ORIGINS`
- `METRICS_ENABLED`, `METRICS_ENDPOINT`, `METRICS_TOKEN` (em produção, configure um token)
- `RATE_LIMIT_*_POINTS` (pontos por janela)

Nenhuma credencial real fica versionada: apenas exemplos (`.env.example` e `.env.prod.example`) são commitados; `.env`, `.env.docker` e `.env.prod` ficam no `.gitignore`.

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
5. **deploy**: staging (branch `develop`) e produção (branch `main`) com blue-green

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