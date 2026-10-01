# Micrologin — pendências abertas (checkup de 2026-10-01)

**Substitui** o roadmap v2 (criptografia, backup, escala, DDoS), cuyo conteúdo foi
removido: as fases dele foram executadas e estão provadas por artefato, o que
sobravou foi reescrito aqui como lista de defeitos e provas faltantes.

**Por que este documento existe.** O roadmap v2 se declarava bloqueado em cinco
lugares por "Docker CLI ausente neste host". O Docker 29.8.1 estava disponível e
funcionando; as provas foram executadas. Duas delas **falharam por defeito real
de teste**, não por falta de ambiente — e uma caixa marcada `[x]` não tem
artefato atrás. Este documento é o que falta, em ordem de execução.

## 1. O que o checkup executou (verde, com número)

| Prova | Comando | Resultado |
| --- | --- | --- |
| Portões | `lint`, `typecheck`, `test:secrets` | verdes |
| Unidade | `test:unit` | 628/628 em 48 suítes |
| Integração | `test:integration` | 38/38 |
| E2E | `test:e2e` | 15/15 contra stack real |
| Roubo de credenciais | `test:credential-theft` | 15 E2E + 7 (T1–T6) |
| Infraestrutura | `test:infra` | 13/13 |
| Persistência Redis | `test:redis` | RTO 0,6 s; revogado continua revogado |
| Backup/restore | `test:backup` | dump → gpg → apaga → restaura → login 200, RTO 1 s |
| Config/rollback | `test:config-backup` | imagem + config v1 restauradas |
| DDoS | `test:ddos` | **falha** — ver P1 |
| Capacidade | `test:capacity` | não reexecutado pós-tuning — ver P9 |

---

# 2. Problemas, em ordem de correção

## P1 — `scripts/ddos-survival-test.mjs`: dois defeitos que impedem a Fase 6.2 de fechar

### P1.a — Schema errado do `--summary-export` do k6 (inviabiliza a suíte)

O runner lê `summary.metrics.<nome>.values.count`
(`scripts/ddos-survival-test.mjs:282-284`). O `--summary-export` do k6 grava
`summary.metrics.<nome>.count`, sem o wrapper `values` — é o formato do
dashboard web, não do export.

Medido com k6 v1.2.2: `metrics.ddos_rate_limited` = `{"rate":…,"count":95747}`,
`'values' in metrics.ddos_rate_limited === false`.

Duas consequências, e a segunda é a grave:

1. `rateLimited` lê 0 sempre, então `rateLimited < 1` **sempre lança** — a
   suíte não passa em nenhuma hipótese. Na execução real o k6 reportou 3848
   429s e o runner affirmou "não observou 429".
2. `livenessFailures` e `serverErrors` também leem 0 sempre. As guardas
   `livenessFailures !== 0` e `serverErrors >= 5` **nunca disparam**: são
   código morto. Uma regressão real de liveness durante o flood passaria
   silenciosa, que é exatamente o que a suíte existe para pegar.

**Pronto quando:** o runner lê `.count` e uma execução real passa a reportar
`rateLimited > 0`; e um teste unitário do parser falha se o formato mudar.

### P1.b — `process.pid` não identifica réplica (asserção instável)

`observeReplicaPids` (`scripts/ddos-survival-test.mjs:107-123`) provava que o
proxy alcançava réplicas distintas por `pid` do `/liveness`. PID é por
namespace de container: medido na stack de 3 réplicas, **réplicas 2 e 3
reportaram `pid: 8` cada**. A asserção `size >= 2` passa ou falha por acaso —
falhou na 1ª execução (`O proxy alcançou 1 PID(s)`).

Descartadas as outras causas antes de atribuir ao teste:

- nginx isola: `least_conn` + `resolve` distribuiu 8/8/7/7 em 4 backends;
- o DNS do Docker devolve os 3 IPs do serviço;
- com espera, a distribuição real é 20/20/20 e 3 PIDs distintos.

O campo correto já existe e está documentado no roadmap v2 (Fase 4.1):
`/observability` → `service.instance_id` (`observability.ts:89`), que devolveu
`715084955bbe` / `8f0e479ad0f3` / `e65739ebea1b` para as três réplicas.

**Pronto quando:** `test:ddos` verde de ponta a ponta com
`apiReplicasObserved >= 2`, o resultado registrado em `docs/metricas.md`, e um
teste que prova que duas réplicas com o mesmo PID são distinguidas.

## P2 — `AUTO_REVOKE_ON_REUSE`: caixa `[x]` sem artefato, e o mutation check que a 5.2 exige

O roadmap v2 marcou `[x]` "testes unitários/integrados provam revogação,
**opt-out**, indisponibilidade e evento". Revogação, indisponibilidade
(503 `REVOCATION_UNAVAILABLE`, provada no `test:infra`) e evento existem.
O opt-out não: `autoRevokeOnRefreshReuse` é lido em `src/domain/index.ts:680`
e nenhuma passagem em `tests/` menciona o parâmetro.

Não é cosmético. O opt-out **é** o "mutation check" da Definição de pronto da
5.2 ("2 assertivas que quebram o build se a resposta automática for removida"):
sem ele, apagar a revogação automática não quebra nenhum teste.

**Pronto quando:** com `AUTO_REVOKE_ON_REUSE=false`, o reuso devolve 401 e
**não** revoga a sessão nem emite o evento de alta gravidade; com o padrão, os
dois acontecem. As duas metades no mesmo arquivo de teste.

## P3 — Fase 4.3: revogação cruzada entre réplicas e logout pelo proxy

Prova existente é de nível de serviço, com Redis em memória e JWT em memória
(`test:infra` roda com **uma** réplica). O contrato que a Fase 4 promete — "uma
réplica enxerga a revogação feita na outra" — não foi provado com containers.

O proxy distribute: `test:ddos` alcançou 3 réplicas (P1.b) e o rate limit via
Redis compartilhado segurou 3945 respostas, o que já é evidência de estado
compartilhado entre réplicas.

**Pronto quando:** com 3 réplicas atrás do proxy, um access token emitido pela
réplica A é rejeitado (401) pela réplica B depois que a revogação é feita em A;
e um logout HTTP através do proxy invalida a sessão para todas.

**Resolvido.** `npm run test:replica-session`
(`scripts/replica-session-test.mjs`, artefato em
`tests/unit/replica-session-driver.test.ts`). Três réplicas atrás do proxy TLS,
chave ES256 provisionada e Redis/Mongo únicos, com as réplicas endereçadas pelo
IP interno via `docker inspect` — o proxy é usado só para revogar, as
verificações vão direto ao container, para que o 401 observado venha da réplica
certa e não de round-robin.

Verificado em execução real: 3 réplicas distintas alcançadas pelo proxy;
token aceito nas 3 **antes** de revogar (chave compartilhada, senão o 401
seguinte seria por motivo errado); logout pelo proxy com 401 nas 3; refresh
roubado recusado; troca de senha com 401 do token antigo nas 3; sessão nova
aceita nas 3 (a revogação não é um no-op).

Os quatro modos de "passar pelo motivo errado" são guardados por teste, e cada
guard foi checado por mutação:

| Mutação | Guard que reprova |
| --- | --- |
| Remove a verificação pré-revogação | `verifica o token válido em todas as réplicas antes de revogar` |
| Remove a sessão nova pós-troca | `prova que a revogação não é um no-op` |
| Consulta as réplicas pela URL do proxy | `endereça as réplicas pelo IP interno` |
| Baixa o piso de réplicas para 1 | `exige no mínimo duas réplicas por padrão` |

O piso de 2 réplicas é o que impede a tautologia: com uma única réplica no
upstream, "aceito / revogado / aceito de novo" passa sem compartilhar nada.

## P4 — Fase 5.2: T1–T6 nunca rodaram contra Redis real

`tests/security/credential-theft.survival.test.ts:7` monta o Redis como um
`Map` em memória com `jest.fn()`. A suíte também roda em **HS256**, não ES256,
porque `makeRedisClient`/`makeHarness` não exercitam o caminho de assinatura de
produção.

**Pronto quando:** os seis cenários rodam contra o Redis do compose, com o
mesmo resultado; a detecção de reuso acontece em ≤ 1 rotação; e o atacante
não tira 200 de `/profile` depois da revogação. Registrar o tempo medido.

**Resolvido.** `npm run test:credential-theft:real-redis`
(`tests/security/credential-theft.real-redis.test.ts`). Os corpos de T1–T6 foram
extraídos para `tests/security/credential-theft.scenarios.ts` e são registrados
pelas duas suítes — a de memória e a de Redis real. É a mesma forma de garantir
"mesmo resultado" nas duas: se cada suíte tivesse o seu próprio corpo, a segunda
estaria medindo o próprio teste em vez do código.

Contra o Redis do compose (DB 15, exclusivo), assinatura ES256 com `kid`, e o
mesmo par de chaves e store usados pelo app real no booted da prova HTTP:

| Medida | Valor |
| --- | --- |
| Cenários T1–T6 contra Redis real | 6/6, mesmos desfechos que em memória |
| Rotação concedida ao atacante antes da detecção | 0 |
| Repetições do refresh roubado detectadas como reuso | 5 de 5 |
| Latência da detecção de reuso | 5,56 ms (1ª tentativa) / 4,82 ms |
| `/profile` com token do atacante após revogação | 401 |
| Segundo device da mesma identidade após revogação | 401 |
| Refresh roubado em nova tentativa | 401 `REFRESH_TOKEN_INVALID` |

O último item importa mais que o `REFRESH_TOKEN_REUSED` da primeira: a segunda
tentada dizer `INVALID`, e não `REUSED`, o que mostra que a primeira gravou
estado de verdade, e não respondeu com uma string.

Guardas contra passar pelo motivo errado, cada uma checada por mutação:

| Mutação | Efeito |
| --- | --- |
| `SET NX` perde o `NX` em `consumeRefreshToken` | T4 reprova — sem atomicidade real não há vencedor único |
| Harness cai para um `Map` local | 10 de 14 reprovam; a guarda que pega é a leitura por conexão independente |

O `Map` em memória continua no lugar, e continua útil: ele roda sem Docker e
é onde a detecção de reuso é exercitada sem custo. O que ele **não** prova é
atomicidade — T4 passa lá por serialização do event loop, e é por isso que a
suíte real existe.

**Limite conhecido, não coberto:** estas suítes são escritas do ponto de vista
do atacante. Substituir o `INCR` da versão de sessão por um valor arbitrário
(over-revocation, todo usuário deslogado) **não** reprova nenhuma delas, porque
revogar demais produz o mesmo 401 que revogar o suficiente. A direção oposta —
revogação que é no-op — é o que P3 fecha, com a sessão nova aceita após a troca
de senha.

## P5 — Fase 6.2: limites operacionais atingidos não documentados

Medido com `npm run test:ddos` depois das correções de P1 (os números da
primeira execução verde foram substituídos porque o parser de `.values.count`
zerava as contagens):

| Métrica | Valor |
| --- | --- |
| Réplicas alcançadas pelo proxy | 3 |
| Respostas limited-as (429) | 4124 |
| Falhas de liveness durante o flood | 0 |
| Respostas 5xx durante o flood | 0 |
| p95 de liveness baseline → recuperação | 3,2 ms → 4,5 ms |
| JSON malformado / payload de 10 MB | 400 / 413 |
| Conexões Slowloris encerradas no prazo | 20/20 |
| Pico de memória por container | 226,3 MiB |
| Reinícios de container | 0 |

**Pronto quando:** a tabela acima estiver em `docs/metricas.md` com a
ressalva do que não foi medido (SYN flood e amplificação ficam na borda) e uma
decisão `D#` nova registrada sobre o primeiro limite a ceder.

**Resolvido.** §6 de `docs/metricas.md` ("Contenção na borda sob flood"), com a
ressalva de escopo e a seção "Primeiro limite a ceder". Decisão nova **D29** em
`docs/SEGURANCA.md`: o que cede primeiro é o orçamento por IP (4124 respostas
429), depois o de login por conta, e nunca a disponibilidade.

O item tinha um segundo defeito, não listado: as medições já estavam feitas e a
documentação ainda afirmava o contrário. D26, D27 e a tabela de cobertura do
modelo de ataque diziam "medição Docker/k6 pendente" e "E2E real aguarda host
Docker" depois de executados. Documento que afirma medir menos do que mede é o
mesmo defeito de documento que afirma medir mais, então as linhas foram
corrigidas — e a única lacuna real que restou foi declarada: **failover ativo**
(nginx OSS não remove upstream por `/readiness`).

Artefato: `tests/unit/operational-limits-doc.test.ts` (13 testes). Cada número
citado na documentação é conferido contra o arquivo que o produz, não contra a
própria documentação — `somaxconn` e `nofile` contra o Compose de produção,
`max_fails`/`fail_timeout` contra o conf do nginx, e as chaves da tabela contra o
JSON que o runner emite. Três mutações confirmam que as guardas mordem:

| Mutação | Efeito |
| --- | --- |
| `nofile` da API vai de 8192 para 16384 e a doc não acompanha | reprova |
| A5 volta a "medição pendente" | reprova |
| Ressalva de SYN/amplificação apagada | reprova 5 de 13 |

## P6 — Fase 7: `deploy.sh` nunca é exercitado

`test:config-backup.sh` prova o caminho de rollback (`backup-config.sh` +
`restore-config.sh` + reload do compose) e `infra-resilience-test.sh` roda o
smoke. `deploy.sh` em si — orquestração de backup de imagem, readiness, smoke
e rollback — não é chamado por nenhum drill: nos dois scripts ele só aparece em
comentário.

**Pronto quando:** um drill executa `deploy.sh` contra a stack de teste
(ES256 + Mongo/Redis autenticados), confirma o smoke e força um rollback,
provando que volta para a versão anterior com a configuração correta.

## P7 — Fase 3.2: exclusão mútua entre PM2 e cluster module não é testada

`tests/unit/cluster-config.test.ts` tem 5 casos, todos de contagem de workers
(cota do cgroup, `maxWorkers`, fallback sem `availableParallelism`). Nenhum
afirma que PM2 e cluster module nunca ficam ativos juntos. O roadmap v2 pedia
"manter como teste"; hoje a garantia é só o `CLUSTER_ENABLED=false` no
`.env.prod`.

**Pronto quando:** um teste falha se `CLUSTER_ENABLED` e o PM2 estiverem ambos
ativos, cobrindo o bootstrap e o `ecosystem.config.cjs`.

## P8 — Fase 3.2: heap e GC sob carga

Item aberto, sem artefato. Atenção ao p50 de 17,7 s do `/register` a 400 VUs
(`docs/metricas.md` §3).

**Pronto quando:** medição de heap/GC sob a maior carga medida, e o
`--max-old-space-size` fixado por esse dado — ou a decisão registrada de não
fixar, com o número que justifica.

## P9 — Fase 3.2: `test:capacity` não reexecutado após o tuning

Os artefatos em `artifacts/capacity` são de 2026-09-30 13:40; o tuning de
`inFlightLimit` e o limite 1024 são das 14:xx do mesmo dia. A §3 e a §4 de
`docs/metricas.md` descrevem o estado pré-tuning.

O driver também tem um fix **não commitado** (trap de teardown instalado antes
do primeiro `compose up`, para um `NODE_OPTIONS` inválido não deixar o serviço
em crash-loop no orçamento de medição) que **não foi verificado**.

**Pronto quando:** `test:capacity` verde do começo ao fim (o que valida o fix
do driver), e §3/§4 atualizadas com o contraste pré/pós-tuning.

## P10 — Papel desatualizado

1. Cinco afirmações do roadmap v2 diziam "Docker CLI não está instalado neste
   host" / "prova de Docker pendente". Desatualizadas — este documento é a
   correção.
2. **`D20` não tem entrada em `docs/SEGURANCA.md`**: a lista corre D1–D19 e
   D21–D28. A decisão está só em `docs/REDIS.md:127`, com referência cruzada
   no SEGURANCA. Um leitor procurando D20 no registro de decisões não acha.
3. O roadmap v2 (Fase 7) citava "decisões D15–D18"; o documento já estava em
   D28.

**Pronto quando:** D20 ganha entrada própria no registro de decisões, com o
status "em aberto" e o porquê.

## P11 — `D20`: decisão de projeto, não tarefa

Se o volume do Redis for destruído, a revogação volta sem histórico e o
serviço **falha aberto por ausência do dado**. O roadmap v2 fechou a Fase 2.2
com a persistência (caso do container que reinicia) e deixou este registro e
em aberto, com duas saídas anotadas:

- segundo Redis com réplica e promote manual; ou
- gravar o carimbo de revogação também no Mongo.

**Pronto quando:** uma das duas for escolhida e implementada, com o custo
medido — ou a pendência for formalmente aceitada como limite desta topologia,
registrada como tal na `docs/ARQUITETURA.md` ao lado do SPOF do Mongo.

---

## 3. Ordem de execução

```text
P1  runner DDoS (a e b)          destrava 4.1, parte de 4.3 e 6.2
P2  opt-out / mutation check     fecha caixa [x] sem artefato e a 5.2
P3  revogação cruzada + logout   Fase 4.3
P4  T1–T6 contra Redis real      Fase 5.2
P5  documentar limites           Fase 6.2
P6  deploy.sh                    Fase 7
P7  exclusão PM2 × cluster       Fase 3.2
P8  heap/GC sob carga            Fase 3.2
P9  test:capacity pós-tuning     Fase 3.2 (medição, ~20 min)
P10 papel e D20                  consistência
P11 decisão D20                  projeto
```

**Portão:** a suíte inteira (`test:unit`, `test:integration`, `test:e2e`,
`test:credential-theft`, `test:infra`, `test:redis`, `test:backup`,
`test:config-backup`, `test:ddos`) só roda ao fim, depois das correções de
código, e o resultado é o que fecha este documento.