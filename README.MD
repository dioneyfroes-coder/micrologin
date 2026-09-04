# Authentication Microservice

Projeto de portfolio em Node.js para demonstrar uma API de autenticação com estrutura organizada, JWT, validação de senha, rate limiting e integração com MongoDB/Redis.

Este repositório é uma demonstração de arquitetura e organização de código. Ele não representa uma solução de autenticação pronta para produção sem revisão adicional e ajustes específicos do ambiente.

## O que o projeto inclui

- registro e autenticação de usuários
- JWT com access token e refresh token
- validação de senha com regras simples
- rate limiting por IP e login
- sanitização básica de entradas
- middleware de auditoria e monitoramento
- health check e métricas básicas
- documentação Swagger
- testes unitários e de integração
- configuração com Docker Compose

## Stack

- Node.js
- Express
- MongoDB + Mongoose
- Redis
- JWT
- bcrypt
- Jest
- Docker

## Estrutura principal

```text
src/
├── app.js
├── core/
├── application/
├── infrastructure/
├── interfaces/
├── shared/
├── config/
└── routes/
```

A organização tenta separar domínio, aplicação e infraestrutura sem exagerar em camadas conceituais. O objetivo é manter o código legível e testável para um projeto de portfolio.

## Pré-requisitos

- Node.js 22+
- npm
- Docker e Docker Compose
- MongoDB e Redis locais ou via containers

## Como rodar localmente

```bash
npm install
cp .env.example .env
npm run docker:up
npm run dev
```

Ou, sem Docker:

```bash
npm install
cp .env.example .env
npm test
```

## Variáveis de ambiente

Copie o arquivo [.env.example](.env.example) para `.env` e ajuste os valores conforme seu ambiente local.

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

## Testes

```bash
npm test
npm run test:unit
npm run test:integration
```

## Observações importantes

- este projeto é um estudo de arquitetura e autenticação
- não substitui um provedor de identidade completo como Auth0, Keycloak ou Cognito
- o foco está em clareza, organização e demonstração de decisões técnicas
- a implementação inclui controles básicos, mas não deve ser tratada como solução de produção sem validação adicional de segurança e operação

## Licença

MIT
