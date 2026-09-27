# Threat model e decisões de segurança

Documento de portfólio com escopo explícito: o que este serviço defende, de quem,
com quais mecanismos, e — tão importante — **o que ele não defende**.

---

## 1. Escopo

**Dentro:** o serviço de autenticação. Recebe requisição HTTP, decide se a
credencial é válida, emite e revoga tokens de sessão, guarda usuário e senha.

**Fora:** o que o serviço não controla. Infraestrutura, TLS terminado no proxy,
rotina de backup, gestão de segredo, e a qualidade do ambiente onde roda.

**Não é:** um provedor de identidade. Não há MFA, recuperação de conta,
verificação de e-mail, federação, nem consentimiento. Quem precisa disso usa
Auth0, Keycloak ou Cognito.

---

## 2. Ativos e o que dói perdê-los

| Ativo | Onde está | Impacto de perda |
| --- | --- | --- |
| hash de senha | MongoDB, campo `password` | deriva de credencial em massa |
| segredo de assinatura | `JWT_SECRET` / `JWT_REFRESH_SECRET` | **forja de token** — aceita qualquer identidade |
| refresh token de usuário | resposta HTTP, cliente | sessão hijack sem furto de senha |
| versão de sessão | Redis `user_session_version:*` | revogação em massa deixa de revogar |
| dados do usuário | MongoDB | exposição de PII |

O segredo de assinatura é o ativo crítico: compromising a senha de um usuário
custa uma conta; compromising o segredo custa todas de uma vez, sem tocar em
nenhum hash.

---

## 3. Fronteiras de confiança

```text
   Internet  ──[1]──►  Proxy TLS  ──[2]──►  Serviço (HTTP interno)
                                                   │
                                        [3]        │        [4]
                              MongoDB ◄──────────┴──────────► Redis
```

| # | Fronteira | Controles |
| --- | --- | --- |
| 1 | cliente → proxy | TLS, HSTS, CORS por allowlist |
| 2 | proxy → serviço | rede interna; o serviço não reexpose TLS (ver decisão D7) |
| 3 | serviço → MongoDB | URI com credencial, sem auth em dev |
| 4 | serviço → Redis | é a fronteira mais crítica: **é ela que decide revogação** |

O serviço **confia** em `X-Forwarded-For` somente atrás de proxy com
`trust proxy` configurado; sem isso, um cliente forja o IP e evade do rate limit
por IP. O `liveness` foi feito para não depender disso (ver README).

---

## 4. Ameaças e mitigação

| # | Ameaça | Mitigação | Onde |
| --- | --- | --- | --- |
| T1 | Credential stuffing / força bruta | rate limit por IP **e** por conta; login responde genérico | `advancedRateLimit.ts` |
| T2 | Enumeração de contas | `/login` não distingue usuário inexistente de senha errada; username normalizado | `AuthService`, `usernamePolicy.ts` |
| T3 | Roubo de refresh token | rotação de consumo único com `SET NX` antes de emitir; reuso é sempre 401 | `jwtTokenService.ts:refreshTokens` |
| T4 | Token revogado ainda aceito | blacklist por `jti` + `sv` de sessão; logout revoga o par inteiro | `AuthService.endSession` |
| T5 | Redis fora do ar | `SESSION_FAIL_OPEN=false` (padrão em produção) → `503`, nunca aceitar sem revogação | `isRevocationStoreReady` |
| T6 | SQL/NoSQL injection | sem SQL no projeto; Mongo comongoose sanitiza o objeto; input validado por tipo | `validation.ts` |
| T7 | XSS | API responde JSON, sem HTML; CSP restritiva; sem escaping na entrada | `helmet.ts` |
| T8 | Senha fraca ou reutilizada | mínimo 12, classe de caractere exigida, 5 hashes anteriores, troca exige a senha atual | `passwordPolicy.ts` |
| T9 | Timing attack na comparação de senha | `bcrypt.compare` é de tempo constante por construção | `BcryptAdapter` |
| T10 | Payload grande / DoS de parsing | limite de 100kb no `express.json`; rate limit antes do trabalho caro | `app.ts` |
| T11 | Clique em log de auditoria | usuário mascarado no console; refresh token nunca vai para o log de evento | `logToConsole` |
| T12 | Cliente forja identidade via proxy | `X-Request-Id` externo é recusado se não for UUID; IP confiável exige `trust proxy` | `requestLogger.ts` |

---

## 5. Riscos aceitos

Escrito para que ninguém descubra reviewing o código:

1. **Rate limit em memória quando o Redis cai.** Ele vira **por processo**. Com
   PM2 em cluster, N workers dão N vezes o limite. É proteção de borda, não
   controle distribuído. Aceito porque a alternativa (recusar tráfego quando o
   Redis cai) seria pior.
2. **Histórico de auditoria em memória, por processo.** Cap de 1000 eventos;
   reinício perde, e em cluster são N históricos. Aceite porque a auditoria aqui
   é sinalização, não registro de conformidade.
3. **Sem verificação de e-mail.** Registrar `ana@x.com` e `ana@y.com` cria duas
   contas. Uma API sem confirmação de posse é a mesma que a maioria dos
   portfólios assume; quem precisa do contrário deve usar um provedor de identidade.
4. **Sem MFA.** Senha roubada é sessão roubada. Aceito como escopo.
5. **Detecção de padrão é auxiliar e não bloqueia.** Os regexes de
   `securityMonitoring.ts` sinalizam; quem bloqueia é o rate limiter. Um regex
   que bloqueia é um regex que derruba usuário legítimo — e a proteção de entrada
   é a validação determinística, não o padrão de string.
6. **O token de admin de `/security/*` é um segredo compartilhado.** Sem
   identidade por trás. Em ambiente com mais de um operador, isso não serve.
7. **`METRICS_TOKEN` sem rotação nem escopo.** Protege um único manifesto. Nome
   legado, mantido por compatibilidade de configuração já implantada.

---

## 6. Log de decisões

Cada entrada responde: o que foi decidido, por quê, e o que foi recusado.

### D1 — Falha de revogação é fail-closed em produção
`SESSION_FAIL_OPEN=false` devolve `503 REVOCATION_UNAVAILABLE` em vez de aceitar
token sem poder checar revogação.
*Recusado:* aceitar token e logar o risco. A indisponibilidade do Redis passaria
a ser uma janela de replay, e a janela não seria visível para quem precisa ver.

### D2 — Blacklist chaveada por `jti`, nunca pelo token
`token_blacklist:jti:<jti>`. Tokens sem `jti` (emissão anterior) caem para
`token_blacklist:sha256:<hash>`.
*Recusado:* usar o token como chave. Isso colocaria um segredo de sessão em
memória e em log de sistema, e o tamanho da chave é o do token.

### D3 — Revogação em massa por contador (`sv`), não por timestamp
*Recusado:* gravar `user_tokens_revoked` com o instante da revogação e comparar
com `iat`. Token emitido no mesmo segundo seria rejeitado — que é justamente a
pessoa que acabou de trocar a senha. O timestamp segue existindo, mas só como
caminho de transição para tokens sem `sv`.

### D4 — Marcação de refresh consumido ANTES de emitir o par
`SET NX` em `rotated` antes de gerar o novo par.
*Recusado:* emitir e depois marcar. A janela entre os dois deixaria duas
requisições concorrentes emits ambas com `200`, e reuso deixaria de ser sinal de
comprometimento.

### D5 — Username normalizado em fonte única
`trim` + `lowercase` em registro, login, atualização e consulta.
*Recusado:* `lowercase` no schema do Mongo só. `Alice` e `alice` seriam
identidades diferentes na consulta e iguais no índice — o registro passaria e o
login não encontraria.

### D6 — Senha nunca é normalizada nem escapada
*Recusado:* escaping de HTML ou remoção de caractere em senha. Senha é segredo
opaco; transformá-la muda o valor que o cliente enviou e quebra a comparação com
o hash. `normalizeInput` mantém uma lista explícita de campos opacos.

### D7 — HSTS só quando o serviço serve HTTPS de verdade
`setupSecurity(app, serverConfig.ssl.enabled)`. Em container, o TLS termina no
proxy e o app serve HTTP interno.
*Recusado:* HSTS incondicional. O header declara "daqui em diante, só HTTPS" para
o domínio inteiro; declarar sobre um serviço que não serve TLS quebra o acesso a
todo o resto do domínio.

### D8 — Métricas de scrape removidas; observabilidade por porta
`setAuthEventSink` publica o evento de autenticação com rótulo já decidido. O
padrão é log estruturado, e `/observability` é derivado do `requestLogger`.
*Recusado:* manter a biblioteca de métricas. A forma de saída não era o problema;
o problema era a decisão de desfecho duplicada em cada consumidor, e um destino
trocável conserta isso sem impor formato de saída.

### D9 — Um buffer de eventos de segurança
O `threatLog` do monitor foi removido; o registro vai para o `events` do
`securityAuditLogger`.
*Recusado:* dois históricos. O mesmo evento gravado em dois lugares, com
`timestamp` em formatos diferentes, e sem consumidor para o segundo — é divergência
esperada, não uma redundância inofensiva.

### D10 — `sv` e a marca legada usam constantes
`USER_SESSION_VERSION_PREFIX` e `USER_TOKENS_REVOKED_PREFIX`, com round-trip
coberto por teste.
*Recusado:* montar a chave inline na leitura e na escrita. Divergir entre as
pontas faria `isUserRevoked` devolver `false` — token revogado aceito, sem erro
em lugar nenhum. É o tipo de bug que nenhum teste de integração pega, porque as
duas pontas usam a mesma constante errada.

---

## 7. O que este serviço não é

- Não é MFA, recuperação de conta, verificação de e-mail nem federação.
- Não é auditoria de conformidade: o histórico é por processo e em memória.
- Não é WAF: a detecção de padrão sinaliza, não bloqueia.
- Não é controle de acesso: há um único papel implícito (usuário) e um segredo
  administrativo compartilhado.

Cada item acima é um limite de escopo declarado, não um defeito escondido.

---

## Referências

- Fluxo de requisição e arquitetura: [`ARQUITETURA.md`](ARQUITETURA.md)
- Política de revogação, sessão e senha: [`../README.md`](../README.md)
- Dashboard de segurança: [`DASHBOARD_SEGURANCA_GUIA.md`](DASHBOARD_SEGURANCA_GUIA.md)
