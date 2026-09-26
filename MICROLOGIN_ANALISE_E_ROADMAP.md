# Micrologin — análise técnica completa e roadmap

**Data da análise:** 2026-09-25  
**Material analisado:** `micrologin-main` do arquivo ZIP fornecido.  
**Escopo:** arquitetura, implementação, segurança, testes, Docker, CI/CD, observabilidade, documentação e maturidade para portfólio/produção.

> **Resumo executivo:** o Micrologin é um projeto de autenticação acima da média para portfólio. A arquitetura, separação de responsabilidades, cobertura de testes e preocupação com segurança são reais, não apenas cosméticas. O problema é que algumas partes tentam parecer “production-grade” antes de estarem realmente fechadas. Há falhas concretas — algumas importantes — que impedem tratá-lo como serviço pronto para produção.

---

## 1. Veredito geral

### Nota geral: **7,3 / 10**

A nota não mede apenas quantidade de código. Ela combina qualidade estrutural, correção funcional, segurança, testes e coerência entre o que o projeto diz fazer e o que efetivamente faz.

| Área | Nota | Avaliação |
|---|---:|---|
| Arquitetura | **8,5** | Boa separação entre domínio, aplicação, infraestrutura e interfaces; ports/adapters e DI estão presentes de verdade. |
| Organização do código | **8,0** | Estrutura clara, nomenclatura razoável e responsabilidades relativamente bem separadas. Há duplicação e módulos mortos. |
| Domínio / regras de negócio | **7,5** | O núcleo é bem isolado, mas algumas regras anunciadas no modelo de dados não chegam ao domínio. |
| Segurança | **6,0** | Há bastante proteção implementada, mas existem falhas importantes de exposição e comportamento fail-open. |
| Testes | **8,0** | Boa quantidade e existe E2E contra MongoDB/Redis reais. Faltam testes para alguns dos casos mais perigosos. |
| Observabilidade | **7,5** | Prometheus + logs estruturados + agregador são uma boa base, mas há métricas internas com semântica incorreta. |
| Docker / infraestrutura | **7,0** | Multi-stage, usuário non-root, healthcheck e limites de recursos são bons. Escala do compose está incorreta. |
| CI/CD | **5,5** | CI é relativamente completo; deploy e blue-green são declarados, mas ainda são placeholders. |
| Documentação | **7,0** | Há bastante documentação, porém existem divergências entre README e implementação. |
| Portfólio | **8,5** | Demonstra bastante coisa útil para um backend profissional; a densidade técnica é um ponto forte. |
| Pronto para produção | **5,5** | Ainda não. As falhas principais precisam ser resolvidas antes de qualquer alegação de produção. |

### Em uma frase

**É um bom projeto de engenharia para portfólio, mas ainda é melhor descrito como “auth service experimental/educacional com arquitetura de produção” do que como “microserviço de autenticação pronto para produção”.**

---

# 2. O que está realmente bom

## 2.1 Arquitetura não é só decoração

A separação está razoavelmente bem feita:

```text
HTTP / Express
      ↓
Controllers + Middleware + Routes
      ↓
Domain / Application Service
      ↓
Ports / interfaces
      ↓
Adapters
      ↓
MongoDB / Redis / JWT / bcrypt
```

O `AuthService` de domínio recebe `UserRepository`, `CryptoService`, `TokenService` e `Logger` por injeção. Isso é muito melhor do que colocar Mongoose, bcrypt e JWT diretamente dentro do caso de uso.

O projeto também possui um `ServiceContainer` e um bootstrap centralizado. Não é a arquitetura mais simples possível, mas demonstra domínio sobre inversão de dependência.

### Ponto positivo específico

O domínio não depende diretamente de Express, Mongoose ou Redis. Isso facilita testes unitários e substituição de infraestrutura.

---

## 2.2 Há testes de verdade

O repositório possui:

- **30 arquivos de teste**;
- aproximadamente **246 casos `it/test`** identificáveis no código;
- testes unitários de domínio, middleware, JWT, Redis, rate limiting, observabilidade e configurações;
- testes de integração;
- um E2E que conversa com **MongoDB e Redis reais**.

O E2E percorre um fluxo importante:

```text
register
  ↓
login
  ↓
profile
  ↓
update
  ↓
refresh / rotação
  ↓
logout
  ↓
blacklist
```

Isso é um diferencial relevante para portfólio. Muitos projetos de autenticação ficam apenas em mocks de serviço e nunca demonstram o fluxo completo.

### Limitação importante

A quantidade de testes é boa, mas a distribuição ainda não está alinhada com o risco. Há mais testes para estruturas internas do que para alguns comportamentos de segurança de maior impacto.

---

# 3. Problemas críticos encontrados

## P0 — `/security/*` está exposto sem autenticação

Arquivo:

`src/application/routes/securityRoutes.ts`

As rotas seguintes são montadas diretamente em `/security/*` sem middleware de autenticação ou token administrativo:

```text
GET /security/stats
GET /security/report
GET /security/events
GET /security/threats
GET /security/health
```

Elas expõem informações como:

- eventos recentes;
- IPs envolvidos;
- padrões de ataque;
- estatísticas de rate limit;
- nível de risco;
- recomendações internas;
- detalhes do ambiente de segurança.

Somente o endpoint `/security/test` possui uma restrição explícita para produção.

### Gravidade

**Alta.** Um atacante não deveria receber o relatório interno de segurança de um serviço de autenticação.

### Correção

Definir uma política única:

```text
/security/*
    ↓
admin/security middleware
    ↓
metrics token forte OU mTLS OU VPN/rede administrativa
```

Para esse projeto, o caminho mais simples é reutilizar o mecanismo de `METRICS_TOKEN`, mas com um token separado, por exemplo `SECURITY_DASHBOARD_TOKEN`.

---

## P0 — escala horizontal declarada no Compose não funciona como documentada

`docker-compose.prod.yml` contém simultaneamente:

```yaml
container_name: auth-service-prod
```

e
```yaml
ports:
  - "${APP_PORT:-3000}:3000"
```

enquanto a documentação afirma que é possível:

```bash
docker compose ... up -d --scale auth-service=3
```

Esse desenho é incompatível com escalabilidade horizontal real no Docker Compose.

Além disso, três réplicas não poderiam compartilhar o mesmo bind de porta do host dessa forma.

### Correção

Escolher uma destas arquiteturas:

**Opção A — Compose local simples**

- sem `--scale`;
- uma réplica;
- remover a promessa de horizontal scaling.

**Opção B — múltiplas réplicas**

- remover `container_name`;
- não publicar a porta da aplicação diretamente para cada réplica;
- usar reverse proxy/load balancer na frente;
- deixar o tráfego chegar ao serviço internamente.

Para um projeto de portfólio, a opção B é mais interessante, desde que realmente implementada.

---

## P0/P1 — Redis indisponível transforma controles de segurança em comportamento fail-open

O Redis é usado para:

- blacklist de JWT;
- revogação por usuário;
- rate limiting compartilhado.

Quando o Redis cai, o projeto deliberadamente continua operando em modo degradado.

Isso é uma decisão válida para disponibilidade, mas é perigosa para autenticação porque algumas proteções deixam de existir:

```text
Redis fora
   ↓
blacklist ignorada
   ↓
token revogado pode voltar a ser aceito
```

O mesmo vale para rate limiting, que retorna ao armazenamento em memória por processo.

### O problema real

Com vários workers/processos, rate limiting em memória não é global.

Exemplo:

```text
Worker A → 5 tentativas
Worker B → 5 tentativas
Worker C → 5 tentativas
```

Cada processo pode enxergar somente sua parcela do tráfego.

### Decisão recomendada

Escolher explicitamente entre:

**Modo fail-closed para autenticação crítica**

- se Redis estiver indisponível, negar operações que dependam de revogação/controle de sessão;
- preservar segurança acima de disponibilidade.

ou

**Modo degradado documentado**

- aceitar o risco;
- gerar alerta forte;
- diferenciar health/readiness de liveness;
- deixar claro que revogação pode ficar indisponível.

Para um projeto chamado Micrologin, eu trataria blacklist e revogação como controles críticos e não esconderia a degradação.

---

# 4. Problemas importantes de autenticação

## 4.1 Enumeração de usuários

O domínio retorna mensagens diferentes:

```text
Usuário não encontrado
Senha incorreta
Usuário já existe
```

O controller então envia essas diferenças ao cliente.

Isso facilita descobrir quais contas existem.

### Melhor comportamento

No login:

```text
Credenciais inválidas
```

No registro:

```text
Não foi possível criar a conta
```

Pode haver logging/auditoria internamente com o motivo real, mas a resposta externa deve ser uniforme.

---

## 4.2 Username tem normalização inconsistente

O schema Mongo usa:

```text
lowercase: true
```

mas o domínio e a consulta de login não normalizam o username para lowercase antes de consultar.

Isso cria o cenário:

```text
Registro:
Alice123
   ↓
Mongo salva:
alice123

Login:
Alice123
   ↓
findOne({ user: "Alice123" })
   ↓
não encontra
```

O E2E não detecta isso porque usa usernames já minúsculos.

### Correção

Definir uma única normalização de identidade:

```ts
normalizeUsername(username) => username.trim().toLowerCase()
```

Usá-la em:

- register;
- login;
- update;
- repository queries.

---

## 4.3 Rotação de refresh token tem janela de corrida

Hoje o fluxo é essencialmente:

```text
verify(old refresh)
      ↓
generate(new pair)
      ↓
blacklist(old refresh)
```

Duas requisições concorrentes podem passar pelo `verify` antes da blacklist ser gravada.

Resultado potencial:

```text
Request A ── verify(old) ── generate(new A)
Request B ── verify(old) ── generate(new B)
                         ↓
                  ambos aceitos
```

O teste E2E cobre reuso sequencial, mas não concorrência.

### Correção

Mover o estado de rotação para Redis com operação atômica, por exemplo:

```text
jti do refresh
    ↓
SET NX / compare-and-set
    ↓
somente o primeiro consumidor vence
```

Além disso, testar duas chamadas simultâneas para `/refresh`.

---

## 4.4 Token é usado como chave de blacklist

Hoje a blacklist usa algo equivalente a:

```text
token_blacklist:<JWT completo>
```

Isso é funcional, mas não é a melhor modelagem.

Melhor:

```text
blacklist:<jti>
```

com:

- `jti` aleatório;
- TTL igual ao restante de validade;
- segredo/token completo não armazenado como chave.

O projeto já adicionou `jwtid` aos tokens do pair, então está muito perto de uma solução melhor.

---

## 4.5 `JWT_REFRESH_SECRET` pode cair no mesmo segredo do access token

O bootstrap faz fallback para:

```text
JWT_REFRESH_SECRET || JWT_SECRET
```

Isso reduz a separação criptográfica entre os dois tipos de token.

### Melhor

Em produção:

```text
JWT_SECRET          obrigatório
JWT_REFRESH_SECRET  obrigatório
```

ambos com tamanho mínimo validado e sem fallback silencioso.

---

# 5. Problemas na política de senha

## 5.1 O modelo possui histórico, mas o fluxo não o utiliza

O schema possui:

```text
passwordChangedAt
passwordExpired
passwordHistory
```

Também existe `wasPasswordUsedBefore()`.

Porém, o adapter e o caso de uso de atualização de senha não integram esses campos ao fluxo de troca de senha.

Na prática:

```text
passwordHistory existe
        mas
passwordHistory não participa da troca de senha
```

Isso é uma funcionalidade parcialmente implementada.

### Correção

Na troca de senha:

1. carregar histórico;
2. verificar reutilização;
3. adicionar hash antigo ao histórico;
4. limitar tamanho do histórico;
5. atualizar `passwordChangedAt`;
6. invalidar sessões anteriores, se essa for a política;
7. salvar atomicamente.

---

## 5.2 `passwordExpired` parece ser um dead feature

Existe no schema, mas não há um fluxo consistente de expiração de senha.

Duas opções corretas:

- implementar de verdade;
- remover para não criar uma falsa impressão de cobertura.

Para um projeto de portfólio, remover feature inacabada costuma ser melhor do que deixar uma “promessa” morta no modelo.

---

# 6. Sanitização está conceitualmente misturada com validação

`sanitizeInput` usa DOMPurify e `validator.escape()` para strings de entrada.

Isso é problemático principalmente para credenciais.

Uma senha é um valor opaco. Ela não deveria ser transformada por HTML escaping antes de ser validada/hashada.

Exemplo conceitual:

```text
senha digitada:
A&B<C

entrada transformada:
A&amp;B&lt;C
```

A aplicação está mudando o valor secreto fornecido pelo usuário.

Mesmo quando login e registro usam a mesma transformação, isso é uma abstração ruim e cria comportamento surpreendente para clientes.

### Arquitetura recomendada

Separar:

```text
Validation
    ↓
verifica formato e limites

Normalization
    ↓
normaliza apenas campos que realmente possuem canonicalização

Encoding / output escaping
    ↓
feito no contexto de saída
```

Não aplicar HTML escaping globalmente em senha.

Também não há SQL no MongoDB; portanto o comentário “escapar caracteres SQL” representa uma preocupação importada de outro contexto.

---

# 7. Bug de semântica no sistema de auditoria

Em `securityAudit.ts`, todo evento `login_attempt` incrementa:

```text
failedLogins++
```

inclusive quando:

```ts
logLoginAttempt(..., true)
```

O próprio teste atual aceita esse comportamento.

Ou seja, a métrica chamada `failedLogins` não representa exclusivamente logins falhos.

Isso gera uma situação perigosa: a infraestrutura de monitoramento pode produzir conclusões erradas mesmo estando “testada”.

### Correção

Manter:

```text
loginAttempts
failedLogins
successfulLogins
```

ou incrementá-los de acordo com `details.success`.

Depois criar testes que expressem a semântica correta, não apenas a implementação atual.

---

# 8. Tratamento de `uncaughtException` merece revisão

O código possui uma exceção especial que ignora certos `uncaughtException` quando a mensagem contém termos como `forEach` ou `metrics`.

Isso é arriscado.

Depois de um `uncaughtException`, o processo pode estar em um estado inconsistente. Evitar a parada com base no texto da exceção pode mascarar corrupção do estado.

### Melhor abordagem

```text
uncaughtException
      ↓
log
      ↓
shutdown controlado
      ↓
container/process manager recria
```

Recuperação seletiva deve acontecer em nível de operação específica, não como exceção global baseada em `message.includes(...)`.

---

# 9. Observabilidade

## Pontos fortes

Há uma base boa:

- `X-Request-Id`;
- logs estruturados;
- Prometheus;
- duração por requisição;
- P50/P95/P99;
- agregação por status e rota;
- health check;
- métricas de memória;
- relatório de segurança;
- endpoint `/observability` protegido.

Isso é bastante para um projeto pessoal.

## Pontos a melhorar

### 9.1 O agregador é por processo

O snapshot em memória enxerga apenas as requisições daquele processo.

Com vários workers:

```text
worker A → agregador A
worker B → agregador B
worker C → agregador C
```

Não existe uma visão global.

Como o projeto já possui Prometheus, o endpoint `/observability` pode continuar existindo como diagnóstico local, mas não deve ser tratado como fonte global para métricas de produção.

### 9.2 `X-Request-Id` recebido do cliente deveria ser validado

Hoje qualquer cliente pode fornecer o próprio `X-Request-Id`.

Melhor:

- aceitar UUID válido;
- rejeitar valores longos/incomuns;
- ou sempre gerar um novo ID e armazenar o recebido em um campo separado.

---

# 10. Health check

O health check é útil, mas mistura conceitos diferentes.

Atualmente memória elevada pode transformar a aplicação em `503`, mesmo com MongoDB e Redis saudáveis.

Idealmente existiriam:

```text
/liveness
    processo está vivo?

/readiness
    pode receber tráfego?

/health
    diagnóstico detalhado
```

Em produção isso reduz falsos restarts e torna o comportamento operacional mais previsível.

---

# 11. Rate limiting

A implementação é acima da média para um projeto de portfólio.

Há:

- limite por IP;
- limite por usuário;
- limite específico para login;
- Redis quando disponível;
- fallback em memória;
- `Retry-After`;
- auditoria de violações.

### Melhorias

1. Configurar `trust proxy` corretamente quando houver reverse proxy.
2. Diferenciar explicitamente tráfego interno e externo.
3. Não usar `KEYS` em Redis para limpeza de produção; preferir namespace + SCAN.
4. Criar teste de múltiplos workers.
5. Criar teste específico com Redis indisponível.
6. Tornar o comportamento fail-open/fail-closed uma decisão de configuração documentada.

---

# 12. Docker

## Pontos bons

O Dockerfile é bom para projeto pessoal:

- multi-stage;
- imagem Alpine;
- `dumb-init`;
- usuário non-root;
- dependências de produção separadas;
- healthcheck;
- build TypeScript fora do stage final;
- logs e limites de recursos no Compose.

Isso demonstra maturidade.

## Problemas

### 12.1 Compose de produção não é realmente uma plataforma de produção

Ele é basicamente:

```text
1 container
+ rede bridge
+ healthcheck
+ port bind
```

Não há:

- reverse proxy no repositório;
- balanceador;
- TLS na borda;
- deployment real;
- secrets manager real;
- rollback realmente integrado ao registry externo.

Como projeto de laboratório isso é perfeitamente aceitável. O problema é a documentação chamar algumas dessas capacidades de “produção” antes de implementá-las.

---

# 13. CI/CD: aqui existe bastante maquiagem documental

O workflow de CI é razoavelmente bom para:

- install;
- lint;
- typecheck;
- audit;
- gitleaks;
- testes;
- build;
- push de imagem;
- Trivy.

Mas a parte de deployment não faz deployment real.

Existem passos como:

```text
echo "Deploying..."
echo "Deployment completed"
sleep 30
```

com o comando real comentado.

Também existe:

```text
# Implementar blue-green deployment
```

e depois o job anuncia que o deployment foi concluído.

Isso precisa ser corrigido conceitualmente.

### Para portfólio

É melhor escrever:

```text
CI completo
CD preparado como template
```

do que:

```text
CI/CD completo
```

quando o deploy real ainda não existe.

---

# 14. Release pipeline também está incompleto

O workflow cria GitHub Release e changelog, mas o bloco de tag/push da imagem Docker ainda é comentário.

Portanto:

```text
Release GitHub = real
Release Docker = parcialmente declarado
```

O README deve refletir isso.

---

# 15. Documentação tem inconsistências reais

Alguns exemplos:

### README diz `/api` como base configurável

As rotas são montadas diretamente em `/`, não existe um prefixo global `/api` na aplicação mostrada.

### README diz 235 testes / 26 suítes

O repositório analisado contém aproximadamente:

- 30 arquivos de teste;
- 246 casos `it/test` identificáveis.

Isso sugere que o README ficou para trás.

### `.env.docker`

O README fala sobre `.env.docker`, mas o arquivo não está presente no material analisado.

### Branch protection

O README descreve branch protection como regra desejada, enquanto o `todo.txt` registra que essa proteção foi deliberadamente pulada.

### `docs/todo.txt`

Todos os itens aparecem como `[x]`, embora o próprio documento diga que existem decisões externas ainda abertas.

Isso reduz a credibilidade do checklist.

---

# 16. O maior problema arquitetural do projeto

Não é falta de código.

É **complexidade maior do que a maturidade operacional atual**.

O projeto possui muitos componentes:

```text
DI container
hexagonal architecture
JWT pair
refresh rotation
blacklist
Redis
rate limiter
security audit
security monitor
observability
Prometheus
Swagger
Docker
PM2
cluster
CI/CD
Trivy
Gitleaks
Compose scaling
rollback
release automation
```

Isso impressiona visualmente.

Mas cada componente cria uma superfície adicional para bugs.

O próximo estágio do projeto não deveria ser adicionar mais features.

Deveria ser:

> **reduzir divergência entre intenção, documentação e comportamento real.**

---

# 17. O que eu NÃO implantaria agora

Não recomendo adicionar neste momento:

- Kubernetes;
- OpenTelemetry;
- Kafka/RabbitMQ;
- microsserviços adicionais;
- sistema de notificações externo;
- captcha externo;
- OAuth provider;
- painel frontend complexo;
- service mesh;
- feature flags sofisticadas.

O projeto ainda ganha mais corrigindo fundamentos do que adicionando tecnologia.

---

# 18. Roadmap recomendado

## Fase 0 — corrigir documentação e declarar o estado real

### Objetivo
Remover discrepâncias entre código e documentação.

### Tarefas

- [x] Corrigir contagem de testes no README.
- [x] Corrigir referência a `/api`.
- [x] Remover referência a `.env.docker` se ele não existir.
- [x] Marcar CI como completo e CD como template até o deploy real existir.
- [x] Corrigir descrição de blue-green.
- [x] Reescrever `docs/todo.txt` com estados:
  - `[x] implementado`
  - `[~] parcial`
  - `[ ] pendente`
- [x] Documentar explicitamente o comportamento quando Redis está indisponível.

### Resultado esperado
O README passa a descrever exatamente o sistema existente.

---

# Fase 1 — fechar segurança crítica

## 1.1 Proteger `/security/*`

**Status: concluído.** O dashboard exige `SECURITY_DASHBOARD_TOKEN` no header `X-Security-Token`, com middleware aplicado às rotas administrativas.

Criar middleware específico:

```text
requireSecurityToken
```

Aplicar em:

```text
/security/stats
/security/report
/security/events
/security/threats
/security/health
```

Não usar o mesmo segredo destinado ao Prometheus se o objetivo for separar responsabilidades.

## 1.2 Remover enumeração de contas

**Status: concluído.** Login e registro retornam mensagens públicas uniformes; o motivo permanece disponível na auditoria e nos logs internos.

Login:

```text
401 AUTHENTICATION_FAILED
"Credenciais inválidas"
```

Registro:

```text
resposta genérica
```

Logs internos continuam detalhando o motivo.

## 1.3 Normalizar username

**Status: concluído.** A forma canônica é `normalizeUsername()` (`trim` + `lowercase`) em `src/shared/utils/usernamePolicy.ts`, aplicada em:

- `LoginCredentials` e `User` (domínio);
- validação HTTP (`validateLogin`, `validateRegister`, `validateUpdate`);
- consultas do adapter Mongo (`findByUsername`, `exists`).

A senha **não** é normalizada: é valor opaco.

Testes adicionados:

- `tests/unit/username-policy.test.ts` (normalização, idempotência, idempotência com non-string);
- `tests/unit/domain-user.test.ts` e `domain-auth-service*.test.ts` (entidade, registro, login e update);
- `tests/unit/validation-middleware.test.ts` (sanitizador de campo e senha preservada);
- `tests/integration/auth-flow.test.ts` (identidade única independente da caixa);
- `tests/e2e/auth-http.e2e.test.ts` (registro/login/update case-insensitive contra MongoDB real).

## 1.4 Remover fallback automático do refresh secret

**Status: concluído.** `JWT_REFRESH_SECRET` é lido em `securityConfig.jwt.refreshSecret` e, em produção, é obrigatório, precisa ter no mínimo 32 caracteres e ser diferente de `JWT_SECRET` (`validateConfiguration`). O bootstrap não faz mais `JWT_REFRESH_SECRET || JWT_SECRET`; o `JWTTokenService` registra aviso quando não recebe segredo de refresh.

## 1.5 Revisar comportamento quando Redis cai

**Status: concluído — decisão: fail-closed em produção.**

`SESSION_FAIL_OPEN` (default: `false` em produção, `true` em dev/test) define a política de revogação:

- **fail-closed** (produção): sem armazenamento de revogação, a verificação de access/refresh token, o refresh e o logout respondem erro `REVOCATION_UNAVAILABLE` (HTTP 503) em vez de aceitar tokens sem controle;
- **fail-open** (dev/test): comportamento degradado anterior, com log explícito.

Erros do próprio Redis (conexão perdida) também respeitam a política. Testes em `tests/unit/jwt-token-service.test.ts` cobrem: Redis ausente, cliente desconectado (`isReady: false`), Redis respondendo erro, recuperação após reconectar, e os dois modos.

---

# Fase 2 — corrigir modelo de sessão

## 2.1 Blacklist por `jti`

**Status: concluído.** A chave deixou de ser o token e passou a ser o identificador do próprio JWT:

```text
token_blacklist:jti:<jti>       # tokens emitidos a partir de agora
token_blacklist:sha256:<hash>   # tokens legados sem jti (fallback)
```

O token completo nunca vira chave de armazenamento. Cada token emitido recebe `jti` próprio (inclusive access e refresh, que antes compartilhavam o mesmo `jti` — revogar o refresh derrubava o access da mesma emissão). O TTL da entrada é o menor entre o solicitado e a vida restante do token, então a blacklist nunca cresce além da expiração natural. Tokens sem `jti` (versões anteriores) também são consultados na chave legada durante a transição.

## 2.2 Refresh rotation atômica

**Status: concluído.** O consumo do refresh token é uma escrita `SET NX` (`token_blacklist:jti:<jti> = rotated`, TTL = vida restante do token) executada **antes** de emitir o novo par. `SET NX` decide o vencedor de forma atômica no próprio Redis, fechando a janela entre "verificar" e "revogar":

- primeira requisição com o token → rotaciona (200);
- qualquer outra, inclusive simultânea → 401 `REFRESH_TOKEN_REUSED`;
- token já revogado por logout → 401 `REFRESH_TOKEN_INVALID` (distinção feita pelo valor da entrada: `rotated` vs `revoked`).

Teste obrigatório do roadmap, como E2E contra Redis real (`tests/e2e/auth-http.e2e.test.ts`):

```text
Promise.all([
  refresh(oldToken),
  refresh(oldToken)
])
// => uma 200 e uma 401
```

## 2.3 Session version / token version

**Status: concluído (na Fase 3, ver 3.3).** O token carrega `sv` (versão de
sessão) e o Redis guarda `user_session_version:<userId>`, incrementado a cada
revogação em massa. Substituiu a comparação por `iat` contra timestamp, que
produzia tokens mortos quando o login acontecia no mesmo segundo da revogação.
O timestamp (`user_tokens_revoked:<userId>`) foi mantido apenas para tokens
antigos, que não têm a claim.

---

# Fase 3 — corrigir senha e identidade

## 3.1 Escolher uma política real de senha

**Status: concluído.** A política vive em um único objeto, `PASSWORD_POLICY`
(`src/shared/utils/passwordPolicy.ts`), lido pelo middleware HTTP, pelo domínio e
pelos testes. Nenhuma camada redefine comprimento ou composição.

| Decisão | Valor | Motivo |
| --- | --- | --- |
| Mínimo | 12 caracteres | acima do mínimo de 8 da NIST, já que há composição |
| **Máximo** | **72 bytes** | bcrypt ignora o que passa de 72 bytes: aceitar mais prometeria uma proteção que o hash não entrega (verificado: duas senhas com o mesmo prefixo de 72 bytes comparam como iguais) |
| Composição | maiúscula, minúscula, número, símbolo | camada extra à checagem de senha comum; a NIST desaconselha composição, mas aqui o comprimento é exigido junto |
| Senhas comuns | 27 entradas, comparação sem caixa e por substring | cobre o caso offline sem colocar rede no caminho de registro |
| **Expiração** | **nunca** | rotação forçada empurra o usuário para padrões piores (NIST SP 800-63B); a troca é evento |
| Histórico | 5 hashes (FIFO) | impede reuso sem transformar o documento em arquivo de credenciais |

Senha continua sendo valor opaco: limite é aplicado sem tocar no valor que vai
para o bcrypt (e o limite é contado em **bytes**, para que caractere multibyte não
"pague" por um limite que o algoritmo não honra).

## 3.2 Integrar histórico

**Status: concluído.** `passwordHistory` e `passwordChangedAt` existiam no schema
Mongo e em lugar nenhum do código — estado morto. Agora:

- a entidade `User` carrega `passwordHistory` e tem `changePassword(newHash)`,
  que empurra o hash anterior (limitado a 5, FIFO) e marca a data da troca;
- `User.updateData(username, hash)` virou `User.updateUsername(username)`: **a
  senha não muda mais pela atualização de perfil**;
- novo caso de uso `AuthService.changePassword(userId, current, next)`, que
  recusa reutilização da senha atual e de qualquer uma das últimas 5;
- o adapter carrega o histórico com `select('+passwordHistory')` (o campo é
  `select: false` no schema) e o persiste no `save`;
- o hash nunca aparece em `toSafeObject`.

## 3.3 Invalidar sessões após troca de senha

**Status: concluído — decisão: encerrar todas as sessões.**

Trocar a senha chama `revokeUserTokens(userId)`: qualquer access ou refresh token
emitido antes da troca deixa de valer. Um token vazado não sobrevive à resposta
de quem suspected comprometimento, e o usuário precisa apenas fazer login de
novo.

O caminho HTTP é `PUT /password`, que **exige a senha atual** (step-up): um access
token vazado não basta para tomar a conta de forma permanente. Tentar trocar a
senha por `PUT /update` é recusado com 400.

**Bug encontrado pelos testes E2E e corrigido:** a revogação por usuário usava
`iat` (segundos) contra um timestamp em milissegundos. Um login feito no mesmo
segundo da revogação — exatamente o caso de quem acabou de trocar a senha — recebia
um token já morto. Substituído por **versão de sessão** (Fase 2.3): a claim `sv`
no token e um contador `user_session_version:<userId>` no Redis, incrementado a
cada revogação em massa. Sem dependência de relógio. Tokens antigos (sem `sv`)
continuam usando a regra por timestamp, que expira sozinha.

## 3.4 Remover `passwordExpired` se não for usado

**Status: concluído.** `passwordExpired` não era lido nem escrito em lugar
nenhum; a decisão de não expirar senha agora está explícita em
`PASSWORD_POLICY.expires = false` e documentada acima.

# Fase 4 — limpar a camada HTTP

## 4.1 Remover sanitização global de senha

**Status: concluído.** `src/application/middleware/sanitization.ts` foi renomeado para `inputNormalization.ts` e agora faz apenas o que faz sentido em entrada:

- remove caracteres de controle Unicode (C0/C1);
- **não** transforma credenciais (`password`, `newPassword`, `refreshToken`, `authorization`, ...): a lista de campos opacos é comparada sem diferenciar maiúsculas/minúsculas;
- **não** faz HTML escaping (a API responde JSON) nem "escape SQL" (não há SQL no projeto);
- `isomorphic-dompurify` e `validator` foram removidos das dependências (só eram usados aqui).

Escaping de saída continua sendo responsabilidade do ponto onde o dado é renderizado.

Testes em `tests/unit/input-normalization.test.ts` (antes `sanitization.test.ts`) expressam a nova semântica: senha e refresh token chegam intactos ao domínio.

## 4.2 Separar

```text
validation
normalization
sanitization
output encoding
```

**Status: concluído.** Fronteiras atuais:

```text
validation/      → src/application/middleware/validation.ts (formato e limites)
normalization/   → src/shared/utils/usernamePolicy.ts (identidade)
                   src/application/middleware/inputNormalization.ts (controles Unicode)
output encoding  → contexto de saída (a API responde JSON; não há renderização HTML)
```

## 4.3 Eliminar `inputValidation.ts` se ele não for o mecanismo oficial

Hoje existe uma segunda infraestrutura de validação além de `validation.ts`.

Decida qual é a oficial.

Se `express-validator` continuar sendo usada:

```text
remover InputValidator morto
```

ou migrar todo o projeto conscientemente para Joi.

---

# Fase 5 — observabilidade correta

## 5.1 Corrigir contadores de login

Substituir `failedLogins` ambíguo por métricas semanticamente corretas.

## 5.2 Separar health endpoints

Criar:

```text
/liveness
/readiness
/health
```

## 5.3 Definir `trust proxy`

Adicionar configuração explícita para ambientes atrás de proxy.

## 5.4 Reduzir confiança em `X-Request-Id` externo

Validar UUID, tamanho e charset.

---

# Fase 6 — corrigir o deployment

## Opção recomendada para este projeto

Não tentar fingir Kubernetes.

Montar um deployment real pequeno:

```text
GitHub Actions
      ↓
GHCR
      ↓
server Linux
      ↓
Docker Compose
      ↓
reverse proxy
      ↓
auth-service
```

### Implementar de verdade

- [ ] SSH/deploy para servidor.
- [ ] Pull da imagem por SHA.
- [ ] Backup da versão atual.
- [ ] `docker compose up -d`.
- [ ] readiness check.
- [ ] smoke test real.
- [ ] rollback automático se smoke falhar.
- [ ] registro da versão implantada.

Até isso existir, o CI deve chamar o estágio de deployment de `template` ou `simulation`.

---

# Fase 7 — escala real, somente depois

Caso queira demonstrar escalabilidade:

```text
                 ┌─ auth-1
client → proxy ──┼─ auth-2
                 └─ auth-3
                      │
              Redis + Mongo
```

Regras:

- remover `container_name`;
- remover bind fixo da porta por réplica;
- proxy/load balancer distribui tráfego;
- Redis mantém estado compartilhado;
- Mongo mantém persistência;
- health/readiness decide quem recebe tráfego.

Só então documentar `--scale`.

---

# Fase 8 — testes de nível profissional

Adicionar testes de segurança e concorrência, não apenas happy path.

## Obrigatórios

### Identidade

- [ ] username case-insensitive;
- [ ] username duplicado com case diferente;
- [ ] normalização de whitespace;
- [ ] username inválido.

### Login

- [ ] usuário inexistente e senha errada produzem mesma resposta;
- [ ] rate limit de login;
- [ ] brute force distribuído;
- [ ] Redis indisponível.

### Sessão

- [ ] refresh concorrente;
- [ ] refresh reusado;
- [ ] logout revoga access token;
- [ ] logout revoga refresh token;
- [ ] revoke-all;
- [ ] expiração real do token.

### Senha

- [ ] troca de senha;
- [ ] histórico;
- [ ] senha anterior rejeitada;
- [ ] sessão antiga invalidada, conforme política.

### Segurança HTTP

- [ ] `/security/*` exige credencial administrativa;
- [ ] `/metrics` exige token quando configurado;
- [ ] `/observability` exige token;
- [ ] JSON inválido retorna 400;
- [ ] headers de segurança presentes;
- [ ] CORS conforme configuração.

### Infraestrutura

- [ ] Mongo indisponível;
- [ ] Redis indisponível;
- [ ] reconexão Redis;
- [ ] restart do container;
- [ ] readiness durante startup;
- [ ] readiness após perda de dependência.

---

# Fase 9 — qualidade de código

## Reduzir complexidade

O projeto possui vários pontos em que documentação e comentários são maiores do que a lógica em si.

Priorizar:

- `securityAudit.ts`;
- `securityMonitoring.ts`;
- `inputValidation.ts`;
- `authRoutes.ts`;
- `jwtTokenService.ts`.

Não necessariamente reduzir linhas por reduzir. A meta é remover estados paralelos e decisões duplicadas.

## Exemplo de direção

Em vez de:

```text
validation.ts
inputValidation.ts
sanitization.ts
securityMonitoring.ts
securityAudit.ts
```

sem fronteiras nítidas, buscar:

```text
validation/
normalization/
security-observability/
```

cada uma com responsabilidade única.

---

# Fase 10 — limpeza final de portfólio

Depois das correções funcionais:

- [ ] atualizar screenshots/README;
- [ ] adicionar diagrama arquitetural;
- [ ] adicionar fluxo de autenticação;
- [ ] adicionar threat model resumido;
- [ ] documentar decisões de segurança;
- [ ] documentar trade-off de Redis;
- [ ] documentar estratégia de sessões;
- [ ] documentar deployment real;
- [ ] remover comentários de features não implementadas;
- [ ] substituir “production-ready” por uma descrição precisa.

---

# 19. Ordem exata que eu seguiria

Esta é a ordem prática, sem inventar mais infraestrutura:

```text
1. Proteger /security/*
        ↓
2. Normalizar username
        ↓
3. Corrigir enumeração de contas
        ↓
4. Remover sanitização de senha
        ↓
5. Corrigir failedLogins
        ↓
6. Definir comportamento Redis-offline
        ↓
7. Separar JWT_REFRESH_SECRET
        ↓
8. Trocar blacklist para jti
        ↓
9. Tornar refresh rotation atômica
        ↓
10. Integrar passwordHistory OU remover feature
        ↓
11. Remover passwordExpired OU implementar
        ↓
12. Corrigir health/readiness
        ↓
13. Corrigir Compose scaling/documentação
        ↓
14. Corrigir CI/CD declarando o que é realmente executado
        ↓
15. Implementar deploy real
        ↓
16. Criar testes de concorrência e falha de infraestrutura
        ↓
17. Atualizar README e roadmap
```

---

# 20. Meta de qualidade após essas fases

Uma meta realista seria transformar o projeto de:

```text
7,3/10
```

para algo na faixa de:

```text
8,5+/10
```

sem adicionar grandes tecnologias novas.

O salto viria de:

```text
menos promessa
+ menos duplicação
+ mais consistência
+ controles críticos realmente fechados
+ deployment real
+ testes dos casos perigosos
```

---

# 21. Conclusão técnica

O Micrologin **não é um projeto ruim e também não é apenas um CRUD maquiado**.

Ele demonstra conhecimento de:

- TypeScript;
- Express;
- arquitetura hexagonal;
- DI;
- MongoDB;
- Redis;
- JWT;
- bcrypt;
- rate limiting;
- Docker;
- CI;
- observabilidade;
- testes E2E;
- engenharia de segurança básica.

O principal problema é outro: o projeto está em um estágio onde **corrigir inconsistências vale muito mais do que adicionar tecnologia**.

A arquitetura já é suficientemente boa para crescer. O trabalho de maior valor agora é provar que os componentes existentes se comportam corretamente quando:

```text
usuário envia dados estranhos
Redis cai
Mongo cai
há concorrência
há múltiplos workers
há proxy
há token revogado
há refresh simultâneo
há tentativa de enumeração
há deployment quebrado
```

Se essas situações forem cobertas, o projeto deixa de ser apenas um showcase de arquitetura e passa a ser uma demonstração muito mais forte de engenharia de software aplicada.

---

## 22. Limitação da presente análise

O ZIP fornecido não contém o histórico `.git`, portanto não foi possível auditar o histórico de commits ou confirmar empiricamente o estado do GitHub a partir deste arquivo.

Também tentei instalar as dependências do projeto para executar a suíte localmente. A instalação de `node_modules` não terminou corretamente no ambiente de análise e as tentativas de `npm ci` excederam o tempo disponível. Por isso, os resultados executáveis aqui ficaram limitados a verificações estáticas, contagem de testes, sintaxe de shell/YAML/JSON e inspeção direta do código.

Isso significa que as afirmações sobre testes existentes são baseadas no conteúdo dos arquivos; não estou afirmando que a suíte completa foi executada com sucesso neste ambiente.
