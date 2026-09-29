# Micrologin — roadmap: criptografia, backup, escala DDoS/roubo de credenciais

**Versão do roadmap:** 2.0 (substitui a análise v1, concluída em 2026-09-28 e
preservada no histórico do git).

**Foco:** levar o serviço de autenticação de "estudo com arquitetura de
produção" para "demonstração de resiliência": criptografia mais forte,
backup/restauração reais, escalabilidade horizontal e vertical, e **provas
automatizadas** de que ele sobrevive a roubo de credenciais e a DDoS.

> **Orientações do documento:** o roadmap é a lista de TODO. Cada fase termina
> com "Estado:" e "Definição de pronto" preenchidos na implementação. Toda
> decisão de segurança registrada como `D#` em `docs/SEGURANCA.md`. Nada de
> promises — arquivo deveria provar o que faz (mesma régua da v1).

---

## 1. Estado atual (baseline medido em 2026-09-28)

| Área | Hoje | Onde |
| --- | --- | --- |
| Assinatura JWT | **HS256** simétrico (`jsonwebtoken`), access 15m / refresh 7d, `jti` + `sv` | `src/infrastructure/external-services/jwtTokenService.ts` |
| Hash de senha | **argon2id** m=64MiB/t=1/p=1, política 12–72 bytes, histórico 5, blacklist de comuns (bcrypt removido na 1.2) | `src/shared/utils/passwordPolicy.ts`, `appConfig.ts` |
| Redis | v7, AOF `appendonly yes`, **sem senha/ACL**, **sem réplica**, blacklist por `jti` com `SET NX` | `docker-compose.yml`, `connection.ts` |
| MongoDB | v7 **single node, sem auth, sem backup configurado** | `docker-compose.yml`, `models/User.ts` |
| Escala | vertical PM2 (4 instâncias) OU cluster module (4/8) OU compose 1 réplica com `container_name` + bind | `ecosystem.config.cjs`, `src/app.ts`, compose |
| Rate limit | `rate-limiter-flexible`, Redis + fallback memória **por processo** | `advancedRateLimit.ts` |
| Auditoria/obs | buckets `loginAttempts/successfulLogins/failedLogins/unavailableLogins`, `/observability` agregador **por processo** | `securityAudit.ts`, `requestLogAggregator.ts` |
| Testes | 32u/425 + 6i/38 + 1e2e/14 + infra real (`test:infra`) + k6 (`test:load`) | `tests/`, `k6/`, `scripts/infra-resilience-test.sh` |
| Deploy | `deploy.sh` com backup de imagem, readiness, smoke e rollback | `scripts/deploy.sh`, `.github/workflows/ci-cd.yml` |

**Achados relevantes para este roadmap:**

- O **refresh reusado já é detectado** (`REFRESH_TOKEN_REUSED`, `jwtTokenService.ts:560`), mas
  o reuso **não dispara resposta automática** (revogar a sessão, alertar). Hoje é só 401.
- O Redis **não exige credencial** em nenhum compose — qualquer contêiner da rede lê e
  escreve blacklist e rate limit.
- O Mongo **não tem réplica nem backup**; com escala horizontal da API, ele continua SPOF.
- O `--scale` documentado na v1 (Fase 7) **não foi implementado**: falta o proxy na frente.
- Falha de driver no rate limit **não vira 429** (D13) — base sólida para o teste de DDoS.

---

## 2. Modelo de adversário assumido (o que os testes precisam sobreviver)

```text
A1 Roubo de credenciais          atacante obtém access e/ou refresh de um
                                 usuário legítimo e tenta usar enquanto o
                                 legítimo segue ativo.
A2 Reuso de refresh              atacante repete um refresh já rotacionado
                                 (ou o legitimo e o atacante disputam).
A3 Espelhamento de senha         a senha roubada de uma conta é testada em
                                 outras contas (credential stuffing).
A4 Força bruta distribuída      muitos IPs / botnet atacando /login ao mesmo
                                 usuário ou a muitos usuários.
A5 Flood HTTP                    volume de requisições legítimas-formato sobre
                                 /login, /refresh, /register (CPU/I/O).
A6 Slowloris                     conexões abertas que não completam, travando
                                 o limite de sockets do Node/proxy.
A7 Malformados/oversized         payloads gigantes, headers estranhos,
                                 X-Forwarded-For forjado para burlar IP.
```

Cada ataque gera uma **prova automatizada** (fase 5 e 6) com assertivas de
saída: serviço segue respondendo, liveness 200, sem restart, e **se recupera**
quando o ataque para.

---

# Fase 1 — criptografia mais forte

## 1.1 Assinar JWT com curva elíptica (HS256 → ES256)

**Status: concluído em 2026-09-29.**

Trocar a assinatura simétrica por **ES256 (ECDSA P-256)** com `jose`:

- a chave **privada** assina (só em quem emite: o serviço / segredo na borda);
- a chave **pública** verifica (qualquer verificação, sem expor o segredo);
- claim `kid` no header e **rotação de chave** com período de tolerância
  (verificador aceita a chave anterior enquanto ela existir);
- `jsonwebtoken` sairia de prod se nada mais usar; manter `jose` como única lib.

Tarefas:

- [x] comparar `jsonwebtoken`(HS256) vs `jose`(ES256) e registrar decisão `D15` em `docs/SEGURANCA.md`
- [x] gerar par de chaves (development e production) e documentar provisão por KMS/secrets manager
- [x] `JWTTokenService` assina com privada e verifica com pública, `algorithms: ['ES256']`
- [x] claim `kid` obrigatória; validar token sem `kid` como erro de verificação
- [x] rotação: suportar 2 chaves simultâneas em produção (nova assina, antiga ainda é aceita verificar; prazo curto e agendado)
- [x] `validateConfiguration`: produção exige chaves reais (não placeholder) e recusa HS256
- [x] testes: assinar/verificar, token com `kid` errado, chave antiga durante a janela de rotação, token sem `kid`
- [x] E2E e `test:infra` verdes com o novo esquema (o smoke de deploy assina e verifica de ponta a ponta)

**Definição de pronto:** verificação usa chave pública em todos os ambientes; a
chave privada não é necessária em verificador; teste de rotação cobre janela de
tolerância; produção valida `kid` presente.

**Estado:** implementado. `src/infrastructure/external-services/jwtSigner.ts`
tem `Hs256Signer` (dev/test) e `Es256Signer` (produção) atrás de `TokenSigner`;
o `JWTTokenService` perdeu a assinatura direta e delega. `algorithm` (e o bloqueio
de HS256 em produção) vive em `validateConfiguration`, coberto por
`security-config.test.ts`. **Provas executadas:** `test:infra` verde com uma
asserção nova que lê o header do token real emitido pelo container (`alg=ES256`,
`kid` do par do teste); `test:e2e` verde rodando o app em **ES256** (14 testes),
também conferindo `alg`/`kid` no login.

**Incidente pago no caminho:** `generate-jwt-keys.sh` emitia a privada em SEC1
(`openssl ecparam -genkey`) e o `jose` só importa PKCS#8 — o container subia, o
health respondia, e **todo login devolvia 401 de credencial inválida** porque a
assinatura falhava; o erro real sumia no log (o `logger` espalhava `Error` com
spread e `message`/`stack` são não-enumeráveis). Corrigido nas três pontas: o
script emite PKCS#8 e confere o formato; o emissor aceita SEC1 (conversão via
`node:crypto`); o `logger` serializa `Error` de verdade. Dois testes novos
travam a costura: `tests/unit/jwt-key-provisioning.test.ts` executa o script real
e assina com a chave que ele produziu, e `logger.test.ts` garante que a falha
aparece com mensagem e stack.

## 1.2 Decisão de hash de senha: argon2id, medido no serviço

**Status: concluída.** Decidido por medição no mesmo orçamento de produção
(2.0 CPU, 512 MB): `D16` e `D17` em `docs/SEGURANCA.md`, números completos em
`docs/metricas.md`.

- [x] benchmark: bcrypt(cost 12/13) vs argon2id em três pontos da escada OWASP
      vs `m=64MiB, t=3, p=4` do roadmap — tempo por hash, verify, RSS de pico
      e concorrência (`scripts/benchmark-password-hash.mjs`, `npm run bench:hash`)
- [x] p95 de `/login` real antes e depois (`scripts/measure-login-latency.mjs`,
      `npm run bench:login`), porque o benchmark de hash não é o endpoint
- [x] decisão `D16`: **argon2id m=64MiB, t=1, p=1** (medido: 3.4x a memória por tentativa do atacante com a mesma latência de login)
- [x] reescrita sem quebrar usuários: `compare` lê os parâmetros do hash
      guardado, rehash no próximo login, escrita best-effort
- [x] **bcrypt removido do projeto** (laboratório, sem usuários antigos):
      `BcryptAdapter`, dependência `bcrypt`, `PASSWORD_HASH_ALGORITHM` e
      `BCRYPT_SALT_ROUNDS` fora. `compare` entende só argon2id; qualquer outro
      valor é credencial ilegível (`false` + aviso no log), nunca aceito
- [x] avaliar **pepper** `D17`: mecanismo pronto (envelope versionado `p1:$...`,
      rotação com `PASSWORD_PEPPER_PREVIOUS`), **desligado por padrão**
- [x] manter limites: senha opaca, máximo em bytes, histórico 5 (intactos)

**Hardware medido (server01):** Intel Core i5-7200U, 4 vCPU, 12 GB de RAM,
GT940MX de 4 GB. O `mem_limit` do container de produção é 1 GiB e o limite de
CPU é 2.0 (metade dos núcleos da máquina). A GT940MX não entra: argon2 é CPU.

**O que a medição mudou em relação ao plano:** o `m=64MiB, t=3, p=4` sugerido
aqui é **2.7x mais barato** que o bcrypt 12 que já rodava (133.4 ms contra
365.7 ms) e pede **326 MB de pico** com 4 logins simultâneos — 64% do container.
O bcrypt 12 era 13x mais caro que o argon2id da OWASP e menos resistente, por
não ser memory-hard. Resultado no `/login` real: p95 de **491 ms → 45.4 ms** em
c=1 e **1868 ms → 191 ms** em c=8, com 2.5 → 29.1 logins/s.

**Segunda rodada, depois de identificar o hardware:** o `mem_limit` subiu de
512 MB para **1 GiB**, e a conclusão sobre `p=4` mudou. O argumento costumeiro
("4 threads por requisição faz 2 logins ocuparem o container") não se sustenta:
o paralelismo do Argon2 é o mesmo CPU compartilhado, e medir no servidor deu 20
logins/s para `p=4` contra 29 do `p=1` no mesmo `m=64MiB` — pior com mais CPU,
não melhor. O que sobra é o argumento dos autores do Argon2: `p>1` entrega poder
computacional ao atacante sem devolver defesa proporcional.

Também mediu-se que **mais memória não compra throughput**: com 4 GB, o `m=64MiB`
continua pedindo 325 MB de pico e continua entregando ~1/6 dos logins/s do mínimo
OWASP. O teto medido bate com `núcleos ÷ tempo_por_hash`, ou seja, o serviço está
limitado por CPU. `m=46MiB, t=1, p=1` (segunda recomendação da OWASP) cabe
folgado nos 1 GiB e é uma troca legítima entre resistência e latência, mas custa
1.8x a CPU e devolve 1/3 do throughput (45 contra 137 logins/s) — mantida a
19 MiB por enquanto.

**Definição de pronto:** decisão D16/D17 registradas com dado medido (não por
palpite), e reescrita sem quebrar quem já tem conta (login antigo continua
funcionando até o rehash). — **cumprida: 500 unit + 38 integração + 15 E2E
(incluindo reescrita de hash fraco com Mongo real) + `test:infra` 10/10, todos
verde.**

**Correção que a troca expôs:** o schema do Mongo validava o campo `password`
com a política de senha em texto claro (12–72 caracteres). O hash argon2id tem
~100 e era recusado na gravação, e o registro devolvia 400. A política vale para
o que o usuário digita; o campo do banco guarda hash e passa a validar como
hash. O teto de 72 bytes deixou de ser herança do bcrypt: o argon2id não trunca,
então virou escolha do serviço.

## 1.3 Credenciais em repouso das dependências

**Status: pendente.** Redis e Mongo hoje não pedem senha.

- [ ] Redis: `requirepass`/ACL no compose prod + `REDIS_PASSWORD` no `connection.ts` e no URL
- [ ] Mongo: criar usuário próprio do serviço (`authSource=admin`), sem privilégio além do necessário
- [ ] TLS entre auth-service e Redis/Mongo em prod (ou rede interna dedicada, decisão explícita)
- [ ] segredos via variável/arquivo de secrets, nunca no compose versionado
- [ ] nomes de usuário de aplicação não admin no Mongo

**Definição de pronto:** `docker-compose.prod.yml` sobe Mongo/Redis exigindo
credencial; app autentica; teste de infra valida que sem credencial a conexão
falha (composição isolada).

## 1.4 Ciclo de vida de chaves e segredos

- [ ] ROTAÇÃO documentada e testada para: JWT ES256 (1.1), pepper (se aceitar), senhas de Mongo/Redis
- [ ] guarda da chave privada ES256 fora do repositório (secrets manager/KMS)
- [ ] gitleaks + audit contínuo já existem; validar que as chaves novas não caem em `.env*` versionado

---

# Fase 2 — backup e restauração

## 2.1 MongoDB: backup criptografado, retenção e restauração real

**Status: pendente.** Não existe nada hoje.

- [ ] `scripts/backup.sh`: `mongodump` → tar → **criptografia (age/gpg simétrico)** → destino com rótulo `sha-data` + data
- [ ] retenção: manter N diários + M semanais; poda automática
- [ ] RPO/RTO definidos e documentados (ex.: RPO 24h, RTO ≤ 15 min — ajustar à realidade)
- [ ] `scripts/restore.sh` com **drill real**: restaura o dump no compose isolado e executa fluxo de login
- [ ] `npm run test:backup` (ou passo de CI manual) que: gera dump, apaga o banco, restaura, valida usuário sobreviveu
- [ ] alerta quando backup falha ou fica velho (fonte: authEventSink / log estruturado já existente)
- [ ] documentar restauração pontual só com o dump criptografado (sem acesso ao servidor)

**Definição de pronto:** existe um backup criptografado (verificável: `age -d`
devolve o dump íntegro), um restore já exercitado localmente de ponta a ponta, e
um teste que falha de verdade se a restauração não reconhecer um usuário.

## 2.2 Redis: o estado perdido e o que recuperar

O Redis guarda blacklist, rotação, versão de sessão e rate limit. **Perda do
Redis = tokens revogados voltam a valer e rate limit reseta** (controle de
sessão amnésico até expirar). Decisões:

- [ ] persistência explícita: AOF `fsync=everysec` + RDB snapshot no compose prod (hoje só AOF default)
- [ ] política quando Redis some de vez (falha de disco): fail-closed derruba revogação? ou religa e aceita janela curta? decidir `D18`
- [ ] backup de Redis **intencionalmente não é o objetivo primário**: re-registrar sessões revogadas é inviável; documentar que o Redis é regenerável (login novo) e o Mongo é a fonte de verdade
- [ ] snapshots de Redis (por fora) só para diagnóstico forense, não para restore de serviço

**Definição de pronto:** RPO/RTO documentados separando Mongo (restaurável do
dump) de Redis (regenerável por design); decisão D18 registrada.

## 2.3 Backup da configuração e da versão em vigor

- [ ] já existe (Fase 6 v1): imagem anterior + `deployed-version`. Estender com backup de `.env.prod` e compose usados
- [ ] teste de que o deploy consegue restaurar imagem **e** configuração

---

# Fase 3 — escala vertical (dimensionar para cima antes de escalar para fora)

## 3.1 Baseline de capacidade

**Status: pendente.**

- [ ] rodar `npm run test:load` com p50/p95/p99 e taxa de erro para: 1 worker, 100/200/400 VUs em /health, /login, /refresh, /register
- [ ] medirmemória RSS e heap com `--max-memory-restart` do PM2 (hoje 500M) e limites do compose (512m)
- [ ] guardar resultado em `docs/metricas.md` (ou no README) como referência "quanto um worker aguenta"
- [x] custo de autenticação já medido: o hash era 13x mais caro que o argon2id mínimo e dominava o `/login` (p95 de 491 ms → 45.4 ms em c=1)

**Definição de pronto:** tabela publicada com capacidade por worker e por réplica, e o gargalo identificado com número.

## 3.2 Tuning de Node/PM2

- [ ] workers = CPUs disponíveis (não fixo 4 cego); documentar relação `PM2_INSTANCES`/`CLUSTER_WORKERS`
- [ ] heap e GC sob carga (v8 max-old-space), timeouts, `keep-alive` no servidor HTTP
- [ ] validar que dois mecanismos de cluster (PM2 e cluster module) nunca ativos juntos (já há `CLUSTER_ENABLED=false` sob PM2 — manter como teste)
- [ ] limites de requisção em andamento (concurrent requests) como disjuntor de memória (importa também para DDoS, Fase 6)

---

# Fase 4 — escala horizontal (réplicas atrás de proxy)

## 4.1 Proxy na frente (nginx) e réplicas sem `container_name`

**Status: pendente (era a "Fase 7 só depois" da v1 — agora é o objetivo).**

```text
       ┌─ auth-1 ─┐
client→ nginx ────┼─ auth-2 ── Redis (compartilhado)
        (TLS)     └─ auth-3 ── Mongo (single node: ver 4.3)
```

- [ ] `auth-proxy` (nginx) no `docker-compose.prod.yml`: terminação TLS, `limit_req`/`limit_conn` (herda Fase 6)
- [ ] remover `container_name` e bind fixo da porta do `auth-service`; apenas o proxy publica porta
- [ ] `x-forwarded-for` confiável: `TRUST_PROXY` = faixa do proxy no prod (hoje default false — decisão consciente)
- [ ] `upstream` com `max_fails`/`fail_timeout` usando `/readiness` como health de participação
- [ ] provar `docker compose up -d --scale auth-service=3` com smoke + `test:infra` verdes
- [ ] rate limit global confirmado via Redis entre réplicas (uma réplica vê o consumo da outra); se Redis cai → fallback por processo **documentado como degradação explícita**
- [ ] `/observability` é por réplica: expor `instance_id` no snapshot e documentar que a visão global vem do sink (`authEventSink`), não do agregador local

**Definição de pronto:** nginx distribui, readiness remove a réplica quebrada,
autenticação de uma réplica enxerga a revogação feita na outra, e o teste
`--scale` faz parte da suite (como `test:infra`).

## 4.2 Mongo com réplicas (HA) ou single node documentado

- [ ] decidir: **replica set (3 nós, primário+2)** para o repositório ficar à altura do proxy, **ou** manter single node com backup (Fase 2) e declarar o limite
- [ ] se replica set: `docker-compose.prod.yml` com 3 nodos, scripts de inicialização, app usa `replicaSet=` na URI
- [ ] se single node: registrar em `docs/ARQUITETURA.md` que o Mongo é o ponto de falha único **ainda que** a API escale

**Definição de pronto:** decisão registrada, e o teste de failover (se aplicável)
executa: primário cai, leitura/escrita seguem no novo primário, app reconecta.

## 4.3 Sessão e identidade em escala

- [ ] revogação entre réplicas (já via Redis) — teste com 2 réplicas: logout na A derruba token validado na B
- [ ] rate limit de login global entre réplicas (brute force distribuído não ganha orçamento ×N)
- [ ] consistência do Mongo em réplicas: único writer (primary) — leituras de `findByUsername` no login, aceitáveis com `readConcern` local; documentar

---

# Fase 5 — sobrevivência a ataque de roubo de credenciais

## 5.1 Resposta automática ao reuso de refresh (detecção já existe, resposta não)

**Status: pendente — hoje `REFRESH_TOKEN_REUSED` vira só 401.**

- [ ] no reuso detectado (`consumeRefreshToken`), além do 401: **revogar a sessão do usuário** (`endSession`), marcando `sv` — o atacante e o token antigo morrem juntos
- [ ] evento de segurança `token_reuse_detected` para a auditoria + alerta de gravidade alta via `authEventSink`
- [ ] distinção honesta: reuso pode ser erro de cliente (proxy fazendo retry) — o 401 continua, e a resposta agressiva é **condicionável** (`AUTO_REVOKE_ON_REUSE`, default protocolo: revogar)
- [ ] testes: refletir esse comportamento novo no `tests/e2e` e unit do `jwt-token-service`
- [ ] atualizar README/SEGURANCA (contrato muda: reuso ≠ só 401)

**Definição de pronto:** um teste provando que dar um refresh já usado, com o
usuário logado em outro device, derruba a sessão do device legítimo **e** o
reuso em seguida dá 401 com outro código.

## 5.2 Suite de sobrevivência a roubo de credenciais

Uma suíte nova (`tests/security/credential-theft.survival.test.ts` + script) que
encena o ataque contra a stack real e asserta que o **legítimo continua vivo**:

| Cenário | Ação | Assertiva |
| --- | --- | --- |
| T1 refresh roubado e usado | atacante usa o refresh do usuário legítimo | 401 reuso; **sessão revogada**; legítimo precisa relogin; alerta registrado |
| T2 access roubado pós-troca de senha | legítimo troca senha; atacante usa access antigo | 401 (`sv` antigo); legítimo segue autenticado com o novo |
| T3 refresh roubado pós-logout | legítimo faz logout; atacante usa refresh | 401 `REFRESH_TOKEN_INVALID`; nada aceito |
| T4 pair roubado + uso simultâneo | legítimo e atacante disputam o mesmo refresh (concorrência) | um ganha (200), o outro 401 reuso; sessão revogada após decisão |
| T5 senha vazada aplicada em outras contas | senha da conta A usada em B/C (carta de força de "credencial stuffing") | taxa de sucesso = baseline (não há como detectar igualdade de hash barata — registrar limite no leia-me; opcional: hash igual predito = relogin forçado) |
| T6 simulação de comprometimento | "achou" que foi roubado: muda senha + logout all | todos os tokens mortos imediatamente (já coberto; refazer na suite de sobrevivência) |

- [ ] cada cenário roda **com Redis real** (compose isolado, como `test:infra`) e **também sem Redis** para medir o modo fail-closed
- [ ] métricas de saída: tempo entre o primeiro uso do atacante e a detecção (≤ 1 rotação), e zero acesso do atacante a `/profile` depois da revogação

**Definição de pronto:** suite nova verde, documentada, e com 2 assertivas que
quebram o build se a resposta automática for removida (mutation check).

## 5.3 Alerta e observabilidade do roubo

- [ ] evento/risco "credenciais provavelmente comprometidas" no manifesto `/observability` e no sink
- [ ] log estruturado com `auth_outcome=reused`, `auth_code=TOKEN_REUSE_DETECTED`

---

# Fase 6 — sobrevivência a ataque DDoS

## 6.1 Camadas de contenção (proxy → app → OS)

- [ ] nginx: `limit_req` por IP na borda, `limit_conn`, `client_max_body_size`, `client_body_timeout`/`client_header_timeout`, `keepalive` tuning
- [ ] app: limite de requisições em andamento (disjuntor), continuação do rate limit por IP/usuário/login (já existentes)
- [ ] OS/container: `net.core.somaxconn`, `sysctl` documentados, limites de FD, `init` já presente (dumb-init)
- [ ] `X-Forwarded-For` : com `TRUST_PROXY` correto, IP real do cliente alimenta o rate limit (hoje default `false` — em prod atrás do proxy será faixa do nginx)

## 6.2 Suite de sobrevivência DDoS

Script novo estilo `test:infra` (`scripts/ddos-survival-test.sh` + compose
isolado) que dispara e mede:

| Ataque | Ferramenta | Assertiva |
| --- | --- | --- |
| A5 flood HTTP em /login, /refresh, /register | k6 (`k6/load-test.js` com cenário de sobrecarga) | p95 dentro do limite após rate limit engajar; 429s; **liveness 200 durante o ataque**; RestartCount 0 |
| A4 força bruta distribuída (muitos IPs) | k6 com `X-Forwarded-For` variado atrás do proxy | limite global (Redis) segura: nº de tentativas aceitas ≤ baseline; sem vazamento via roll-over de IP |
| A7 payload oversized / malformados | script HTTP com corpos 10MB+, JSON inválido em lote | 400/413, sem 5xx, sem pico de memória RSS, liveness 200 |
| A6 slowloris | script Node de sockets parciais (sem dependência externa) | conexões morrem por timeout (proxy), app continua respondendo; sem esgotar FD |
| A5 pós-ataque | após parar o ataque | serviço volta ao p50 baseline sozinho (auto-recuperação) |

- [ ] k6: adicionar cenários de sobrescrita (override) além do corrente; thresholds de p95/erro por rota
- [ ] assertivas duras no script (+ sample no CI remoto quando houver infra): `liveness==200`, `RestartCount==0`, `rate_limited>0`, `recovery p95 < baseline`
- [ ] documentar limites operacionais atingidos (ex.: "sem proxy, 400VUs derrubam 1 worker; com proxy, aguenta 2s de rajada" etc.)

**Definição de pronto:** script roda de ponta a ponta contra a imagem de
produção, mostra o serviço segurando os 5 cenários (ou registra quais limites de
capacidade foram os primeiros a ceder — e o porquê), e termina com o serviço
saudável sem intervenção manual.

## 6.3 O que NÃO é objetivo do teste DDoS

- [ ] simular ataques de rede (SYN flood de verdade, UDP/amplificação): são da borda do provedor/CDN, não do serviço. Se entrar CDN, documentar.
- [ ] prometer que o app sozinho segura botnet gigante: a contenção é em camadas; o teste mede **o serviço não ser o elo que cai primeiro**.

---

# Fase 7 — fechamento de portfólio

- [ ] README: nova seção "Resiliência" com o que cada suite prova (backup restaured, escala, roubo de credenciais, DDoS) e como rodar (`test:backup`, `test:ddos`, `test:credential-theft`)
- [ ] `docs/SEGURANCA.md`: decisões D15–D18 + threat model atualizado com os 7 ataques
- [ ] `docs/ARQUITETURA.md`: diagrama com proxy, réplicas e + fluxo de backup/restore
- [ ] CI: rodar as suítes novas no que couber (unit/survival sem derrubar serviço de verdade); `test:infra`/`test:ddos` documentados como provas locais/de host
- [ ] validar `deploy.sh` + smoke + rollback com ES256 e com Redis/Mongo autenticados

---

## O que NÃO será implantado agora (escopo explícito)

```text
- Kubernetes (sobre complexidade que compose+nginx resolve)
- OpenTelemetry/Kafka/RabbitMQ (continuam do lado do authEventSink, não do core)
- CDN/WAF de provedor (se entrar, é camada externa documentada)
- OAuth provider / SSO / captcha externo
- service mesh / feature flags sofisticadas
```

## Meta de saída

```text
antes (v1):  7,3/10, "estudo com arquitetura de produção"
depois (v2): criptografia assimétrica + backup restaurável + prova de escala
             horizontal/vertical + 2 suítes de sobrevivência (roubo de
             credenciais e DDoS), todas executadas de verdade
```

Tudo que este roadmap promete termina em **código e teste executados**, no
mesmo padrão da v1: nada de caixa marcada sem artefato.