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
                    │  adapters/BcryptAdapter      → bcrypt         │
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
          → hash(plainText)        CryptoService (bcrypt)
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
      → securityAuditLogger.logLoginAttempt(rótulo canônico)
      ← 200 { accessToken, refreshToken } | 401
```

O rótulo do desfecho é decidido **uma vez**, em
`src/shared/utils/authOutcomes.ts`, e viaja pronto para a auditoria e para o
log estruturado. `/login` não distingue "usuário não encontrado" de "senha
errada" na resposta: distinguir enumeraria contas.

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

A ordem importa e já foi corrigida uma vez: ler o access token antes do refresh
fazia o logout com apenas um dos doisparer de revogar metade da sessão. Sem
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

---

## Onde está o resto

- Decisões de segurança, threat model e riscos aceitos: [`SEGURANCA.md`](SEGURANCA.md)
- Comportamento de revogação, modelo de sessão e política de senha: [`../README.md`](../README.md)
- Guia do dashboard de segurança: [`DASHBOARD_SEGURANCA_GUIA.md`](DASHBOARD_SEGURANCA_GUIA.md)
