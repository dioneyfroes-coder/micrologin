# Authentication Microservice

Projeto de portfolio em Node.js para demonstrar uma API de autenticação com estrutura organizada, JWT, validação de senha, rate limiting e integração com MongoDB/Redis.

Este repositório é uma demonstração de arquitetura e organização de código. Ele não representa uma solução de autenticação pronta para produção sem revisão adicional e ajustes específicos do ambiente.

## O que o projeto inclui

- registro e autenticação de usuários
- JWT com access token, refresh token e revogação
- validação de senha com política forte (12+ caracteres, complexidade, lista de senhas comuns)
- rate limiting por IP e login (Redis + fallback)
- sanitização básica de entradas
- middleware de auditoria e monitoramento
- health check e métricas Prometheus
- documento Swagger e resposta HTTP padronizada via `HttpError`
- testes unitários e de integração (148 testes em 21 suítes, cobertura global ~62%)
- CI/CD com GitHub Actions (lint, audit, testes, cobertura, build, scan, deploy)
- configuração com Docker Compose (dev sem segredos hardcoded e produção via `.env.prod`)

## Stack

- Node.js 22+
- Express
- MongoDB + Mongoose
- Redis
- JWT
- bcrypt
- Jest
- Docker / Docker Compose
- GitHub Actions

## Estrutura principal

```text
src/
├── app.js                    # Bootstrap da aplicação
├── core/                     # ServiceContainer (DI), bootstrap
├── application/              # controllers, middleware e rotas
│   ├── controllers/
│   ├── middleware/
│   └── routes/
├── domain/                   # entidades, validações e serviço de domínio
├── infrastructure/           # adapters (mongo/redis), JWT, cache
├── interfaces/               # config (helmet, rate limit, swagger), app
└── shared/                   # utils (health check, métricas, password)
```

A organização segue arquitetura hexagonal: o domínio fica isolado, a aplicação orquestra casos de uso e a infraestrutura implementa as portas de cache, banco e JWT. O objetivo é manter o código legível e testável.

## Pré-requisitos

- Node.js 22+
- npm
- Docker e Docker Compose
- MongoDB e Redis locais ou via containers

## Como rodar localmente

```bash
npm install
cp .env.example .env
npm run docker:up    # sobe aplicação, MongoDB, Redis e Grafana (usa .env.docker)
npm run dev
```

Ou, sem Docker:

```bash
npm install
cp .env.example .env
npm test
```

### Variáveis de ambiente

Copie [.env.example](.env.example) para `.env` e ajuste os valores conforme seu ambiente local.

Os campos mais importantes são:

- `PORT`
- `NODE_ENV`
- `URI_MONGODB`
- `REDIS_HOST`
- `REDIS_PORT`
- `JWT_SECRET`
- `JWT_EXPIRES`
- `JWT_REFRESH_EXPIRES`
- `ALLOWED_ORIGINS`

Nenhuma credencial real fica versionada: apenas arquivos de exemplo (`.env.example` e `.env.prod.example`) são commitados, e o `.gitignore` exclui `.env`, `.env.docker` e `.env.prod`.

## Testes

```bash
npm test                    # roda todas as suítes (unit + integração)
npm run test:unit           # suítes unitárias
npm run test:integration    # suíte de integração
npm run test:coverage       # gera relatório de cobertura (text + html + lcov)
npm run lint                # ESLint em src/ e tests/
```

O pipeline de CI usa `test:unit:fast`, `test:integration:app` e `test:coverage:fast` (com `--runInBand`, para rodar corretamente em CI).

## CI/CD

O workflow [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) executa:

1. **code-quality**: ESLint, `npm audit` e `audit-ci`
2. **tests**: unitários rápidos, integração e upload de cobertura
3. **build**: build e push da imagem multi-plataforma (amd64/arm64) para GHCR
4. **security**: scan de vulnerabilidades com Trivy
5. **deploy**: staging (branch `develop`) e produção (branch `main`) com blue-green

## Observações importantes

- este projeto é um estudo de arquitetura e autenticação
- não substitui um provedor de identidade completo como Auth0, Keycloak ou Cognito
- o foco está em clareza, organização e demonstração de decisões técnicas
- a implementação inclui controles básicos, mas não deve ser tratada como solução de produção sem validação adicional de segurança e operação

## Licença

MIT
