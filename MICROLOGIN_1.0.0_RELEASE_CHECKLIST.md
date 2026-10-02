# Micrologin — Checklist de fechamento e lançamento da 1.0.0

**Objetivo:** levar o projeto atual a um estado que possa ser congelado como `v1.0.0` de portfólio, com código, testes, segurança, CI/CD, documentação e processo de release coerentes entre si.

**Data do check:** 2026-10-02  
**Versão no `package.json`:** `1.0.0`  
**Escopo:** correções necessárias para a versão final; novas funcionalidades não são objetivo deste ciclo.

> **Regra:** não marcar este documento como concluído por “parece funcionar”. Cada item obrigatório precisa de código + teste/prova + documentação quando aplicável.

---

## 0. Estado atual

O projeto já possui uma base forte: arquitetura hexagonal, Argon2id, JWT, rotação de refresh token, revogação, Redis, MongoDB, Docker, observabilidade, testes unitários/integrados/E2E, testes de segurança, testes de resiliência, backup/restore, k6 e workflows de CI/CD.

O trabalho restante é principalmente de **confiabilidade e consistência**. O projeto não precisa de outra grande feature para chegar à 1.0.0; precisa fechar os pontos abaixo e provar o comportamento final.

### Decisões já aceitas e que NÃO devem virar novos projetos neste ciclo

- [x] Limite D20 da revogação armazenada em Redis foi formalmente aceito e documentado como limitação da topologia atual.
- [x] Logout foi desenhado como encerramento de **todas as sessões do usuário**, e não como logout de um único dispositivo.
- [x] A infraestrutura de produção pode continuar simples; não é necessário introduzir Kubernetes, KMS, OpenTelemetry ou múltiplos bancos para esta 1.0.0.
- [x] Integrações externas não são requisito para o lançamento do projeto de portfólio.

---

# 1. BLOQUEADORES DE 1.0.0

Estes itens precisam estar concluídos antes da tag final.

---

## 1.1 — Tornar o limite de Argon2 um limite real

**Prioridade:** P0 / crítico  
**Arquivos principais:**

- `src/interfaces/config/appConfig.ts`
- `src/application/middleware/inFlightLimit.ts`
- módulo responsável por `argon2Hash()` / `argon2Verify()`
- testes unitários e de integração de autenticação

### Problema

Existe a configuração:

```ts
MAX_CONCURRENT_LOGINS = 8
```

Ela participa do cálculo de orçamento de memória, mas não representa necessariamente a quantidade máxima de operações Argon2 simultâneas. O `inFlight` é um limite de requisições por processo e não substitui um semáforo específico de Argon2.

### Implementação

[x] Criar um semáforo/limiter específico para operações Argon2.

[x] Fazer `hash` e `verify` passarem pelo mesmo mecanismo quando forem operações de autenticação.

[x] O limite deve ser configurável e validado no bootstrap.

[x] O cálculo de orçamento de memória deve usar o mesmo limite que a execução realmente impõe.

[x] Manter o `inFlight` como proteção de HTTP; não substituir uma proteção pela outra.

### Testes obrigatórios

[x] Disparar dezenas de operações de login em paralelo e medir a concorrência real de Argon2.

[x] Provar que o máximo simultâneo nunca excede o limite configurado.

[x] Criar teste de regressão que falhe caso o semáforo seja removido.

### Evidência (2026-10-02)

`src/shared/utils/argon2Limiter.ts` (novo): `Argon2Limiter` + `runArgon2`,
`configureArgon2Limiter`, `argon2Snapshot`, `resetArgon2Metrics`. FIFO com fila
limitada; saturação devolve `ARGON2_OVERLOADED_CODE`/`Argon2OverloadedError`.

Configuração: `ARGON2_MAX_CONCURRENCY` / `ARGON2_MAX_QUEUE` em
`securityConfig.passwordHash.concurrency = { limit, maxQueue }`; `< 1` e `< 0`
rejeitados; `configureArgon2Limiter()` chamado no bootstrap; orçamento de memória
passa a usar o `limit` realmente aplicado; `getConfigSummary()` publica os dois
valores.

`PasswordHasher.hash()` e `.compare()` passam por `runArgon2` — a mesma fronteira
nos dois caminhos. Métricas em `requests.argon2`.

**Resposta de projeto registrada:** a fila limitada devolve **503 + `Retry-After: 1`**,
não 401/400. Erro de capacidade não é erro de credencial, e o cliente precisa poder
tentar de novo; 401 diria ao usuário que a senha dele está errada.

Testes: `tests/unit/argon2-limiter.test.ts` (15) e `tests/unit/argon2-concurrency.test.ts`
(6, instrumentando chamadas reais a `@node-rs/argon2`).

Mutação: removendo o `runArgon2` do adapter, o teste observou **48 operações
simultâneas com limite 4** e reprovou. Restaurado; 21/21 verdes.

### Critério de aceite

```text
concorrência observada de Argon2 <= MAX_CONCURRENT_LOGINS
```

E o valor precisa aparecer de forma verificável nos logs/artefato de teste de carga.

---

## 1.2 — Corrigir a ordem da troca de senha para evitar estado parcialmente aplicado

**Prioridade:** P0 / crítico  
**Arquivo:** `src/domain/index.ts`

### Problema

Hoje a troca de senha salva a nova senha e só depois tenta revogar as sessões.

Isso cria este estado possível:

```text
salvar nova senha      -> sucesso
revogar sessões        -> falha
```

Resultado: a senha mudou, mas os tokens antigos podem continuar válidos.

### Implementação mínima recomendada para a 1.0.0

[x] Revogar as sessões **antes** de persistir a nova senha.

[x] Exigir `true`/sucesso explícito de `revokeUserTokens()` antes de salvar a nova senha.

[x] Se a revogação estiver indisponível, retornar erro de infraestrutura e não alterar a senha.

[x] Se a revogação funcionar e o `save()` falhar, aceitar o estado de segurança resultante: a senha antiga continua válida, mas as sessões foram encerradas. Registrar esse cenário.

[x] Não ignorar o retorno booleano de `revokeUserTokens()`.

### Testes obrigatórios

[x] Revogação falha -> senha não muda.

[x] Revogação retorna `false` -> senha não muda.

[x] Revogação funciona + `save()` funciona -> senha muda e sessões são encerradas.

[x] Revogação funciona + `save()` falha -> nenhuma sessão antiga continua válida.

[x] Criar mutação de teste que remova a checagem da revogação e confirme que o build/teste reprova.

### Critério de aceite

Nunca existir o estado “senha nova gravada + revogação de sessão falhou silenciosamente”.

### Evidência (2026-10-02)

Ordem implementada em `AuthService.changePassword`: hash novo -> `revokeUserTokens` (com
checagem explícita de `success`) -> `user.changePassword()` -> `save()`. O código
`PASSWORD_CHANGE_NOT_PERSISTED` cobre a falha de gravação após revogação, e
`REVOCATION_UNAVAILABLE` cobre a revogação não confirmada — ambos mapeados para
**503** em `AuthController.changePassword`, nunca 401/400 (a senha não é o problema).
`AUTH_OUTCOMES.password_change` classifica os dois como `unavailable`.

Testes: `tests/unit/session-invalidation-order.test.ts` (17 testes no arquivo, 7
deste item) mais `tests/unit/domain-auth-service-extended.test.ts`.

Mutações executadas contra `src/domain/index.ts`, todas revertidas:

| Mutação | Resultado |
| --- | --- |
| Remover a checagem `!revocation.success` (`if (false)`) | 6 testes reprovam |
| Mover a revogação para depois do `save()` | 4 testes reprovam |

Gates após o item: `typecheck` limpo, `lint` limpo, unit 748/748, integração 38/38,
credential-theft (Map) 10/10, credential-theft (Redis real + ES256) 14/14, e2e 15/15.

---

## 1.3 — Revogar sessões antes de excluir usuário

**Prioridade:** P0 / crítico  
**Arquivo:** `src/domain/index.ts`

### Problema

`deleteUser()` atualmente pode excluir o usuário antes de revogar os tokens. Se a revogação falhar depois da exclusão, tokens antigos podem permanecer válidos até seu vencimento ou continuar sendo aceitos em pontos que não dependem imediatamente do usuário existir.

### Implementação

[x] Antes da exclusão, chamar `revokeUserTokens(userId)`.

[x] Só executar o `delete()` do repositório após a revogação ter sido confirmada.

[x] Se a revogação falhar, não excluir o usuário.

[x] No fluxo de refresh, confirmar que o usuário ainda existe e está ativo antes de emitir novo par de tokens.

### Testes obrigatórios

[x] delete + revogação bem-sucedidos -> usuário removido e tokens inválidos.

[x] revogação indisponível -> usuário permanece.

[x] usuário removido -> refresh token antigo não produz novos tokens.

[x] Criar mutação que retire a verificação de existência no refresh; o teste precisa reprovar.

### Evidência (2026-10-02)

`AuthService.deleteUser` revoga antes de remover; revogação não confirmada devolve
`REVOCATION_UNAVAILABLE` (503 + `Retry-After` em `AuthController.deleteProfile`) e o
usuário **permanece**. Falha de `delete()` depois da revogação devolve
`USER_DELETE_NOT_PERSISTED` (503), estado seguro e registrado no log: as sessões já
foram encerradas e a conta continua de pé.

`AuthService.refreshUserTokens` verifica a existência do usuário **antes** de rotacionar,
para não emitir par novo (nem consumir o token) de conta apagada; o token órfão é
revogado e a resposta é `USER_NOT_FOUND` (401). “Ativo” não é verificável: `models/User.ts`
não tem conceito de conta desativada, e introduzi-lo seria funcionalidade nova.

Códigos adicionados a `AUTH_OUTCOMES`: `token_refresh.USER_NOT_FOUND = 'invalid'`.

Testes em `tests/unit/session-invalidation-order.test.ts` e
`tests/unit/domain-auth-service-extended.test.ts`.

Mutações executadas, todas revertidas:

| Mutação | Resultado |
| --- | --- |
| `deleteUser` voltando a remover antes de revogar | 4 testes reprovam |
| Refresh sem a checagem de existência | 2 testes reprovam |

Ajuste de harness necessário: `tests/security/credential-theft.{survival,real-redis}.test.ts`
passavam `{}` como repositório. Com a checagem de existência, isso estourava uma exceção e
fazia os cenários de roubo de credencial falharem com `REFRESH_TOKEN_INVALID` — uma falha
que parece de token mas era do harness. Passaram a responder que a conta existe.

---

## 1.4 — Remover o tratamento especial de `forEach` em `uncaughtException`

**Prioridade:** P0 / crítico  
**Arquivo:** `src/shared/utils/errorHandler.ts`

### Problema

Existe um `return` especial para erros cuja mensagem contém `forEach`. Um `uncaughtException` significa que uma exceção escapou do fluxo normal e o processo pode estar em estado inconsistente. Ignorar seletivamente esse erro é arriscado.

### Implementação

[x] Remover o `if (err.message.includes('forEach')) return`.

[x] Ao ocorrer `uncaughtException`, registrar o erro e iniciar graceful shutdown.

[x] Manter o comportamento de reinício pelo PM2/Docker/orquestrador.

[x] Manter `unhandledRejection` no mesmo modelo.

[x] Garantir que o shutdown seja idempotente para não disparar múltiplas rotinas concorrentes.

### Testes

[x] Forçar `uncaughtException` em ambiente de teste controlado.

[x] Provar que o processo entra no fluxo de encerramento.

[x] Provar que erros que contenham a palavra `forEach` não recebem tratamento especial.

### Evidência (2026-10-02)

A isenção foi removida de `src/shared/utils/errorHandler.ts`. A isenção nunca teve
o efeito pretendido: `forEach` aparecia na mensagem de qualquer `TypeError` de
domínio, e não só de uma biblioteca de métricas — a mesma falha com uma palavra a
menos ou a mais decidia se o processo sobrevivia.

`gracefulShutdown` ganhou trava de idempotência (`shuttingDown`). Sem ela, um SIGTERM
seguido de um `uncaughtException` abria duas rotinas: dois `server.close()`, dois
`mongoose.close()` e dois timers de force-close — e o segundo `close()` numa conexão
já fechada lança, cai no `catch` e chama `exit(1)` no meio do encerramento limpo.

**Correção de uma afirmação que o checklist não pedia:** o código de saída passou a
diferenciar crash de encerramento pedido (`SIGTERM`/`SIGINT` → 0;
`uncaughtException`/`unhandledRejection` → 1). A justificativa é esta, e não a de
"garantir o reinício": Docker `restart: unless-stopped` e PM2 com `autorestart` no
default reiniciam em **qualquer** código de saída, então o `1` não é o que mantém o
processo no ar aqui. Ele evita que a queda por estado inconsistente seja reportada
como parada bem-sucedida por alertas baseados no código de saída, e é o que
impediria a sobrevivência em supervisors que distinguem sucesso de falha (systemd
`Restart=on-failure`, Kubernetes).

Testes em `tests/unit/error-handler.test.ts` (12 testes, 5 novos). O teste que
existia ("ignora exceções não tratadas de métricas para manter a app rodando")
foi substituído pelo seu oposto.

Mutações executadas, todas revertidas:

| Mutação | Resultado |
| --- | --- |
| Reintroduzir `if (err.message.includes('forEach')) return` | 1 teste reprova |
| Remover a trava de idempotência (`if (false)`) | 1 teste reprova |
| `uncaughtException` voltando a sair com 0 | 1 teste reprova |
| `unhandledRejection` sem derrubar o processo | 1 teste reprova |

A terceira mutação exigiu corrigir os testes antes de ser detectada: a afirmação do
código de saída era feita **depois** de disparar o timer de force-close, que também
chama `exit(1)` — o teste passava pelo motivo errado. As afirmações agora rodam antes
dos timers.

---

## 1.5 — Corrigir a escolha de ambiente do deploy no CI/CD

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/ci-cd.yml`

### Problema

O workflow declara um input manual:

```yaml
workflow_dispatch:
  inputs:
    environment:
      options:
        - staging
        - production
```

mas o job de deploy usa uma matrix fixa com os dois ambientes. Portanto, selecionar um ambiente no dispatch não limita o deploy àquele ambiente.

### Implementação

[x] Usar `inputs.environment` diretamente no job de deploy.

[x] Remover a matrix de dois ambientes para o dispatch manual, ou condicioná-la explicitamente ao input.

[x] Manter `environment: staging` e `environment: production` como GitHub Environments separados.

[x] Impedir por construção que uma execução escolhendo `staging` faça qualquer operação em `production`.

### Prova obrigatória

[ ] Executar manualmente com `environment=staging`.

[ ] Confirmar no log e no servidor que apenas staging foi tocado.

[ ] Confirmar que `environment=production` exige somente os secrets de production.

[x] Documentar o processo no README.

### Evidência (2026-10-02)

Matrix removida do job `deploy`. `name`, `environment` e `concurrency.group` leem
`inputs.environment`. O prefixo dos secrets é derivado do input
(`production` → `PRODUCTION`, senão `STAGING`) e todas as 24 referências de secret
passam por `env.DEPLOY_SECRET_PREFIX` — não sobrou nenhum nome de secret escrito à
mão no job.

Barreira nova como **primeiro** passo, antes de SSH, registry ou rede: compara o
prefixo resolvido com o ambiente escolhido e aborta em caso de divergência ou de
valor inesperado.

**Prova:** `tests/unit/ci-deploy-environment.test.ts`, 13 testes estruturais — eles
leem o job do YAML e executam o `run:` real da barreira em bash.

**A "Prova obrigatória" de execução manual não foi feita, e não pode ser feita neste
repositório.** Não existe servidor de staging ou produção configurado — o próprio
workflow admite isso em comentário, e o item 4.x depende de execução com
infraestrutura real. O que a prova estática cobre: a execução do deploy é confined
ao ambiente escolhido por construção. O que ela não substitui: o contato real com
os servidores, que depende de `STAGING_DEPLOY_HOST` / `PRODUCTION_DEPLOY_HOST`
existirem. `npm run test:deploy` (Fase 4, com rollback real) é a prova de que o
`remote-deploy.sh` funciona, e segue pendente.

Mutações do workflow, todas revertidas:

| Mutação | Resultado |
| --- | --- |
| Reintroduzir a matrix fixa de dois ambientes | 3 testes reprovam |
| Escrever `secrets.PRODUCTION_*` à mão no meio do job | 1 teste reprova |
| Mover a barreira para depois do primeiro `ssh` | 5 testes reprovam |
| Trocar `exit 1` da barreira por `::warning::` | 4 testes reprovam |

A última mutação **não** foi detectada na primeira versão do teste, e a falha é
interessante: o teste reescrevia a lógica da barreira em vez de extraí-la do
workflow, então provava que a *ideia* abortava, não que a barreira do workflow
aborta. Trocar `exit 1` por `::warning::` mantinha 11/11 verdes. O teste agora
extrai o `run:` do YAML e o executa — uma única cópia da lógica, e é a que roda em
produção.

Documentação: README, seção "Deployment → Como o ambiente é escolhido".

---

## 1.6 — Corrigir o gate de dependências do `audit-ci`

**Prioridade:** P0 / crítico  
**Arquivos:** `.audit-ci.json`, `.github/workflows/ci-cd.yml`

### Problema

A configuração atual define simultaneamente `low`, `moderate`, `high` e `critical` como `true`. O `audit-ci` documenta que a configuração deve escolher **um único threshold** de severidade. 

### Problema — confirmado no código

As quatro chaves não são quatro interruptores independentes: `mapVulnerabilityLevelInput`
(audit-ci 7.1.0) devolve no **primeiro** `true`, na ordem
`low > moderate > high > critical`. Com as quatro em `true` valia `low` — reprovar por
qualquer advisory de qualquer severidade — e as outras três eram configuração morta.

O schema oficial declara `additionalProperties: false`, e a versão anterior tinha duas
chaves fora dele: `skipDev` (que nunca foi a chave; é `skip-dev`) e `summary`.

### Implementação

[x] Adicionar `$schema` ao `.audit-ci.json`.

[x] Escolher um threshold único para a política de 1.0.0 — `moderate`.

[x] Política aplicada: bloquear `moderate` ou superior, salvo advisory explicitamente
analisado e allowlisted. `low` fica de fora porque severidade baixa neste ecossistema
quase sempre descreve pacote por caminho não usado ou DoS sem impacto na superfície
exposta; bloquear por `low` com allowlist vazia vira ruído, e gate ignorado não é gate.
`high` seria mais permissivo, mas o serviço tem argon2id, pepper e sessão revogável.

[x] Manter `allowlist` vazia até existir uma justificativa real.

[x] Se surgir uma exceção futura, registrar advisory, motivo, escopo e validade — o
schema do audit-ci aceita `expiry` no registro da allowlist para isso. Registrado em
`README.md` → *Política de dependências*.

[x] Corrigir `skipDev` → `skip-dev` e remover `summary`, que não existe no schema.

[x] Alinhar `npm audit --audit-level` ao mesmo threshold, para o job não carregar duas
políticas de severidade diferentes ao mesmo tempo.

### Testes

`tests/unit/audit-ci-gate.test.ts` — 11 testes.

[x] `npx audit-ci --config .audit-ci.json` passa sem warnings de configuração. O config é
validado contra a lista de propriedades do schema oficial conferida em 2026-10-02.

[x] Vulnerabilidade acima do threshold reprova o gate. Fixture temporária com
`basic-ftp@5.3.1` (dependência direta, `GHSA-c475-qrg2-pj4r`, severidade high):
`moderate` → exit 1; `critical` → exit 0; config real do projeto → exit 1. O caso
`critical` é o contrapeso: um gate que reprova sempre também passaria só no primeiro.

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| `skip-dev` → `skipDev` | 3 |
| Dois thresholds (`moderate` + `high`) | 1 |
| Baixar a política para `high` | 2 |
| `allowlist` com entrada | 2 |
| README anunciando outro threshold | 1 |
| Config alterada, README desatualizado | 2 |

### Pendência conhecida — o gate agora reprova

Com a política correta, `code-quality` fica **vermelho** até as advisories de
severidade `high` em devDependencies serem resolvidas:

```text
GHSA-c475-qrg2-pj4r  basic-ftp <=6.2.0
pm2 > proxy-agent > pac-proxy-agent > get-uri > basic-ftp
```

5 `high`, 0 `moderate`, 0 `critical`. É devDependencies (`pm2`), e `npm audit fix`
só oferece `pm2@6.0.14` — downgrade com breaking change, recusado. **Não foi
allowlisted**, porque a política deste item manda allowlist vazia até existir
justificativa real. Caminhos: aguardar `proxy-agent` corrigir a dependência, ou
`overrides` para `basic-ftp@^6.2.1` — que é major bump em `get-uri` e exige
verificação antes, não depois. Fica registrado como pendência, não escondido.

### Fonte

Verificação da documentação do projeto `audit-ci` em 2026-10-02:  
https://github.com/IBM/audit-ci

---

## 1.7 — Transformar Trivy em gate real

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/ci-cd.yml`

### Problema

O Trivy gera SARIF, mas o passo atual não define `exit-code: '1'`. Portanto, um resultado vulnerável pode ser enviado ao GitHub sem necessariamente reprovar o job.

### Problema — confirmado no action.yml

`exit-code` **não tem default** no `aquasecurity/trivy-action`. Sem ele o passo
termina em 0, o job `security` fica verde com a SARIF cheia, e `deploy` (que já
dependia de `security`) segue. O gate nunca barre.

### Implementação

[x] Fixar `aquasecurity/trivy-action@v0.36.0` — versão recomendada pela
documentação oficial, confirmada em 2026-10-02 (não há release posterior: `v0.37.0`
a `v0.40.0` retornam 404, e o README do projeto usa `v0.36.0`).

[x] Pinado também o **motor**, em `version: 'v0.75.0'`. O action `v0.36.0` embute
o Trivy `v0.70.0` por default, e o `master` já traz `v0.75.0`. Deixar no default
significa que vulnerabilidade disclosed depois do `v0.70.0` não é detectada e o
gate passa em silêncio — o pior modo de falha de um gate. Pinar o action sem
pinar o motor daria aparência de controle sem controle. O `version` é input do
próprio action, então não entra um segundo action (`setup-trivy`) na cadeia.

[x] `exit-code: '1'`.

[x] `severity: 'HIGH,CRITICAL'`. Assimétrico em relação ao `moderate` do 1.6, e a
assimetria é deliberada: o `audit-ci` governa dependências que o projeto escolhe e
fixa em lockfile; o Trivy governa a imagem inteira, incluindo pacotes da base que
o projeto não controla, onde MEDIUM é ruído frequente. Nenhum é mais forte sozinho
e juntos não deixam buraco — dependência da aplicação segue coberta a partir de
moderate. `severity` filtra o que o gate considera; a SARIF continua completa.

[x] `ignore-unfixed: true`, documentado no README. Bloquear por vulnerabilidade sem
correção disponível não torna o software mais seguro, torna o gate ignorável: não
existe ação que a equipe possa tomar. O achado continua no SARIF; o que reprova é o
que dá para corrigir. Reversível em uma linha.

[x] `permissions: security-events: write` (+ `contents: read`) no job `security`.
Upload de SARIF em evento `push` é rejeitado sem isso.

[x] Scan do artefato que será implantado: `image-ref` já era
`needs.build.outputs.image-ref`, que é `ghcr.io/<repo>@sha256:<digest>` — o mesmo
digest que o `deploy` recebe (linha do `--image "$IMAGE_REF"`). Confirmado por
teste, não por leitura.

[x] O upload do SARIF tem `if: always()`, então um gate vermelho ainda publica a
evidência. Era o comportamento anterior e foi preservado de propósito.

[x] Documentado em `README.md` → *Política de imagem (Trivy)*.

### Testes

`tests/unit/trivy-security-gate.test.ts` — 19 testes. As asserções de versão
comparam contra os defaults lidos do `action.yaml` da tag em 2026-10-02, não contra
o que este autor流逝 lembra.

[x] `exit-code` presente e igual a `'1'`.
[x] `deploy` depende de `security`; upload do SARIF com `if: always()`.
[x] Scan e deploy recebem a mesma referência, e ela é digest.
[x] Action pinado, e motor ≥ o default do action.
[x] `severity` é política, não o default `UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`.
[x] `ignore-unfixed` e as permissões de SARIF, com a escolha documentada.
[x] A imagem escaneada é a stage `production` do Dockerfile (nasce de `base`, sem
toolchain de build nem watcher de development).

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| Remover `exit-code` (volta ao default da action) | 1 |
| `exit-code: '0'` explícito | 1 |
| Action de volta em `@master` | 2 |
| Motor de volta no default (`v0.70.0`) | 1 |
| Remover `security-events: write` | 1 |
| Remover `if: always()` do upload | 1 |
| `deploy` deixa de depender de `security` | 1 |
| Scan apontando para tag mutável em vez do digest | 2 |
| `severity` de volta ao default da action | 2 |
| `ignore-unfixed` desligado | 1 |
| README perde a política HIGH/CRITICAL | 1 |

### Fonte

https://github.com/aquasecurity/trivy-action

---

## 1.8 — Atualizar actions obsoletas/arquivadas

**Prioridade:** P0 / crítico para o release pipeline; P1 para o restante  
**Arquivos:** `.github/workflows/ci-cd.yml`, `.github/workflows/release.yml`

### Implementação

[x] `github/codeql-action/upload-sarif@v2` -> **`@v4`**. `v3` e `v4` existem
(`action.yml` retorna 200 nas três). O input `sarif_file` continua existindo em
`v4`, confirmado no `action.yml` da tag. Os "deprecated" que aparecem no README
do upstream são sobre o ciclo de depreciação do GHES, não sobre a action.

[x] `codecov/codecov-action@v3` -> **`@v5`**. Atenção: a `v5` **removeu o upload
sem token** para repositório público. A política de 1.0.0 já passava
`token: ${{ secrets.CODECOV_TOKEN }}`, então o bump é seguro. O oposto teria
quebrado o upload em silêncio, porque o step tem `fail_ci_if_error: false` — e
não há como confirmar pela execução do CI se o secret existe, então isso fica
registrado como risco, não como verde. Todos os inputs usados
(`token`, `directory`, `flags`, `name`, `fail_ci_if_error`) existem em `v5`.

[x] `aquasecurity/trivy-action@master` -> **`@v0.36.0`**. Feito no item 1.7, junto
com o pin do motor (`version: 'v0.75.0'`).

[x] `softprops/action-gh-release@v1` -> **`@v3`**. O `v1` rodava sobre um runtime
Node que o GitHub Actions depreciou. O upstream diz que `v2.6.2` é a última `v2` e
não é mais mantida; a `v3` usa `node24`. Verificado no `action.yml`.

[x] `8398a7/action-slack@v3` -> **removida**, dos dois workflows, junto com o job
`notify` do `ci-cd.yml` inteiro e as referências a `SLACK_WEBHOOK_URL`.

- Escolha entre migrar e remover: removida. A release não deve depender de um
  webhook de Slack para concluir, e `slackapi/slack-github-action` não é troca de
  versão — a API é outra, e exigiria reescrever o payload. Isso é trabalho
  opcional, não P0 de pipeline de release.
- Se a notificação for desejada depois, `slackapi/slack-github-action@v2` é a
  sucessora mantida.

[x] Pin por SHA: **considerado e adiado, com registro.** Para o caminho da
release, `master` foi o único tag flutuante e já saiu. O resto está em major ou
versão exata, e major é a tag mais forte que a maioria dos upstreams publica
(conferido em 2026-10-02: `docker/build-push-action` e `codecov/codecov-action` e
`softprops/action-gh-release` não publicam minor nenhuma). SHA pinning é o passo
seguinte de endurecimento e fica para depois do freeze, junto com
`zizmor`/scorecard.

### Actions não atualizadas — majors mais novas existem

Conferido em 2026-10-02, e **deixado de fora de propósito**:

| Action | Em uso | Major mais nova |
| --- | --- | --- |
| `actions/checkout` | `v4` | `v6` |
| `actions/setup-node` | `v4` | `v6` |
| `docker/metadata-action` | `v5` | `v6` |
| `docker/build-push-action` | `v5` | `v6` |
| `docker/login-action` | `v3` | `v4` |
| `docker/setup-buildx-action` | `v3` | `v4` |

Nenhuma delas está arquivada nem depreciada — a busca por "deprecated" nos
READMEs bate em documentação de outras coisas (input `always-auth` do
`setup-node`, `file`/`plugin` do codecov, ciclo GHES do codeql), não na action.
Subir major agora seria trocar seis actions por six majors sem execução de CI
para provar que nada quebrou, e o item 5.2 diz para não mexer em dependências no
meio do release. Fica como item pós-1.0.0, com o caminho já identificado.

### Testes

`tests/unit/github-actions-pinning.test.ts` — 15 testes.

[x] Nenhuma action em tag flutuante em nenhum dos dois workflows.
[x] As versões exigidas pela política de 1.0.0 são as declaradas.
[x] `codecov@v5` mantém `secrets.CODECOV_TOKEN`.
[x] Nenhuma action arquivada; nenhum workflow referencia Slack; o job `notify`
não existe mais.
[x] Todo `needs:` aponta para job existente, para a remoção não ter deixado
referência órfã.

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| Trivy de volta em `@master` | 3 |
| Codecov de volta em `v3` | 2 |
| CodeQL de volta em `v2` | 2 |
| gh-release de volta em `v1` | 2 |
| `action-slack` arquivada volta no release.yml | 4 |
| Job `notify` volta, com Slack dentro | 4 |
| Codecov `v5` sem token | 1 |
| `deploy` passa a depender de job removido | 1 |

### Observação

O repositório `8398a7/action-slack` foi arquivado em 2025-09-13. Não deve entrar numa release final nova sem necessidade. 

### Fontes

- CodeQL: https://github.com/github/codeql-action
- Codecov: https://github.com/codecov/codecov-action
- Trivy: https://github.com/aquasecurity/trivy-action
- Slack: https://github.com/8398a7/action-slack
- Slack Action mantida: https://github.com/slackapi/slack-github-action
- GitHub Release Action: https://github.com/softprops/action-gh-release

---

## 1.9 — Corrigir completamente o workflow de release

**Prioridade:** P0 / crítico  
**Arquivo:** `.github/workflows/release.yml`

### Problemas atuais

1. O `workflow_dispatch` recebe uma versão, mas o workflow usa `github.ref_name` como `tag_name`.
2. O passo de Docker apenas imprime mensagens; não faz realmente o tagging da imagem.
3. O release workflow não reproduz todos os gates principais de qualidade e segurança.
4. O workflow ainda usa `softprops/action-gh-release@v1`.

### Estratégia recomendada para a 1.0.0

Tratar a **tag Git como fonte de verdade** e fazer o release somente a partir de uma tag válida:

```text
main verde
  ↓
git tag -a v1.0.0
  ↓
push da tag
  ↓
release workflow
  ↓
testes + typecheck + build + audit + security scan
  ↓
Docker image 1.0.0
  ↓
GitHub Release v1.0.0
```

### Bugs confirmados no arquivo anterior

1. **`workflow_dispatch` ignorava a versão.** O input `version` existia e nada
   lia; `tag_name` era `github.ref_name`. No dispatch, `github.ref_name` é o
   **branch** — o resultado era uma release chamada "Release main".
2. **Changelog sempre vazio.** `git describe --tags --abbrev=0 HEAD` na própria
   tag da release devolve a própria tag, então `tag..HEAD` é vazio.
3. **Passo de Docker fictício.** `echo "✅ Docker images tagged"` sem registry.
4. **`generate_release_notes: true` ao lado de `body_path`.** No
   `action-gh-release`, o body é *prepended* às notas automáticas do GitHub — e
   essas notas não são determinísticas.
5. Nenhum gate de qualidade/segurança, nenhum scan da imagem.

### Implementação

[x] Trigger por `push.tags: ['v*.*.*']` como caminho oficial.

[x] `workflow_dispatch` mantido, mas operando sobre tag **prévia e validada**:
o input virou `tag`, e o script rejeita tag inexistente com mensagem explícita.
Nenhum caminho cria tag.

[x] Validação de semantic versioning estrita (`vMAJOR.MINOR.PATCH`, com
`-prerelease` e `+build` aceitos).

[x] Versão da tag comparada com `package.json`. As duas são fonte da verdade
para a mesma versão; divergência reprova.

[x] Tag precisa ser ancestral de `origin/main`. Release a partir de branch não
mergeada é o tipo de coisa que só se descobre depois.

[x] `concurrency` por tag, com `cancel-in-progress: false`. Sem isso, retry do
dispatch racing com o push da tag seguinte produz duas releases para a mesma
versão.

[x] `softprops/action-gh-release@v3` (a versão já era do item 1.8).

[x] `CHANGELOG.md` determinístico: `git describe --tags --abbrev=0 "${TAG}^"`
(tag anterior resolvida no commit pai), commits sem merge, e
`generate_release_notes` removido. Script falha se o arquivo sair vazio.

[x] Imagem Docker com tags reais, via `buildx build --push` de verdade:
`:1.0.0`, `:v1.0.0`, `:<git-sha>`. As três exigidas pelo critério de aceite,
mais uma que a aceita.

[x] `latest` decidido explicitamente: movido **só** em versão estável. RC
publicada não toca em `latest`.

[x] Digest publicado em `$GITHUB_STEP_SUMMARY`, junto de registry, tags e
platforms.

[x] Removido o `echo "✅ tagged"`. Não sobrou nenhum eco de sucesso sem operação
por trás — há teste que garante.

[x] Gates reproduzidos, que o workflow anterior não tinha: lint, typecheck,
build, `npm audit --audit-level=moderate`, `audit-ci`, secret scanning, unit,
credential theft, ddos preflight e integração.

[x] Trivy como gate sobre o **digest publicado**, antes da GitHub Release. O
`release` depende de `security`, então não há caminho que publique release
pulando o scan.

[x] Job `release` com `contents: write` apenas; `image` com `packages: write`;
`security` com `security-events: write`.

### Critério de aceite — o que é provável aqui e o que não é

O critério do checklist é: quem baixar o código, criar `v1.0.0` e dar push,
obtém release, changelog, imagem `1.0.0` e digest registrado, com workflow
verde. **Não executei isso**: exige tag real no repositório, registry e
segredos. O que está provado por teste:

- a árvore da tag é a que os gates e o build usam;
- o comando `buildx build --push` sai com as três tags e `latest` só quando
  estável, e o digest é lido de volta do registry (executado com `docker`
  stubado, verificando o comando, não o registry);
- o changelog tem range real, e a tag anterior é resolvida no commit pai;
- tag inválida, tag divergente de `package.json`, tag fora da main e tag
  inexistente reprovam com mensagem explícita.

### Testes

`tests/unit/release-pipeline.test.ts` — 32 testes. **Executam o `run:` real**
contra um repositório git de verdade com tags de verdade, em vez de procurar
string no YAML: um teste que só confirmasse que "buildx build --push" existe
passaria com a lógica de versionamento errada ao lado.

[x] Tag válida aceita; dispatch usa o input e não o branch; dispatch sem tag,
com tag inexistente, tag não-semver, tag divergente de `package.json` e tag
fora da main reprovam.
[x] `v1.1.0-rc.1` reconhecida como prerelease.
[x] Tag anterior resolvida no pai (`v1.0.0` → `v0.9.0`), e demonstrado que a
forma ingênua devolveria a própria tag.
[x] Comando de build verificado: `--push`, três tags, multi-arch, digest no
resumo.
[x] `latest` presente em estável e ausente em prerelease.
[x] RC publicada como `prerelease`, não como estável.
[x] Todos os gates presentes; release depende do scan; digest no resumo;
changelog sem notas automáticas; concurrency presente.

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| `tag_name` volta a `github.ref_name` (bug original) | 1 |
| Dispatch volta a ignorar o input `tag` | 6 |
| Guard de `package.json` removido | 1 |
| Regex de semver frouxa | 7 |
| Guard de "está na main" removido | 1 |
| `git describe "${TAG}^"` volta a `HEAD` (changelog vazio) | 1 |
| `buildx` perde `--push` | 1 |
| Perde a tag `:v1.0.0` | 1 |
| `latest` movido também em prerelease | 1 |
| Trivy no release perde `exit-code` | 1 |
| `release` deixa de depender de `security` | 1 |
| `prerelease: false` fixado | 1 |
| `echo "✅ tagged"` de volta | 1 |

### Colisão com a tag `v1.0.0` existente

`v1.0.0` já existe apontando para `e29032f`, muito atrás da `main`. Com a tag
como fonte de verdade, não há como publicar 1.0.0 sem resolver isso antes:
**ou** a tag é movida para o commit do freeze, **ou** a release passa a ser
`v1.0.1`. Decisão do usuário; registrada aqui e em "Achados".

---

# 2. SEGURANÇA E CONSISTÊNCIA — P1

Itens recomendados para entrar na própria 1.0.0, mas abaixo dos bloqueadores acima.

---

## 2.1 — Garantir `token_type` em todos os modos JWT

**Arquivos:** `src/infrastructure/external-services/jwtTokenService.ts`,
`jwtSigner.ts`.

### Vulnerabilidade confirmada — escalada por troca de header

A separação entre access e refresh descansava **inteiramente** no fato de os
segredos HS256 serem diferentes. Isso não é propriedade do token: é consequência
de como o HS256 funciona — e o construtor recai para `JWT_SECRET` quando
`JWT_REFRESH_SECRET` não vem, com warning e não com erro.

Nesse estado os dois signers assinam com o mesmo material, e a verificação de
tipo era ignorada: o `early return` que existia só conferia a claim em ES256.
Reproduzido antes da correção, com `JWT_REFRESH_SECRET` ausente:

```text
refresh entregue como access  ->  ACEITOU. id=u1 token_type=refresh exp=+7d
access entregue como refresh  ->  ACEITOU. token_type=access
```

Refresh token de 7 dias servindo como Bearer em rota de access, e access de 15
minutos servindo onde refresh é exigido — sem comprometimento de chave, só com o
token que o próprio dono recebeu.

### Implementação

[x] `access` e `refresh` são semanticamente distintos **também em HS256**: a
conferência da claim `token_type` deixou de ser condicional e passou a valer nos
dois algoritmos, em `verifyAccessToken` e `verifyRefreshToken`.

[x] A separação não depende mais de segredo diferente. `reliesOnTokenType` foi
removido de `TokenSigner`: a propriedade descrevia o comportamento antigo e,
deixada no lugar, seria armadilha para quem a lidasse.

[x] Token sem a claim é recusado. O comentário anterior dizia que "tokens legados
sem a claim continuam válidos" — o que é aceitar exatamente o estado que a
separação por segredo deixou passar. Não há token legado a preservar na 1.0.0.

[x] Testar refresh onde access é exigido, e access onde refresh é exigido, nos
três modos: HS256 com segredo compartilhado, HS256 com segredos distintos e
ES256.

[x] ES256 obrigatório em produção: **mantido como estava**, e já provado por
`tests/unit/security-config.test.ts` ("recusa HS256 em produção: quem verifica não
pode assinar"). Não dupliquei a prova — exigiria remontar a config por env, e o
teste duplicado seria o mais frágil dos dois.

[x] Testes de segurança no modo de produção: `credential-theft.real-redis` e
`auth-http.e2e` já usavam ES256 com par de chaves gerado no teste. Verificado por
asserção sobre o código das suítes, porque um teste de segurança rodando em
HS256 prova o caminho que a produção não usa.

### Testes

`tests/unit/jwt-token-type.test.ts` — 24 testes.

O achado mais útil da escrita deles: **a barreira não é a mesma nos dois
HS256**, e a diferença é justamente o que importa. Com segredos distintos, a
recusa vem da assinatura (`invalid signature`) e a claim nem chega a ser
consultada. Com segredo compartilhado, a assinatura passa — os dois tokens têm a
mesma assinatura válida sob o mesmo segredo — e a claim é a única barreira.
Meu primeiro teste afirmava que a recusa viria da claim nos três modos, e falhou
nos dois modos onde ela não vem. Está registrado assim: a rejeição é a asserção, o
motivo é testado onde importa.

Há também o teste que forja um token **com o segredo correto e `token_type`
trocado**: a assinatura valida, issuer e audience batem, e só a claim barra. É o
que distingue "a claim é consultada" de "a assinatura é consultada".

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| Volta o `early return` que só validava em ES256 | 10 |
| `verifyAccessToken` sem conferir o tipo | 7 |
| `verifyRefreshToken` sem conferir o tipo | 3 |
| Refresh emitido sem a claim `token_type` | 6 |

---

## 2.2 — Mitigar enumeração por timing em login/registro

**Arquivos prováveis:** serviço de autenticação + módulo de hash + testes de segurança.

[ ] Para usuário inexistente, executar comparação com hash Argon2id dummy de custo equivalente.

[ ] Fazer o caminho de usuário existente e inexistente ter custo aproximado semelhante.

[ ] Criar teste de regressão que impeça retorno imediato do caso inexistente.

[ ] Medir p50/p95/p99 de ambos os caminhos e registrar a diferença observada.

> Não é necessário prometer “timing idêntico”; o objetivo é reduzir a diferença explorável.

---

## 2.3 — Corrigir Swagger/OpenAPI

**Arquivo:** `src/interfaces/config/swagger.ts`

[ ] Corrigir `apis: ['./src/routes/*.ts']` para o caminho real das rotas.

[ ] Verificar geração real do spec contra os arquivos em `src/application/routes/`.

[ ] Garantir que as schemas referenciadas existam.

[ ] Validar o documento OpenAPI gerado.

[ ] Fazer pelo menos um teste automatizado da presença dos principais endpoints:

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
GET  /auth/profile
PUT  /auth/password
DELETE /auth/account
```

[ ] Confirmar que `/api-docs` abre sem warnings de referência quebrada.

[ ] Fazer a versão exibida no Swagger derivar da mesma versão do pacote, evitando dois lugares manuais para `1.0.0`.

---

## 2.4 — Revisar `TRUST_PROXY`

**Arquivo:** `src/interfaces/config/appConfig.ts`

[ ] Confirmar valor de produção em `.env.prod.example`.

[ ] Nunca usar `TRUST_PROXY=true` em produção sem proxy confiável explicitamente definido.

[ ] Testar spoofing de `X-Forwarded-For`.

[ ] Confirmar que o rate limiting por IP usa o endereço real somente quando a topologia justifica confiança no proxy.

---

# 3. TESTES QUE DEVEM FECHAR A RELEASE

Executar em ambiente limpo, com Docker disponível e sem depender de artefatos gerados de uma execução anterior.

## 3.1 Gates locais básicos

[ ] `npm ci`

[ ] `npm run lint`

[ ] `npm run typecheck`

[ ] `npm run build`

[ ] `npm audit --audit-level=high`

[ ] `npx audit-ci --config .audit-ci.json`

[ ] `npm run test:secrets`

---

## 3.2 Suíte funcional

[ ] `npm run test:unit`

[ ] `npm run test:integration`

[ ] `npm run test:e2e`

[ ] `npm run test:e2e:down`

[ ] `npm run test:coverage:fast`

### Critério mínimo

Nenhum teste vermelho. Não aceitar “falha conhecida” na suíte que será usada como prova da 1.0.0.

---

## 3.3 Suíte de segurança

[ ] `npm run test:credential-theft:unit`

[ ] `npm run test:credential-theft:real-redis`

[ ] `npm run test:credential-theft`

[ ] Teste de rotação de refresh token.

[ ] Teste de reuso de refresh token.

[ ] Teste de revogação de usuário.

[ ] Teste de troca de senha com sessões antigas.

[ ] Teste de refresh após exclusão do usuário.

[ ] Teste de JWT `token_type`.

---

## 3.4 Suíte de infraestrutura/resiliência

[ ] `npm run test:infra`

[ ] `npm run test:redis`

[ ] `npm run test:redis:volume-loss`

[ ] `npm run test:backup`

[ ] `npm run test:config-backup`

[ ] `npm run test:deploy`

[ ] `npm run test:replica-session`

### D20

O teste `npm run test:redis:volume-loss` deve continuar documentando a limitação aceita, e não ser tratado como “serviço quebrado”. A documentação precisa continuar afirmando corretamente que a revogação armazenada apenas no Redis pode ser perdida com a perda do volume.

---

## 3.5 Carga e capacidade

[ ] `npm run test:ddos`

[ ] `npm run test:capacity`

[ ] `npm run bench:hash`

[ ] `npm run bench:login`

### Registrar no release report

- VUs usados.
- p95/p99.
- RSS máximo.
- quantidade de hashes simultâneos.
- 429 observados.
- 503 por sobrecarga observados.
- 5xx inesperados.
- falhas de liveness/readiness.
- número real de réplicas observadas.
- resultado do controle após revogação.

Não usar uma métrica comparada por caminhos de rede diferentes como “melhoria” sem registrar a diferença de topologia.

---

# 4. CI/CD — DEFINIÇÃO DE PRONTO

## 4.1 Pull Request

[ ] Checkout.

[ ] `npm ci`.

[ ] Secret scanning.

[ ] ESLint.

[ ] TypeScript typecheck.

[ ] `npm audit`.

[ ] `audit-ci`.

[ ] unit tests.

[ ] integration tests.

[ ] E2E.

[ ] coverage upload.

[ ] Docker build de candidato, se fizer parte da política do repositório.

[ ] Trivy scan do candidato, com gate real.

[ ] Nenhuma imagem de PR deve ser publicada permanentemente no registry sem necessidade.

---

## 4.2 Main

[ ] Tudo do PR.

[ ] Build Docker multi-arch.

[ ] Scan de segurança.

[ ] Publicação da imagem.

[ ] Digest registrado.

[ ] Nenhum deploy automático para production sem aprovação/ação explícita.

---

## 4.3 Deploy manual

[ ] `staging` e `production` são mutuamente exclusivos por execução.

[ ] Secrets separados por ambiente.

[ ] Known hosts configurado.

[ ] Não usar `*` como `known_hosts` em produção.

[ ] Pull por digest.

[ ] Backup antes do deploy.

[ ] Readiness após deploy.

[ ] Smoke test.

[ ] Rollback automático quando o smoke/readiness falhar.

[ ] Resumo do commit, ator, versão e digest implantados.

---

# 5. HARDENING DO REPOSITÓRIO

## 5.1 Versões e identidade do projeto

[ ] Decidir se o nome oficial continuará `autentication` ou será corrigido para `micrologin`/`authentication`.

> Para a 1.0.0, não é obrigatório mudar o nome do pacote se isso gerar churn de lockfile e documentação. O importante é documentar a decisão.

[ ] `package.json.version = 1.0.0`.

[ ] README identifica claramente `v1.0.0` como versão estável.

[ ] Swagger usa a mesma versão.

[ ] Docker usa tags da versão.

[ ] Release GitHub usa `v1.0.0`.

---

## 5.2 Dependências

[ ] `npm ci` reproduz exatamente o lockfile.

[ ] `package-lock.json` está commitado.

[ ] Nenhum pacote desnecessário permanece em `dependencies`.

[ ] Dependências de runtime e `devDependencies` estão separadas corretamente.

[ ] Nenhum pacote de produção é usado apenas por testes.

[ ] `npm audit` e `audit-ci` estão verdes.

[ ] Actions do GitHub estão em versões suportadas.

[ ] Dependências não são atualizadas no meio do processo de release; congelar o lockfile antes da tag.

---

## 5.3 Secrets e arquivos sensíveis

[ ] `.env` não está versionado.

[ ] `.env.prod` não está versionado.

[ ] arquivos PEM reais não estão versionados.

[ ] logs de teste não contêm secrets.

[ ] dumps de banco não estão no Git.

[ ] Gitleaks passa.

[ ] exemplos/documentação não contêm credenciais reutilizáveis.

---

# 6. DOCUMENTAÇÃO DA 1.0.0

Antes de criar a tag final, revisar estes arquivos:

[ ] `README.md`

[ ] `docs/ARQUITETURA.md`

[ ] `docs/SEGURANCA.md`

[ ] `docs/REDIS.md`

[ ] `docs/ROTACAO.md`

[ ] `docs/BACKUP.md`

[ ] `docs/CONFIG.md`

[ ] `docs/metricas.md`

[ ] `MICROLOGIN_ANALISE_E_ROADMAP.md`

### O README deve deixar claro

[ ] O que o serviço faz.

[ ] Stack utilizada.

[ ] Como subir localmente.

[ ] Como executar testes.

[ ] Como gerar chaves JWT.

[ ] Como configurar Redis/Mongo.

[ ] Como fazer deploy.

[ ] Como fazer rollback.

[ ] Limitações conhecidas.

[ ] Política de logout: encerra todas as sessões.

[ ] Limite D20 do Redis.

[ ] O que é demonstração de portfólio e o que não é promessa de SaaS de escala ilimitada.

### Depois da 1.0.0

[ ] Mover/renomear roadmap histórico para uma seção de histórico ou manter claramente como documento de auditoria anterior.

[ ] Não deixar no README uma lista de “TODOs” que pareça bloquear a versão estável quando forem apenas melhorias futuras.

---

# 7. RELATÓRIO FINAL DA RELEASE

Criar um arquivo:

```text
RELEASE_1.0.0_REPORT.md
```

Ele deve conter:

## Ambiente

- Node.js.
- npm.
- Docker.
- Docker Compose.
- OS do runner.

## Testes

Tabela com:

| Categoria | Comando | Resultado | Observação |
|---|---|---|---|
| Lint | `npm run lint` | | |
| Typecheck | `npm run typecheck` | | |
| Unit | `npm run test:unit` | | |
| Integration | `npm run test:integration` | | |
| E2E | `npm run test:e2e` | | |
| Credential theft | `npm run test:credential-theft` | | |
| Infra | `npm run test:infra` | | |
| Redis | `npm run test:redis` | | |
| Redis volume-loss | `npm run test:redis:volume-loss` | | |
| Backup | `npm run test:backup` | | |
| Config backup | `npm run test:config-backup` | | |
| Deploy | `npm run test:deploy` | | |
| Replica session | `npm run test:replica-session` | | |
| DDoS | `npm run test:ddos` | | |
| Capacity | `npm run test:capacity` | | |
| Dependency audit | `npm audit --audit-level=high` | | |
| audit-ci | `npx audit-ci --config .audit-ci.json` | | |
| Secrets | `npm run test:secrets` | | |

## Segurança

Registrar:

- algoritmo JWT de produção;
- configuração do Argon2id;
- limite de concorrência do Argon2;
- rate limit;
- in-flight limit;
- TTL dos tokens;
- comportamento de revogação;
- limitação D20;
- status do Trivy;
- status do secret scanning.

## Imagem

Registrar:

```text
registry:
image tag:
image digest:
platforms:
```

## Git

Registrar:

```text
commit:
tag:
release URL:
```

---

# 8. FREEZE DA 1.0.0

Depois que todos os bloqueadores estiverem verdes:

[ ] Fazer `git status` e garantir working tree limpo.

[ ] Confirmar branch `main` atualizada.

[ ] Confirmar que todos os commits importantes foram mergeados.

[ ] Confirmar que CI do último commit da `main` está verde.

[ ] Confirmar que não há issue marcada como blocker da 1.0.0.

[ ] Atualizar `CHANGELOG.md`.

[ ] Atualizar `package.json` para `1.0.0` se ainda não estiver.

[ ] Executar novamente `npm ci`.

[ ] Executar novamente o conjunto de gates local.

[ ] Commit final:

```bash
git add .
git commit -m "chore(release): v1.0.0"
```

[ ] Criar tag anotada:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
```

[ ] Conferir:

```bash
git show --stat --oneline v1.0.0
```

[ ] Enviar:

```bash
git push origin main
git push origin v1.0.0
```

[ ] Não alterar mais o commit apontado pela tag.

---

# 9. PÓS-RELEASE

Após o workflow terminar:

[ ] GitHub Release `v1.0.0` existe.

[ ] Release não está marcada como draft/prerelease por engano.

[ ] Changelog está correto.

[ ] Assets esperados estão presentes.

[ ] Imagem Docker `1.0.0` existe.

[ ] Digest da imagem bate com o registrado no workflow.

[ ] Pull da imagem funciona.

[ ] Container inicia a partir da imagem publicada.

[ ] `/health` responde `healthy`.

[ ] `/readiness` responde `healthy`.

[ ] Smoke funcional passa contra a imagem publicada.

[ ] Rollback continua funcional.

[ ] Documentar o commit/tag efetivamente lançado.

---

# 10. MATRIZ FINAL DE DECISÃO

A versão pode ser chamada de **1.0.0 estável de portfólio** somente quando:

| Área | Condição |
|---|---|
| Código | Sem bloqueadores P0 conhecidos |
| Auth | Login, registro, refresh, logout, troca e exclusão provados |
| Argon2 | Limite real de concorrência comprovado |
| JWT | Access/refresh corretamente separados |
| Revogação | Falhas de infraestrutura tratadas sem sucesso falso |
| Mongo/Redis | Sem sequência que permita estado inseguro silencioso |
| Testes | Suíte crítica 100% verde |
| Segurança | Gitleaks, audit-ci e Trivy funcionando como gates |
| CI | PR/main/release coerentes |
| Deploy | Staging/production não podem se atropelar |
| Docker | Imagem versionada e reproduzível por lockfile |
| Release | Tag, GitHub Release e imagem apontam para a mesma versão |
| Docs | README e documentação condizem com o código atual |
| Limitações | D20 e outras limitações aceitas estão explícitas |

---

# 11. O QUE NÃO FAZER ANTES DA 1.0.0

Não abrir uma nova frente de complexidade sem necessidade.

Evitar neste ciclo:

- Kubernetes.
- múltiplos Redis;
- múltiplos Mongo;
- KMS externo;
- OpenTelemetry completo;
- painel web novo;
- sistema de permissões sofisticado;
- OAuth/social login;
- integração externa de e-mail/SMS;
- microsserviços adicionais;
- refatoração total da arquitetura;
- troca de framework sem necessidade.

Esses itens pertencem a uma eventual `1.1+`, caso exista motivo real.

---

# 12. ORDEM EXATA DE EXECUÇÃO

Use esta sequência para não ficar corrigindo uma coisa e quebrando outra:

```text
1.  Corrigir semáforo real de Argon2
2.  Corrigir troca de senha
3.  Corrigir exclusão + refresh após exclusão
4.  Corrigir uncaughtException
5.  Corrigir workflow de environment
6.  Corrigir audit-ci
7.  Transformar Trivy em gate
8.  Atualizar actions do GitHub
9.  Corrigir release.yml
10. Corrigir token_type em JWT
11. Corrigir Swagger
12. Rodar testes unitários
13. Rodar integração
14. Rodar E2E
15. Rodar segurança
16. Rodar infraestrutura
17. Rodar réplica
18. Rodar DDoS
19. Rodar capacidade
20. Atualizar documentação
21. Criar RELEASE_1.0.0_REPORT.md
22. Fazer CI final da main
23. Congelar código
24. Criar tag v1.0.0
25. Push da tag
26. Conferir GitHub Release
27. Conferir imagem Docker
28. Executar smoke pós-release
```

---

# 13. CHECKLIST DE ENCERRAMENTO

Marque somente depois de todas as etapas acima:

- [ ] Todos os P0 concluídos.
- [ ] Todos os testes críticos verdes.
- [ ] CI verde no último commit da `main`.
- [ ] Release workflow corrigido e validado.
- [ ] Docker release real, não apenas simulado por `echo`.
- [ ] Documentação atualizada.
- [ ] `RELEASE_1.0.0_REPORT.md` criado.
- [ ] `v1.0.0` criado em commit correto.
- [ ] GitHub Release publicada.
- [ ] Imagem Docker versionada publicada.
- [ ] Smoke pós-release verde.
- [ ] Nenhum TODO restante classificado como blocker.

## Achados durante a execução

Problemas que apareceram enquanto os itens eram executados e que não são
causados pelos itens em si.

### `tests/integration/login-throttle.test.ts` falha na aggregated run de cobertura

- **Sintoma:** `ajustar a caixa do username não renova o orçamento` passa em
  `npm run test:integration` e reprova em `npm run test:coverage`.
- **Pré-existente:** confirmado em 2026-10-02 com a árvore limpa no commit
  `9c879bc` (`git stash`), onde o mesmo teste reprova.
- **Leitura provável:** o teste consome `LOGIN_POINTS` orçamento com origens
  distintas e depende da janela fixa não virar entre as tentativas. Sob
  instrumentação a execução fica mais lenta e a janela vira.
- **Não é bloqueante para a 1.0.0**, mas o teste é dependente de tempo e
  deveria usar relógio injetável. Anotado para não ser confundido com
  regressão dos itens 1.2/1.3.

### Tag `v1.0.0` já publicada

- `v1.0.0` existe local e no remote apontando para `e29032f`, 69 commits atrás
  de `main`. A estratégia de versionamento precisa ser decidida antes do
  freeze — ver item 5.1 e a seção de Git.

## Estado final

```text
[ ] NÃO PRONTO
[ ] CANDIDATO A RELEASE
[ ] 1.0.0 LANÇADA
```

---

## Referências técnicas atuais consultadas em 2026-10-02

- audit-ci: https://github.com/IBM/audit-ci
- CodeQL Action: https://github.com/github/codeql-action
- Codecov Action: https://github.com/codecov/codecov-action
- Trivy Action: https://github.com/aquasecurity/trivy-action
- action-slack arquivada: https://github.com/8398a7/action-slack
- Slack GitHub Action: https://github.com/slackapi/slack-github-action
- GitHub Release Action: https://github.com/softprops/action-gh-release
