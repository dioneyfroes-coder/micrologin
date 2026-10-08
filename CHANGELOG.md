# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/). O número do topo é o
mesmo do `version` no `package.json` e da tag `v*` correspondente — ver a seção
"Versionamento e releases" no [`README.md`](README.md).

## [1.0.0] - 2026-10-08

Primeira versão estável. Consolida o corte original da `v1.0.0` com o
endurecimento de build, dependências e CI feito até aqui.

### Adicionado

- Autenticação com JWT de access curto e refresh token rotativo com detecção de
  reuso, revogação por sessão e versão de sessão.
- Hash de senha com argon2id (`@node-rs/argon2`) e suporte a pepper.
- Middlewares de segurança: Helmet, CORS, rate limiting em Redis, semáforo de
  hash e disjuntor de concorrência.
- Observabilidade (`/observability`, `/liveness`, `/readiness`) e dashboard de
  segurança (`/security/*`), ambos com token opcional.
- Suíte de testes (unit, integração, e2e e cenários de sobrevivência a roubo de
  credencial) e gates de CI/CD com Trivy e `audit-ci`.
- Documentação em `docs/` e política de reporte de vulnerabilidade em
  [`SECURITY.md`](SECURITY.md).

### Alterado

- Licença proprietária (`Copyright (c) 2026 Dioney Froes`), substituindo o MIT.
- Pipeline de release: a tag é a fonte de verdade, e a imagem só é promovida a
  `latest` depois do scan de segurança aprovar o digest.
- Actions do GitHub movidas para as majors que declaram runtime `node24`
  (`checkout@v5`, `setup-node@v5`, `setup-buildx@v4`, `login@v4`,
  `metadata@v6`, `build-push@v7`), eliminando os avisos de Node 20 obsoleto.
- `handlebars` atualizado para `4.7.10`, fechando os advisories críticos que
  reprovavam o `audit-ci`.
- `engines.node` declarado como `>=24` no `package.json`.

### Corrigido

- Removido o `watch: ['dist']` do `ecosystem.config.cjs`: a corrida entre build e
  restart no PM2 cluster causava `ERR_MODULE_NOT_FOUND` para `dist/app.js` e
  reinícios espúrios.
- `apk upgrade --no-cache` no estágio base do `Dockerfile`, fechando a
  vulnerabilidade de `zlib` que reprovava o gate do Trivy.
- Contradição na documentação sobre o drill de deploy no CI
  ([`docs/OPERACOES.md`](docs/OPERACOES.md)).

[1.0.0]: https://github.com/dioneyfroes-coder/micrologin/releases/tag/v1.0.0
