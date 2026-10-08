# micrologin

Microserviço de autenticação em Node.js: registro, login, JWT com rotação de
refresh token, revogação, rate limiting com Redis e MongoDB. Arquitetura
hexagonal, argon2id, Docker, CI/CD com gates de segurança e limitações
conhecidas declaradas.

```bash
git clone https://github.com/dioneyfroes-coder/micrologin
cd micrologin && npm ci && npm run docker:up
curl localhost:3000/health
```

Runbook completo — variáveis de ambiente, matriz de testes, deploy, rollback:
[`docs/OPERACOES.md`](docs/OPERACOES.md).

---

## Em 60 segundos

Principais decisões técnicas:

**Logout encerra todas as sessões, não só a atual.** O par enviado vai para a
blacklist e a `user_session_version` do usuário é incrementada, o que invalida
todo token emitido antes — inclusive o de um celular que nunca viu aquele
logout. Quem roubar um refresh token perde o token roubado quando o dono faz
logout, porque ele dependia da mesma versão.

**A rotação do refresh token tem consumo único.** O marcador `rotated` é gravado
com `SET NX` **antes** do par novo ser emitido. Dois `/refresh` simultâneos com o
mesmo token dão uma `200` e uma `401` — e detectar reuso revoga a sessão
inteira, inclusive o par recém-emitido na disputa.

**Argon2id tem limite de concorrência imposto em runtime.** Um semáforo
com fila FIFO limita os hashes simultâneos por processo; o orçamento de memória
do arranque valida os parâmetros contra o `mem_limit` do container. Saturação
devolve `503`, nunca 401 — erro de capacidade não é erro de credencial.

**O deploy tem rollback verificado por teste.** `npm run test:deploy` sobe
três imagens, implanta a terceira com o Mongo na porta errada, deixa o health
check abortar e exige que o rollback restaure imagem, digest e configuração da
segunda. É um drill local, fora do CI: o CI roda build, testes, `audit-ci` e o
scan Trivy da imagem.

**As decisões de segurança têm teste e registro.** As suítes em
`tests/security/` cobrem roubo de credencial e sobrevivência a Redis fora do
ar; `npm run test:secrets` roda o gitleaks, e o CI roda o Trivy a cada PR e
publica o relatório SARIF.

E o mais importante: **os limites estão escritos, não escondidos.** O maior
deles está logo abaixo.

---

## Stack

Node.js 24+ · Express · MongoDB (Mongoose) · Redis (node-redis 5) · JWT
(jsonwebtoken / jose) · argon2id (`@node-rs/argon2`) · Jest · Docker Compose ·
GitHub Actions

---

## Endpoints

As rotas são montadas na raiz da aplicação.

| Método | Rota | Proteção | Descrição |
| --- | --- | --- | --- |
| POST | `/register` | — | Cria usuário (username + senha forte) |
| POST | `/login` | rate limit | Autentica e emite access + refresh |
| POST | `/refresh` | — | Renova o par via refresh token (consumo único) |
| POST | `/logout` | opcional (Bearer) | Revoga o par e todas as sessões do usuário |
| GET | `/profile` | Bearer | Obtém o perfil |
| PUT | `/update` | Bearer | Atualiza apenas o username |
| PUT | `/password` | Bearer | Troca a senha (step-up) e encerra as sessões |
| DELETE | `/delete` | Bearer | Remove o usuário |
| GET | `/health` | — | Health detalhado: Mongo, Redis, memória, uptime |
| GET | `/liveness` | — | 200 se o processo responde. Não consulta dependência |
| GET | `/readiness` | — | 200 com Mongo de pé, 503 sem. Redis degradado não tira de prontidão |
| GET | `/observability` | `METRICS_TOKEN` | Snapshot por logs: volumes, P50/P95/P99, taxa de erro, top rotas |
| GET | `/security/*` | `SECURITY_DASHBOARD_TOKEN` | Dashboard, auditoria e diagnóstico |

Falha de login é `401` com `Credenciais inválidas`; falha de registro é `400`
com mensagem genérica, sem revelar se a conta existe. Username é normalizado
para minúsculas em todas as entradas: `Alice`, `alice` e `  ALICE  ` são a mesma
conta.

Existe uma classe de resposta que não é `4xx` do cliente: **`503`**, que diz que
o serviço não conseguiu, e não que o usuário errou.

| código | quando |
| --- | --- |
| `REVOCATION_UNAVAILABLE` | Redis indisponível e `SESSION_FAIL_OPEN=false`: nada foi aceito sem poder checar revogação |
| `ARGON2_OVERLOADED` | fila do semáforo de hash cheia — capacidade, não credencial |
| `PASSWORD_CHANGE_NOT_PERSISTED` | revogação ok, gravação falhou: sessões encerradas, refazer a troca |
| `PASSWORD_HISTORY_UNAVAILABLE` | não foi possível consultar o histórico de senhas |
| `USER_DELETE_NOT_PERSISTED` | revogação ok, exclusão falhou: sessões encerradas, conta continua de pé |

---

## Limitações conhecidas

O que está aqui é limitação **assumida e medida**, não bug escondido.

**Revogação em nó único (D20).** A blacklist e a versão de sessão vivem só no
Redis. A persistência cobre *restart*, mas não a perda do volume. Nesse caso o
serviço volta sem histórico de revogação e opera em fail-open **de fato**: um
token já revogado volta a valer até o próprio expirar, com 0 erros no log e
resposta `200` idêntica. O serviço é fail-closed quando o Redis está
*indisponível* (503, nunca 401) — o buraco fica exatamente onde o resto parece
fechado. Medido em `npm run test:redis:volume-loss`: **~15 min** para o access
revogado voltar a valer. As duas saídas (Redis com réplica, ou gravar o carimbo
também no Mongo) mudam o modelo de operação e estão descritas em
[`docs/SEGURANCA.md`](docs/SEGURANCA.md#d20--revogação-em-nó-único-o-limite-aceito-e-o-que-fecha-a-lacuna).

| Limitação | Por quê |
| --- | --- |
| **Logout é por usuário, não por dispositivo** | o logout incrementa a `user_session_version`, então derruba **todas** as sessões do usuário, não só o par enviado. Logout individual exigiria estado por sessão (`sessionId`/`deviceId`/`jti`), fora do escopo da 1.0.0 |
| MongoDB single-node | escala da API não transforma o banco em HA; RPO 24h pelo backup cifrado |
| Rate limit em memória quando o Redis cai | vira **por processo**: com PM2 em cluster, N workers dão N vezes o limite |
| Auditoria e observabilidade em memória | cap de 1000 eventos; perdem no restart. Sinalização, não registro de conformidade |
| `/security/*` com token compartilhado | sem identidade por trás; com mais de um operador não serve |
| Sem verificação de e-mail | `ana@x.com` e `ana@y.com` são duas contas |
| Sem MFA | senha roubada é sessão roubada. Escopo aceito |
| `PUT /update` ainda distingue username repetido no tempo | a resposta é explícita por decisão de API e o endpoint exige sessão (D34) |
| Nenhum deploy contra servidor real | o `test:deploy` prova a lógica; falta o transporte SSH e o registry autenticado, que precisam de um host |

O detalhamento completo, com o porquê de cada uma e o que foi recusado, está em
[`docs/SEGURANCA.md`](docs/SEGURANCA.md).

---

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | camadas, ordem dos middlewares, fluxo de login/refresh/logout e onde o estado mora |
| [`docs/SEGURANCA.md`](docs/SEGURANCA.md) | threat model, riscos aceitos e log de decisões (o que foi decidido e o que foi recusado) |
| [`docs/OPERACOES.md`](docs/OPERACOES.md) | rodar, variáveis de ambiente, matriz de testes, CI/CD, deploy e rollback |
| [`docs/ROTACAO.md`](docs/ROTACAO.md) | rotação da chave ES256, do pepper e das senhas de Mongo/Redis |
| [`docs/BACKUP.md`](docs/BACKUP.md) | backup/restauração do Mongo: RPO/RTO medidos, retenção e o drill |
| [`docs/REDIS.md`](docs/REDIS.md) | o que o Redis guarda e o que se perde sem ele |
| [`docs/CONFIG.md`](docs/CONFIG.md) | backup/restauração da configuração em execução e rollback de imagem+config |
| [`docs/metricas.md`](docs/metricas.md) | medições interpretadas: hashing, carga, capacidade, GC |
| [`docs/DASHBOARD_SEGURANCA_GUIA.md`](docs/DASHBOARD_SEGURANCA_GUIA.md) | como usar `GET /security/*` e o dashboard, com exemplos em [`examples/`](examples) |

---

## Observações

- este projeto é um estudo de arquitetura e autenticação; não substitui um
  provedor de identidade completo (Auth0, Keycloak, Cognito)
- os controles incluídos não devem ser tratados como solução de produção sem
  validação adicional de segurança e operação
- a imagem é `linux/amd64`, e isso foi decisão: nada consome arm64, e um arm64
  quebrado derrubaria a release inteira porque o buildx constrói as plataformas
  numa única invocação

## Licença

Copyright (c) 2026 Dioney Froes — Todos os direitos reservados.

Este é um projeto de código **proprietário**. O uso comercial, a reprodução,
modificação e distribuição do código, total ou parcial, exigem autorização
prévia e expressa por escrito do autor. As marcas de procedência autoral
(Provenance-ID: ML-7F29, ML-7F2A, ML-A31C) devem ser preservadas. Consulte o
arquivo [`LICENSE`](LICENSE).
