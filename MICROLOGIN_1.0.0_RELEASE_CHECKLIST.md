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
| `allowlist` no formato ignorado pelo audit-ci | 3 |
| `allowlist` sem `expiry` | 2 |
| `allowlist` por pacote em vez de advisory | 2 |
| README anunciando outro threshold | 1 |
| Config alterada, README desatualizado | 2 |

### Pendência resolvida em 2026-10-03 — verificada antes, não depois

A pendência era esta:

```text
GHSA-c475-qrg2-pj4r  basic-ftp <=6.2.0
pm2 > proxy-agent > pac-proxy-agent > get-uri > basic-ftp
```

O caminho escolhido foi o que este item apontava como mais caro, e por isso foi
verificado **antes** de ser aceito: `overrides` para `basic-ftp@^6.2.1`, ou seja,
major bump dentro de uma dependência de terceiro (`get-uri@6.0.5` declara
`basic-ftp: ^5.0.2`). O que a verificação encontrou:

- `npm install` com o override **trocou** `GHSA-c475-qrg2-pj4r` por
  `GHSA-2883-xcg3-v3hh` (`js-yaml >=4.0.0 <4.3.2`, CPU por `maxTotalMergeKeys`).
  Não era acaso: o lockfile antigo **não honrava** o pin exato do `pm2`
  (`js-yaml: 4.3.1`) e reaproveitava o `4.3.2` hoisted, que não é vulnerável. Ao
  re-resolver a árvore, o npm passou a obedecer o pin e aninhou o `4.3.1` —
  vulnerável. Gate trocado por gate: mesmo número de advisories, uma diferente.
- Correção com override **aninhado e escopado**, para não arrastar o
  consumidor 3.x do istanbul (`@istanbuljs/load-nyc-config` usa `safeLoad`,
  removido no js-yaml 4):

```json
"overrides": {
  "basic-ftp": "^6.2.1",
  "pm2": { "js-yaml": "^4.3.2" }
}
```

Árvore resultante: `pm2 > js-yaml@4.3.2` e `get-uri > basic-ftp@6.2.1`, ambos
`overridden`, sem `invalid` no `npm ls`, e
`@istanbuljs/load-nyc-config > js-yaml@3.15.2` intacto (3.x está fora da faixa
vulnerável).

Verificado depois do override, não presumido: `lint`, `typecheck`, 916 unit,
`pm2 --version` (7.0.4) e `test:coverage:fast` (958 testes) verdes, com cobertura
inalterada (87.5% / 83.76% / 89.92% / 87.49%).

### Exceção restante — `braces`, por advisory e com validade

Sobrou uma advisory, e ela **não tem correção possível**:

```text
GHSA-vfj7-8cjw-p6xm  braces <=3.0.3  (ReDoS por stack exhaustion)
jest > micromatch > braces ; lint-staged > micromatch > braces ; pm2 > chokidar > braces
```

A faixa vulnerável inclui a última versão publicada (3.0.3), então não existe o
que instalar — e a remoção é impossível sem largar `jest`/`pm2`/`lint-staged`.
30 pacotes high, todos de `devDependencies`, uma única advisory.

Decisão registrada em 2026-10-03, com validade até **2027-01-01**: exceção por
advisory, com `notes` explicando o caminho alcançável (padrão compilado a partir
de globs do próprio repositório, em tempo de teste/lint — não há entrada de
requisição nesse caminho) e o gatilho de reavaliação (publicação de correção em
`braces` ou `micromatch`).

O formato usado é o `NSPRecord` do schema do audit-ci
(`{ GHSA-…: { active, expiry, notes } }`) e **não** o `{ ghsa, justification,
expiry }` dos exemplos do próprio audit-ci: este último é ignorado sem erro nem
aviso, com o gate continuando vermelho pelo advisory que "consta" na lista —
conferido empiricamente nos dois formatos. `tests/unit/audit-ci-gate.test.ts`
falha se a lista voltar ao formato ignorado, se alguma exceção perder
justificativa ou validade, ou se o conjunto `moderate+` da árvore deixar de ser
exatamente o conjunto allowlisted.

O teste que exigia allowlist vazia foi trocado por esses quatro. A mutação
"allowlist com entrada" da tabela acima não é mais o que testa exceção indevida:
agora testa **exceção malformada**, e o contraponto continua sendo a fixture com
`basic-ftp@5.3.1`, que a política real reprova mesmo com a exceção de `braces` no
arquivo.

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
o que este autor lembra.

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
[x] Comando de build verificado: `--push`, três tags, digest no resumo.
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


### Revisão pós-commit — três defeitos que os testes não pegavam

O pipeline foi commitado como encerrado e não estava. Três defeitos, nenhum
detectável pelos testes existentes, porque todos eles são sobre a **estrutura**
do workflow — o que um step enxerga do anterior — e os testes executam cada
`run:` com as variáveis que precisam injetadas à mão.

**1. `$TAG` não existia nos steps que o usavam.** A tag anterior e o checkout
da árvore viviam em steps seguintes ao que resolvia a tag. Cada `run:` é um
shell novo: variável de shell não atravessa a fronteira. Com `set -u`, o job
morria na primeira linha. Nos testes passava, porque `runScript` recebia
`TAG: 'v1.0.0'` na mão. Resolvido juntando tudo no step que já tem a tag — não
exportando a variável, que é o remendo que deixa a mesma armadilha para quem
crescer o arquivo depois.

**2. Os gates rodavam no branch, não na tag.** `quality`, `tests`, `image` e
`release` faziam `actions/checkout@v4` sem `ref:`. No push funciona por
acidente — o ref do evento já é a tag. No dispatch o ref é o branch escolhido
na UI, e aí um gate verde não diz nada sobre a versão publicada. Todos agora
fazem `ref: ${{ needs.validate.outputs.tag }}`. Junto disso, a checagem de
`package.json` foi movida para **depois** do checkout da tag: antes ela lia a
versão do branch, que é a fonte errada no dispatch.

**3. O digest não chegava ao scan.** O step escrevia `digest=...` no
`GITHUB_OUTPUT`, mas o job não declarava `outputs:`. Output de step morre no
fim do step: `needs.image.outputs.digest` chegava vazio no `security` e no
`release`. O Trivy escanearia `ghcr.io/repo@` e o resumo da release mostraria
digest em branco — sem erro visível, só um gate que passa por cima de ar.

`tests/unit/release-pipeline.test.ts` — 32 → **43 testes**. Os novos olham a
estrutura, não só a execução: nenhum step referencia variável que ele mesmo não
define, todo job tag-dependente declara o `ref:`, e o job `image` declara o
output de digest.

Mutações, todas detectadas:

| Mutação | Reprovas |
| --- | --- |
| Checkout sem `ref:` (volta ao ref do evento) | 4 |
| Job `image` sem `outputs:` de digest | 1 |
| Tag anterior de volta para um step sem `env:` | 2 |
| `package.json` lido antes do checkout da tag | 2 |

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

**Arquivos:** `src/domain/index.ts`, `src/infrastructure/adapters/index.ts`.

[x] Para usuário inexistente, executar comparação com hash Argon2id dummy de custo equivalente.

[x] Fazer o caminho de usuário existente e inexistente ter custo aproximado semelhante.

[x] Criar teste de regressão que impeça retorno imediato do caso inexistente.

[x] Medir p50/p95/p99 de ambos os caminhos e registrar a diferença observada.

> Não é necessário promover “timing idêntico”; o objetivo é reduzir a diferença explorável.

### O que era o oráculo

O `/login` já respondia `Credenciais inválidas` para usuário inexistente e para
senha errada — a mensagem não distinguia. O **tempo** distinguia, e era o único
canal que sobrava: `authenticateUser` retornava logo depois de
`findByUsername` responder `null`, sem argon2id para rodar. Uma senha errada
custava um `verify` m=19456,t=2 (~27 ms medidos); username inexistente voltava em
microssegundos. Uma requisição por username — sem errar senha nenhuma — bastava
para mapear a base inteira.

O `/register` tinha o mesmo furo na forma espelhada, e ele é o item que o título
pede e que a leitura do checklist não destacava: `exists()` verdadeiro retornava
antes de `hash()`, que é o que um registro novo paga. **No `/register` a
mitigação não é decorativa**, porque o controller já responde 400 genérico tanto
para conta nova quanto para username repetido: o tempo era o único oráculo
restante, e estava aberto.

### Implementação

`CryptoService.compareDummy(plainText): Promise<false>` — novo método da porta,
**obrigatório** (não `?`), para que o compilador obrigue qualquer implementação
a ter. `PasswordHasher` mantém um hash descartável, gerado **uma vez por
instância** e com os parâmetros que ele próprio usa:

- por que o método existe na porta em vez de uma constante no domínio: uma
  constante fixa passaria a divergir no dia que alguém mudasse `m=`, `t=` ou
  `p=`, e a mitigação viraria decorativa;
- `compareDummy` usa `compare` de verdade, não um atalho, porque é o custo
  **dele** — pepper e `unwrap` inclusos — que precisa casar com o login real;
- reuso: se cada requisição gerasse o seu descarte, o caminho “não existe” ficaria
  **mais** lento que o de usuário real (o mesmo oráculo com o sinal invertido) e
  viraria amplificador de carga para quem não tem conta;
- rejeição é explícita e descarta a promessa guardada: cache permanente de falha
  tornaria definitiva a devolução rápida do caminho “não existe” sem nada apontar
  para o motivo.

### Medição (2026-10-03, `m=16384,t=2,p=1`, n=15, 2 amostras descartadas)

```text
login  / usuário inexistente   p50 23.52ms  p95 25.88ms  p99 25.88ms
login  / senha errada          p50 23.23ms  p95 24.22ms  p99 24.22ms
razão p50 inexistente/errada = 1.012

registro / username repetido   p50 23.68ms  p95 26.36ms  p99 26.36ms
registro / conta nova          p50 24.30ms  p95 25.58ms  p99 25.58ms
razão p50 repetido/novo = 0.974
```

Os números são do ambiente de teste com repositório em memória; o que a razão
demonstra é a **paridade dos caminhos**, não a latência absoluta de produção. O
que sustenta a afirmação “`verify` custa o mesmo que `hash` nos mesmos
parâmetros”, medida à parte em 8192/t=1, 16384/t=2 e 19456/t=2: razão
1.013, 0.974 e 0.978. É por isso que um `verify` é equalizador válido também no
registro, cujo caminho real é um `hash()`.

### Testes

`tests/unit/timing-enumeration.test.ts` — 7 testes, com duas metades porque cada
uma pega uma classe de erro diferente:

- **contagem** (determinístico): quantas operações argon2 cada caminho faz e com
  quais parâmetros. É o que reprova quando `compareDummy` sai do `AuthService`. Um
  teste puramente temporal reprovaria só quando a máquina estivesse lenta — isso é
  um teste que falha sozinho, não um teste que reprova a mutação;
- **tempo** (p50/p95/p99 e razão entre os caminhos): pega a mitigação que existe e
  não funciona — dummy mais barato, descarte regenerado a cada chamada.

Mutações, todas revertidas:

| Mutação | Reprovas |
| --- | --- |
| `compareDummy` fora do `authenticateUser` | 5 |
| `compareDummy` fora do `registerUser` | 3 |
| `compareDummy` existe mas vira no-op (`if (false)`) | 5 |
| Descarte gerado com `m=1024,t=1` em vez de `m=16384,t=2` | 3 |
| Descarte regenerado a cada chamada (sem cache) | 2 |

### Ajuste de harness

`tests/integration/auth-flow.test.ts` e dois doubles de
`tests/security/credential-theft.scenarios.ts` não implementavam `compareDummy` e
passaram `{}`/objetos parciais. Integrar passou a falhar com
`Não foi possível registrar o usuário` — falha de harness com cara de regra de
negócio, que é a pior forma de vermelho. Corrigido nos três.

### Pendência residual — `updateUserProfile`

`AuthService.updateUserProfile` tem a mesma forma (`exists()` → retorno
imediato, sem argon2). **Não foi corrigido aqui**: o endpoint exige sessão válida
— quem enumera já tem conta — e a decisão de projeto é que a atualização de
perfil reporte conflito de username explicitamente. Corrigir o tempo sem mudar a
resposta HTTP seria trabalho invisível; mudar a resposta é decisão de API.
Registrado como pendência, não esquecido.

### Gates após o item

`typecheck` limpo, `lint` limpo, unit 884/884, integração 38/38,
credential-theft (Map) 10/10.

---

## 2.3 — Corrigir Swagger/OpenAPI

**Arquivos:** `src/interfaces/config/swagger.ts` (novo `openapiSpec.ts`,
novo `src/shared/utils/version.ts`), `src/application/routes/*.ts`,
`src/shared/utils/healthCheck.ts`.

[x] Corrigir `apis: ['./src/routes/*.ts']` para o caminho real das rotas.

[x] Verificar geração real do spec contra os arquivos em `src/application/routes/`.

[x] Garantir que as schemas referenciadas existam.

[x] Validar o documento OpenAPI gerado.

[x] Fazer pelo menos um teste automatizado da presença dos principais endpoints:

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
GET  /auth/profile
PUT  /auth/password
DELETE /auth/account
```

[x] Confirmar que `/api-docs` abre sem warnings de referência quebrada.

[x] Fazer a versão exibida no Swagger derivar da mesma versão do pacote, evitando dois lugares manuais para `1.0.0`.

### O bug

`apis: ['./src/routes/*.ts']` aponta para um diretório que não existe. O
`swagger-jsdoc` não reclama de glob sem resultado: devolve um documento vazio e o
`/api-docs` abre bonito descrevendo zero rotas. Nenhum aviso, nenhum erro — o
sintoma é "a documentação existe e não diz nada".

### Discrepância de prefixo entre o checklist e o código

O checklist deste item lista `/auth/*`. As rotas são montadas na **raiz**
(`src/app.ts` monta `authRoutes` sem prefixo), e a documentação gerada usa os
caminhos reais (`/login`, `/register`, ...). Não houve mudança de prefixo: mudar
seria breaking change de API, e o item pede correção de documentação, não de
contrato. A lista acima fica como está, com a nota de que os caminhos reais estão
em `src/application/routes/authRoutes.ts` e são os que o spec publica.

### Decisões

- **Um único lugar gera o spec.** `swagger.ts` montava o documento inline; agora
  `openapiSpec.ts` é a fonte única e `swagger.ts` só monta a UI. Isso é o que
  permite testar o documento sem subir HTTP.
- **`failOnErrors: true`.** Sem ele, um bloco `@swagger` com YAML inválido é
  descartado em silêncio e a rota correspondente some do documento — a mesma
  classe de bug do item, um nível abaixo. Configurar `failOnErrors` sozinho não
  bastava: `swagger.ts` recebia o documento pronto e nunca via o erro.
- **Falhar o arranque, não servir doc vazio.** `setupSwagger` valida o documento
  (pelo menos um path, schemas referenciadas resolvidas) e, se algo estiver errado,
  registra o erro e **não** monta `/api-docs`. Um serviço no ar sem documentação
  é um sintoma visível; um serviço no ar com documentação mentirosa não é.
- **Versão em um lugar só.** `version.ts` lê `package.json` e é usado pelo
  `info.version` do spec e pelo `/health`. Antes eram duas cópias digitadas à mão.

### Documentação que faltava ou estava quebrada

- YAML inválido em `authRoutes.ts` (`auth:` com valor contendo `:`) e em
  `observabilityRoutes.ts` (`path:` com o mesmo problema) — blocos inteiros
  descartados pelo `swagger-jsdoc`.
- `BearerAuth` declarado duas vezes em `authRoutes.ts`.
- `/liveness` e `/readiness` sem nenhuma documentação.
- As seis rotas `/security/*` (`stats`, `report`, `events`, `threats`, `test`,
  `health`) sem nenhuma documentação e sem esquema de segurança.

Documento gerado: **21 paths** e **9 schemas**
(`TokenPair`, `User`, `LoginRequest`, `LoginResponse`, `RegisterRequest`,
`UpdateRequest`, `ChangePasswordRequest`, `StandardResponse`, `ErrorResponse`),
com `BearerAuth`, `metricToken` e `securityToken` declarados. Paridade
conferida entre geração em fonte (`src/**/*.ts`) e em compilado
(`dist/**/*.js`): 21 e 21, sem diferença.

### Testes

`tests/unit/openapi-spec.test.ts` — 16 testes:

- geração sem erro de YAML no documento real e reprovação de bloco inválido;
- presença dos endpoints principais, dos 9 schemas e de resposta em toda operação;
- ausência de referência interna quebrada (`$ref` de schema e de security scheme);
- `BearerAuth` realmente referenciado por rota protegida, e toda exigência de
  segurança citando um esquema declarado;
- versão do `package.json`, inclusive com o leitor mockado para provar que não há
  cópia escrita à mão;
- **drift de rotas**: toda rota registrada no Express precisa aparecer no
  documento, lendo os arquivos de rota de verdade;
- glob em código-fonte e em código compilado;
- comentários `@swagger` presentes em `dist`;
- `setupSwagger` montando `/api-docs` com o documento gerado.

`tests/e2e/auth-http.e2e.test.ts` — prova pela fronteira HTTP: `/api-docs/`
responde 200 e o `swagger-ui-init.js` traz o documento com os endpoints e a
versão do pacote.

Mutações, todas detectadas e revertidas:

| Mutação | Reprovas |
| --- | --- |
| Volta o glob para `./src/routes/*.ts` | 5 (unit), 1 (e2e) |
| `failOnErrors` desligado | 1 |
| `info.version` escrito à mão (`'1.0.0'`) | 1 |
| Glob de `.ts` também quando compilado | 1 |
| `routeGlob()` fixo em "estou em fonte" | 1 (com `dist` presente) |
| Rota nova registrada sem documentar | 1 |
| Esquema `metricToken` renomeado | 1 |

### Limitação declarada

`routeGlob()` decide entre `src/*.ts` e `dist/*.js` lendo o próprio
`import.meta.url`. Rodando por `tsx` o valor correto **é** `false`, então um
`routeGlob()` fixo em "sou código-fonte" passa em toda a suíte de unidade e
quebraria a documentação de produção. Por isso a lógica foi extraída para
`routeGlobFor(runningCompiled, root)` — testável nos dois lados — e o
caboamento é coberto por um teste que importa o módulo **compilado** e só roda
quando existe `dist/`.

Esse teste não roda numa instalação sem build, e o gate de build do CI roda em
job separado do de testes. A lacuna fica registrada em vez de ser encoberta por
um teste que finge cobrir: em qualquer máquina que rodou `npm run build` antes da
suíte, ela é exercitada.

### Gates após o item

`typecheck` limpo, `lint` limpo, unit 900/900, integração 38/38, e2e 16/16.

---

## 2.4 — Revisar `TRUST_PROXY`

**Arquivos:** `src/interfaces/config/appConfig.ts`, `src/app.ts`,
`.env.prod.example`, `.env.example`, `docker-compose.prod.yml`, `nginx/nginx-prod.conf`.

[x] Confirmar valor de produção em `.env.prod.example`.

[x] Nunca usar `TRUST_PROXY=true` em produção sem proxy confiável explicitamente definido.

[x] Testar spoofing de `X-Forwarded-For`.

[x] Confirmar que o rate limiting por IP usa o endereço real somente quando a topologia justifica confiança no proxy.

### O que já estava certo

- `.env.prod.example` e `docker-compose.prod.yml` declaram `TRUST_PROXY=1`.
- O nginx **sobrescreve** `X-Forwarded-For` com `$remote_addr` e não usa
  `$proxy_add_x_forwarded_for`, ou seja, o cliente não escolhe o próprio IP.
- O app não publica porta: só o proxy alcança a rede da aplicação.
- `trust proxy` é setado antes de qualquer middleware que leia `req.ip`
  (`src/app.ts:72`, no `setupSecurity`, antes do `setupMiddleware`).

### O que faltava

**1. `TRUST_PROXY=true` só emitia `logger.warn`.** O serviço subia com o rate
limit por IP inútil — um `X-Forwarded-For` novo por requisição é um orçamento
novo — e o aviso se perdia no ruído do arranque. Agora, em produção, a confiança
irrestrita **recusa o arranque** (`validateConfiguration`), e quem realmente a
quiser precisa declarar `TRUST_PROXY_ALLOW_UNRESTRICTED=true`.

O opt-in é uma env separada, deliberadamente: se fosse o mesmo valor, um default
que muda sozinho teria o poder de autorizar a si mesmo.

A recusa acontece em produção porque é lá que a topologia é desconhecida. Em
desenvolvimento `true` continua aceito com aviso — quem roda `tsx` na própria
máquina não está protegendo nada de ninguém.

**2. Não existia teste de spoofing.** O único teste de `X-Forwarded-For` no E2E
enviava o cabeçalho forjado para `/liveness`, que é isenta de rate limit: ele
prova que a rota responde, não que o forjador não ganha orçamento.

### Testes

`tests/integration/x-forwarded-for-trust.test.ts` — 4 testes, três topologias e o
contorno, medindo pelo **orçamento consumido** e não por um header inventado:

| `trust proxy` | 3 requisições com `X-Forwarded-For` diferente | Significado |
| --- | --- | --- |
| `false` (padrão) | `201, 201, 429` | o forjador não abre orçamento novo |
| `['10.0.0.0/8', ...]` sem o peer na faixa | `201, 201, 429` | proxy declarado e ausente não é confiança |
| `1` (produção) | `201, 201, 201` | cabeçalho reescrito pelo proxy vale |
| `true` | `201, 201, 201` | mesmo efeito aqui — e é por isso que é proibido |

O caminho é `/register` de propósito: ele consome só o orçamento de IP, sem a
dimensão de conta que existe em `/login`. O que está em jogo é a chave de origem.

`tests/unit/trust-proxy-config.test.ts` — 20 testes: o parsing (incluindo caixa
alta e espaços), o default `false` e a nova regra de arranque. A asserção de
aceite olha **a linha do `TRUST_PROXY`** dentro do erro e não a validade da
configuração inteira: as outras regras de produção continuam valendo e não são o
alvo.

`tests/unit/production-proxy-config.test.ts` — amarra as três peças que precisam
concordar entre si (`.env.prod.example`, `docker-compose.prod.yml`, `app.set`),
mais a garantia de que o exemplo de produção não traz o opt-in ligado de fábrica
e de que `.env.example` continua em `false`.

Mutações, todas detectadas e revertidas:

| Mutação | Reprovas |
| --- | --- |
| Regra de arranque removida | 3 |
| Opt-in passa a aceitar qualquer valor truthy (`1` passa a autorizar) | 1 |
| Regra vale fora de produção em vez de nela | 4 |
| `TRUST_PROXY=true` em `.env.prod.example` | 1 |
| `TRUST_PROXY=true` em `docker-compose.prod.yml` | 2 |
| `app.set('trust proxy', true)` no lugar da configuração | 1 |
| `app.set` movido para depois dos middlewares que leem `req.ip` | 1 |

### Limitação declarada

`src/app.ts` está fora do mapa de cobertura do Jest (`jest.config.js`), então o
caboamento `config → app.set → Express` é prendido lendo o fonte, não executando
o app. Um E2E não serviria aqui: com `TRUST_PROXY` desligado, "não configurado" e
"configurado com proxy" produzem a mesma resposta 429 no mesmo orçamento, porque
nos dois casos o `req.ip` é o socket. Um teste que não distingue as duas coisas
passaria em ambas as falhas.

A lacuna do *teste* é declarada em vez de encoberta por uma asserção que passa nos dois casos.

### Gates após o item

`typecheck` limpo, `lint` limpo, unit 916/916, integração 42/42, e2e 16/16,
credential-theft (Map) 10/10, `npm run build` sem erro.

---

# 3. TESTES QUE DEVEM FECHAR A RELEASE

Executar em ambiente limpo, com Docker disponível e sem depender de artefatos gerados de uma execução anterior.

## 3.1 Gates locais básicos

[x] `npm ci`

[x] `npm run lint`

[x] `npm run typecheck`

[x] `npm run build`

[x] `npm audit --audit-level=high`

[x] `npx audit-ci --config .audit-ci.json`

[x] `npm run test:secrets`

### Evidência

`npm ci` instalou a partir do lockfile sem divergência. `lint`, `typecheck` e
`build` limpos. `test:secrets`: gitleaks varrendo 96 commits e 4.52 MB sem
vazamento, nenhum arquivo de material (chave, certificado, ACL) versionado e
nenhuma credencial real nos `.env*` versionados.

### Gate de dependências — fechado em 2026-10-03

`npm audit --audit-level=high` sai vermelho, e **é o esperado**: o `npm audit`
não tem mecanismo de exceção. A única advisory `moderate+` da árvore é a
`GHSA-vfj7-8cjw-p6xm` (`braces`), que está na allowlist do `audit-ci` com
validade até 2027-01-01 e justificativa registrada. `npm audit --json` confirma
que não existe outra: `moderate: 0`, `critical: 0`, e as 30 entradas `high` são
todas o mesmo advisory repetido na cadeia do jest/lint-staged/pm2.

O gate que decide é o `audit-ci`, e ele está **verde**:

```text
Found vulnerable allowlisted advisories: GHSA-vfj7-8cjw-p6xm.
Passed npm security audit.
```

Dois `high` que existiam em 2026-10-02 foram removidos por `overrides` no
`package.json`, com verificação de gate completo depois (item 1.6): 
`basic-ftp@^6.2.1` para `GHSA-c475-qrg2-pj4r`, e `pm2 > js-yaml@^4.3.2` para
`GHSA-2883-xcg3-v3hh`, que só apareceu porque o lockfile antigo não honrava o
pin exato do pm2.

## 3.2 Suíte funcional

[x] `npm run test:unit`

[x] `npm run test:integration`

[x] `npm run test:e2e`

[x] `npm run test:e2e:down`

[x] `npm run test:coverage:fast`

### Critério mínimo

Nenhum teste vermelho. Não aceitar “falha conhecida” na suíte que será usada como prova da 1.0.0.

---

## 3.3 Suíte de segurança

[x] `npm run test:credential-theft:unit`

[x] `npm run test:credential-theft:real-redis`

[x] `npm run test:credential-theft`

[x] Teste de rotação de refresh token.

[x] Teste de reuso de refresh token.

[x] Teste de revogação de usuário.

[x] Teste de troca de senha com sessões antigas.

[x] Teste de refresh após exclusão do usuário.

[x] Teste de JWT `token_type`.

### Evidência

`credential-theft:unit` 10/10 (Map em memória) e `credential-theft:real-redis`
14/14 contra Redis real, incluindo os casos que chamam o app por HTTP: reuso de
refresh derruba a sessão e barra `/profile` com 401, e a troca de senha barra o
`/profile` do atacante. `test:e2e` 16/16 (inclui o `/api-docs` servido de
verdade). Rotação, reuso, revogação, troca de senha, exclusão e `token_type` têm
suite própria nos itens 1.3 e 2.1.

---

## 3.4 Suíte de infraestrutura/resiliência

[x] `npm run test:infra`

[x] `npm run test:redis`

[x] `npm run test:redis:volume-loss`

[x] `npm run test:backup`

[x] `npm run test:config-backup`

[x] `npm run test:deploy`

[x] `npm run test:replica-session`

### Evidência

| Dril | Resultado medido |
| --- | --- |
| `test:infra` (13/13) | Redis parado com o app no ar: `503 REVOCATION_UNAVAILABLE`, **sem 429 e sem fail-open**; Redis volta e a autenticação se restaura sozinha, sem restart; container reiniciado **1s** mesmo com o Redis fora; anônimo e senha errada recusados nos dois serviços; rotação do Redis com janela e do Mongo sem janela, login preservado nas duas |
| `test:redis` | Redis de volta em **0.6s**; token revogado continua 401 depois do restart do processo; `user_session_version` relida do volume |
| `test:redis:volume-loss` | Limite da D20 medido: access revogado volta a valer por até o TTL (**~15.0 min** medido na resposta); refresh já consumido volta a valer e renova access tokens; **0 erros** no log do app |
| `test:backup` | Dump cifrado (gpg AES-256) + `--check` dentro da janela RPO; restore após apagar o banco; **RTO 1s** (`restore.sh` → login 200) — **corrigido em 2026-10-04**: uma segunda execução no mesmo dia deu **2s**, então o número é uma faixa de 1–2s, não 1s fixo |
| `test:config-backup` | Rollback por metadata restaurou **imagem e env** que estavam rodando (`VERSION=cfg-v1-...`), não a config editada no disco |
| `test:deploy` | v1 → v2 → v3 com Mongo na porta errada: abortou no health check, rollback devolveu imagem, digest e env da v2 |
| `test:replica-session` | **3 réplicas** endereçadas diretamente; chave de assinatura compartilhada antes da revogação; logout e troca de senha revogaram em todas as réplicas; sessão nova aceita em todas; **refresh roubado após logout → 401** |

O `test:infra` também serve de prova de produção do item 2.3: o container real
registra `Documentação OpenAPI gerada` e sobe com `/api-docs` montado — o spec
não nasce vazio em `dist`.

### D20

O teste `npm run test:redis:volume-loss` deve continuar documentando a limitação aceita, e não ser tratado como “serviço quebrado”. A documentação precisa continuar afirmando corretamente que a revogação armazenada apenas no Redis pode ser perdida com a perda do volume.

---

## 3.5 Carga e capacidade

[x] `npm run test:ddos`

[x] `npm run test:capacity`

[x] `npm run bench:hash`

[x] `npm run bench:login`

### Evidência — `test:ddos`

k6 v0.57.0 no host, stack `ddos` em loopback com TLS (`https://127.0.0.1:3203`):

```json
{ "result": "passed",
  "baselineLivenessP95Ms": 4.5, "recoveryLivenessP95Ms": 5.2,
  "rateLimited": 4017, "apiReplicasStarted": 3, "apiReplicasObserved": 3,
  "livenessFailures": 0, "serverErrors": 0,
  "payloadResults": { "malformed": 400, "oversized": 413 },
  "slowlorisConnectionsClosed": 20,
  "peakContainerMemoryMiB": 254.9, "containerRestarts": 0 }
```

4017 respostas barradas no limite de borda/rate limit durante o flood, **0
falhas de liveness** e **0 5xx**: o serviço degradou no lugar certo. Payload
malformado recusado com 400 e oversized com 413, 20 conexões slowloris fechadas
pelo proxy, e nenhuma das 3 réplicas reiniciou. Liveness p95 de 4.5ms para
5.2ms sob ataque.

### Evidência — `test:capacity`

Matriz completa (1 worker, teto in-flight 1024, 100/200/400 VUs, 85s por
corrida), dados crus em `artifacts/capacity/summary.md`:

| endpoint | VUs | rps | p50 | p95 | p99 | 429 | 4xx | 5xx | 503 | falha % | RSS pico |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/health` | 100 | ~690 | 135ms | 182ms | 217ms | 0 | 0 | 0 | 0 | 0 | 141 MB |
| `/health` | 200 | ~680 | 274ms | 362ms | 415ms | 0 | 0 | 0 | 0 | 0 | 145 MB |
| `/health` | 400 | ~670 | 557ms | 710ms | 770ms | 0 | 0 | 0 | 0 | 0 | 151 MB |
| `/login` | 100 | 23–29 | 3.4–4.5s | 3.6–4.8s | 3.8–4.8s | 0 | 0 | 0 | 0 | 0 | 385 MB |
| `/login` | 200 | 23–30 | 6.7–8.3s | 7.4–9.0s | 7.6–9.3s | 0 | 0 | 0 | 0 | 0 | 354 MB |
| `/login` | 400 | 23–30 | 13.3–16.9s | 13.8–17.5s | 14.0–17.7s | 0 | 0 | 0 | 0 | 0 | 387 MB |
| `/refresh` | 400 | 484–527 | 626–635ms | 846–870ms | 1.1–3.3s | 0 | 0 | 0 | 0 | 0 | 340 MB |
| `/register` | 400 | ~12 | — | — | — | 0 | 0 | 0 | 0 | 0 | — |

Leitura: `/login` é limitado por CPU de argon2 (23–30 rps por processo, caindo
de 688 rps de `/health` para menos de 5% disso), e o p95 sobe linearmente com a
concorrência porque o argon2 serializa no thread pool. **0 5xx e 0 falhas** em
todas as corridas; o limite de in-flight (1024) não foi atingido. Nenhum 429
observado porque a corrida de medição usa o override de limite
(`CAPACITY_RL_POINTS`), o mesmo motivo pelo qual estes números não são
comparáveis com a política de produção (5 logins/900s) sem registrar a diferença.

### Evidência — `bench:hash` e `bench:login`

`bench:hash` (argon2id, p50 por concorrência):

| candidato | c=1 | c=2 | c=4 |
| --- | --- | --- | --- |
| OWASP forte | 65.7ms | 61.8ms | 49.8ms |
| OWASP mínimo | 46.9ms | 38.9ms | 29.9ms |
| OWASP mínimo + pepper | — | 44.3ms | 33.2ms |
| OWASP econômico | — | 28.1ms | 23.2ms |
| 64MiB (roadmap) | 273.2ms | 160.0ms | 131.7ms |

Logins por segundo na configuração em uso (OWASP mínimo): 51 (c=2), 132 (c=4).

`bench:login` contra o serviço no ar, com credencial válida, 20 requests por
nível após aquecimento, **0 falhas**:

| concorrência | p50 | p95 | max | logins/s |
| --- | --- | --- | --- | --- |
| 1 | 51.2ms | 62.6ms | 76.1ms | 18.9 |
| 4 | 159.6ms | 197.7ms | 249.6ms | 23.9 |
| 8 | 335.3ms | 544.8ms | 630.3ms | 20.4 |

Diferenças de topologia a registrar antes de comparar qualquer número: esta
medição roda **dentro do container** (sem o salto do nginx e sem o hop de rede)
e com o **override de rate limit** da matriz de capacidade. O caminho de rede e
o orçamento de limite não são os de produção.

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

[x] Checkout.

[x] `npm ci`.

[x] Secret scanning.

[x] ESLint.

[x] TypeScript typecheck.

[x] `npm audit`.

[x] `audit-ci`.

[x] unit tests.

[x] integration tests.

[x] E2E.

[x] coverage upload.

[x] Docker build de candidato, se fizer parte da política do repositório.

[x] Trivy scan do candidato, com gate real.

[x] Nenhuma imagem de PR deve ser publicada permanentemente no registry sem necessidade.

### Evidência — Pull Request

Cada item foi conferido no `ci-cd.yml`, não presumido. O job `code-quality`
roda em PR e em `push` e leva, em ordem: checkout, `npm ci` (literalmente
`npm ci`, não `npm install`), commitlint, secret scanning, ESLint, typecheck,
`npm audit` e `audit-ci`. O job `tests` roda unit, integração e E2E com
compose real, e faz upload de cobertura. Nenhum deles tem
`continue-on-error`.

Duas correções vieram da conferência:

- **O Trivy não rodava em PR.** O job `security` aceitava só `push` e
  `workflow_dispatch`, então a imagem de um PR só era escaneada depois do merge
  — tarde demais para a decisão de revisão. Incluído `pull_request`; o objeto do
  scan (o digest do job `build`) existe nos três eventos. O upload de SARIF ficou
  `continue-on-error` em PR, porque token de fork é somente-leitura e o upload
  seria rejeitado — reprovar por um relatório que o GitHub não deixa gravar
  treina ignorar vermelho. A tolerância é do upload, nunca do scan.
- **`known_hosts` com `*` em produção.** O passo de SSH escrevia `*` quando o
  secret `_DEPLOY_KNOWN_HOSTS` não estava definido, nos dois ambientes. Agora
  produção aborta; staging mantém o TOFU com aviso que diz explicitamente que
  aquilo não é aceitável em produção. O teste executa o `run:` real do workflow
  como bash, com `HOME` temporário, e cobre os três casos.

Sobre a última caixa: o `build` de PR publica a imagem porque **o Trivy precisa
do artefato real para escanear** — o job roda em runner separado, então sem
publicar não há o que escanear. As tags de PR são `pr-<n>` e `<sha>`; a
`latest` é condicionada a `{{is_default_branch}}`, ou seja, PR não recebe
`latest`. É publicação com propósito e sem ambiguidade de "última versão".

---

## 4.2 Main

[x] Tudo do PR.

[x] Build Docker. Uma plataforma só (`linux/amd64`): ver a decisão no fim
deste documento.

[x] Scan de segurança.

[x] Publicação da imagem.

[x] Digest registrado.

[x] Nenhum deploy automático para production sem aprovação/ação explícita.

### Evidência — Main

`main` dispara os mesmos jobs de PR (as condições são por evento, não por
branch): quality, testes, build e segurança. O `build` usa buildx com
`platforms: linux/amd64` e publica em GHCR. O digest sai do próprio
`build-push-action` e é exposto como output do job
(`image-digest`, `image-ref`) — é esse valor que o Trivy escaneia e que o deploy
consome, então imagem escaneada e imagem implantada são a mesma por
construção, não por convenção.

O job `deploy` só existe em `workflow_dispatch`, com `environment:
${{ inputs.environment }}`, e depende de `[build, security]`: sem dispatch
aprovado, e sem o gate de segurança verde, nada é implantado.

---

## 4.3 Deploy manual

[x] `staging` e `production` são mutuamente exclusivos por execução.

[x] Secrets separados por ambiente.

[x] Known hosts configurado.

[x] Não usar `*` como `known_hosts` em produção.

[x] Pull por digest.

[x] Backup antes do deploy.

[x] Readiness após deploy.

[x] Smoke test.

[x] Rollback automático quando o smoke/readiness falhar.

[x] Resumo do commit, ator, versão e digest implantados.

### Evidência — Deploy manual

O job `deploy` tem uma barreira antes de qualquer rede: o prefixo de secrets
resolvido (`PRODUCTION`/`STAGING`) precisa ser exatamente o do ambiente escolhido,
e o valor do input precisa ser `staging` ou `production`. Não há matrix — a
matrix era o que ignorava o input (item 1.5). Todo secret sai do prefixo
derivado do input, o que torna a separação por ambiente uma consequência da
estrutura, não de disciplina de quem escreve o dispatch.

`scripts/remote-deploy.sh` (executado no servidor) faz, nesta ordem: pull por
digest, backup da versão em vigor, `docker compose up -d`, espera por
`/readiness` — e não por `/health`, que pode responder 503 por memória e
dispararia rollback errado —, smoke test funcional, e reverte sozinho se
qualquer passo falhar, devolvendo código diferente de zero. O resumo do job
publica commit, ator, versão e digest implantados.

**O que ainda não foi provado:** o `test:deploy` (item 1.9) provou o caminho de
rollback com script local e containers, mas **nenhum deploy foi executado contra
um servidor real** — não há servidor configurado neste repositório, e o job
falha com mensagem explícita em vez de reportar sucesso fictício. As caixas
acima descrevem o que o workflow faz; a prova de que o servidor real obedece é o
item 1.5 (dispatch manual com `environment=staging`), que continua pendente
porque depende de infraestrutura que este repositório não tem.

---

# 5. HARDENING DO REPOSITÓRIO

## 5.1 Versões e identidade do projeto

[x] Decidir se o nome oficial continuará `autentication` ou será corrigido para `micrologin`/`authentication`.

> Para a 1.0.0, não é obrigatório mudar o nome do pacote se isso gerar churn de lockfile e documentação. O importante é documentar a decisão.

**Decisão (2026-10-03): `micrologin`.** O `package.json` passa a se chamar
`micrologin`, alinhado ao nome do repositório e ao nome da imagem publicada
(`IMAGE_NAME: ${{ github.repository }}` já produzia `ghcr.io/dioneyfroes-coder/micrologin`).

O escopo foi deliberado, e vale registrar o que ficou de fora **e por quê**:

- **Renomeado:** `package.json.name`, e as 13 citações de `pm2 autentication` no
  `docs/DASHBOARD_SEGURANCA_GUIA.md` — que eram um bug de documentação: o
  processo pm2 chama-se `autenticacao` (`ecosystem.config.cjs`), e o guia mandava
  o operador rodar um comando que nunca encontraria o processo.
- **Mantido:** o nome do serviço no Compose (`auth-service`), o usuário ACL do
  Redis e o nome do processo pm2 (`autenticacao`). São identificadores de
  operação, referenciados em compose, backup, deploy e no drill de capacidade já
  verde; renomeá-los no mesmo dia do freeze trocaria nomes de container e
  usuário de banco sem nenhum ganho no artefato publicado, que já se chama
  `micrologin`.

[x] `package.json.version = 1.0.0`.

[x] README identifica claramente `v1.0.0` como versão estável. (O README passou
a declarar a versão no topo, com o link para o D20 e a frase explícita de que
"estável" significa suíte de release verde e limitações declaradas, não
prontidão para SaaS. Antes, `1.0.0` aparecia uma única vez no arquivo, e era
numa frase sobre um job do CI.)

[x] Swagger usa a mesma versão. (Item 2.3: `src/shared/utils/version.ts` é a
fonte única, usada pelo `info.version` do spec e pelo `/health`; teste com o
leitor mockado impede a volta da cópia digitada à mão.)

[x] Docker usa tags da versão. (`release.yml` resolve a versão de
`package.json`, exige semver, e publica a imagem com três tags: `1.0.0`, `v1.0.0`
e o SHA do commit. `docker-compose.prod.yml` consome `IMAGE_REF` por digest, com
a tag como fallback.)

[ ] Release GitHub usa `v1.0.0`. (Depende do freeze e da decisão de tag —
ver "Achados durante a execução".)

> **Decisão da tag tomada em 2026-10-04: mover a tag `v1.0.0` para o commit de
> freeze**, descartando `v1.0.1`. O item continua `[ ]` porque a release ainda
> não foi publicada — o que falta é a execução, não a decisão.

---

## 5.2 Dependências

[x] `npm ci` reproduz exatamente o lockfile.

[x] `package-lock.json` está commitado.

[x] Nenhum pacote desnecessário permanece em `dependencies`.

[x] Dependências de runtime e `devDependencies` estão separadas corretamente.

[x] Nenhum pacote de produção é usado apenas por testes.

[x] O gate de dependências está verde — **que é o `audit-ci`, não o
`npm audit`**. Este item dizia "`npm audit` e `audit-ci` estão verdes", e a
primeira metade é falsa: `npm audit --audit-level=high` sai em exit 1, com 30
`high`. O que decide é o `audit-ci`, com a exceção datada. Ver "Gate de
dependências" em 3.1 e o achado do step `npm audit` no `release.yml`.

[x] Actions do GitHub estão em versões suportadas.

[ ] Dependências não são atualizadas no meio do processo de release; congelar o lockfile antes da tag.

### Evidência

Classificação feita por varredura de imports, não por leitura do `package.json`:
cada dependência declarada foi procurada em `src/` e em `tests/`.

- **Todas as 15 `dependencies` são importadas por `src/`** — nenhuma órfã. A
  única que não aparece em `src/` nem em `tests/` é o `pm2`, e ele é usado de
  verdade: `package.json` tem `build:pm2`, `stop`, `restart`, `logs`, `status`
  apontando para `ecosystem.config.cjs`, e `docs/DASHBOARD_SEGURANCA_GUIA.md`
  documenta `pm2 status`/`pm2 logs`. É dependência de operação, não lixo.
- **`src/` não importa nada que exista apenas em `devDependencies`** (varredura
  de todos os imports por pacote, incluindo escopo `@`). Portanto não há
  dependência de produção usada só por teste, nem dependência de teste
  necessária em produção.
- `npm ci` rodou do lockfile final sem divergência, e `npm ls` não reporta
  `invalid` mesmo com os dois `overrides` (item 1.6).
- Gate de dependências: `audit-ci` verde com a exceção datada de `braces`;
  `npm audit` vermelho apenas pelo mesmo advisory, por não ter mecanismo de
  exceção. Detalhamento em 3.1 e 1.6.
  **Medido em 2026-10-04:** `npm audit --audit-level=high` → 30 high, todos do
  advisory `GHSA-vfj7-8cjw-p6xm` (`braces`), alcançado por três caminhos —
  `jest/micromatch` e `lint-staged/micromatch` (dev) e `pm2/chokidar`. Com
  `--omit=dev` são **3 high**, porque `pm2` é dependência de **produção**. A nota
  do `.audit-ci.json` afirmava que todos os caminhos eram de `devDependencies`;
  estava errada e foi corrigida. Nenhuma entrada de requisição HTTP alcança o
  código afetado, e não existe versão corrigida de `braces` para instalar — o
  motivo de ser exceção datada (`2027-01-01`) em vez de correção.
- Actions: item 1.8, todas em versões suportadas e sem a action arquivada.

O item do congelamento do lockfile só fecha no freeze (seção 8).

---

## 5.3 Secrets e arquivos sensíveis

[x] `.env` não está versionado.

[x] `.env.prod` não está versionado.

[x] arquivos PEM reais não estão versionados.

[x] logs de teste não contêm secrets.

[x] dumps de banco não estão no Git.

[x] Gitleaks passa.

[x] exemplos/documentação não contêm credenciais reutilizáveis.

### Evidência

`git ls-files` com filtro para `.env`, `.pem`, `.key`, `.p12`, `.crt`, `.dump`,
`.bson` e `.gz` devolve **apenas** `.env.example` e `.env.prod.example`. O
`.gitignore` cobre `.env`, `.env.test`, `.env.prod`, `.env.docker`, `secrets/`,
`.cfg-secrets/` e `*.pem`.

Nos exemplos versionados, os campos de segredo são placeholders
(`JWT_SECRET=your-super-secret-jwt-key-with-at-least-32-chars-for-security`,
`JWT_SECRET=troque-por-uma-chave-aleatoria-de-pelo-menos-48-bytes`), não valores
que alguém possa reutilizar.

Gitleaks (`npm run test:secrets`) varreu 96 commits e 4.52 MB sem achado, e
inclui os testes que garatem que nenhum `.env*` versionado carregue segredo
real.

---

# 6. DOCUMENTAÇÃO DA 1.0.0

Antes de criar a tag final, revisar estes arquivos:

[x] `README.md`

[x] `docs/ARQUITETURA.md`

[x] `docs/SEGURANCA.md`

[x] `docs/REDIS.md`

[x] `docs/ROTACAO.md`

[x] `docs/BACKUP.md`

[x] `docs/CONFIG.md`

[x] `docs/metricas.md`

[x] `MICROLOGIN_ANALISE_E_ROADMAP.md` — **removido**, não movido (ver "Depois da
1.0.0" abaixo).

### O que foi corrigido nesta revisão de documentação

Cada item abaixo era uma divergência entre o que a documentação afirmava e o que o
código faz, ou um arquivo corrompido. Nada aqui éRODUCTION feature:

| Arquivo | Defeito | Correção |
|---|---|---|
| `README.md`, `docs/ARQUITETURA.md`, `docs/metricas.md`, checklist, `src/domain/index.ts`, 2 testes | caracteres CJK corrompidos no meio de frases | reescritos; varredura CJK agora limpa no repositório inteiro |
| `README.md` | link para `MICROLOGIN_ANALISE_E_ROADMAP.md`, arquivo removido no `9c879bc` | link retirado, com nota do que o substituiu |
| `README.md`, `docs/SEGURANCA.md` | âncora `#10-projeção-…` apontava para o heading `## 11. Projeção…` | corrigida para `#11-`; varredura de todas as âncoras internas: **0 quebradas** |
| `docs/REDIS.md` | "o logout happened" e "8 asserções" (o arquivo tem 9 casos) | corrigido |
| `docs/CONFIG.md` | "crondiário" | corrigido |
| `docs/ARQUITETURA.md` | refresh sem a verificação de existência prévia; ordem de troca, exclusão e concorrência ausentes | reescrito contra `src/domain/index.ts` |
| `docs/metricas.md` | referenciava `MAX_CONCURRENT_LOGINS`, que não existe | substituído pelo semáforo real e por `ARGON2_MAX_CONCURRENCY`/`ARGON2_MAX_QUEUE` |
| `docs/SEGURANCA.md` | D17 citava 2 das 4 variáveis de pepper | as quatro nomeadas, com link para `ROTACAO.md` §2 |
| `.env.prod.example` | nenhuma das 4 variáveis de pepper, embora `ROTACAO.md` §2 as peça em produção | bloco comentado adicionado, no estilo das variáveis opcionais do arquivo |
| `.audit-ci.json` | a nota afirmava que "todos os caminhos são de `devDependencies`, incluindo `pm2/chokidar`" — **falso**: `pm2` é dependência de produção | nota reescrita: 3 dos 30 high estão na árvore de produção, com o motivo de não haver correção disponível |
| `scripts/benchmark-password-hash.mjs` | "8" seguido de um caractere CJK no lugar de "núcleos" | corrigido |

Os oito runbooks (`REDIS`, `ROTACAO`, `BACKUP`, `CONFIG`) foram conferidos contra
o código e contra o `.env.prod.example`: nomes de variável, flags de script,
números de RPO/RTO e caminhos citados existem. `ROTACAO.md` §1 usa
`JWT_ES256_PREVIOUS_PUBLIC_KEY_PATH`, que **parece** não bater com o código — e
bate: `readPem` (`appConfig.ts:327`) cai para `<NOME>_PATH` quando a variável sem
sufixo não está definida.

### O README deve deixar claro

[x] O que o serviço faz. — "O que o projeto inclui" + "Endpoints principais"

[x] Stack utilizada. — "Stack"

[x] Como subir localmente. — "Como rodar localmente"

[x] Como executar testes. — "Testes"

[x] Como gerar chaves JWT. — "Como gerar as chaves JWT", com
`scripts/generate-jwt-keys.sh --for-container` e o aviso de dono de arquivo

[x] Como configurar Redis/Mongo. — "Variáveis de ambiente", com as portas e
`URI_MONGODB`/`REDIS_URL`

[x] Como fazer deploy. — "Deployment" + "Como o ambiente é escolhido"

[x] Como fazer rollback. — "Como fazer rollback", por digest

[x] Limitações conhecidas. — "Limitações conhecidas"

[x] Política de logout: encerra todas as sessões. — seção própria, com o motivo de
o logout exigir o refresh token

[x] Limite D20 do Redis. — "O limite que dá nome ao projeto", com o custo medido

[x] O que é demonstração de portfólio e o que não é promessa de SaaS de escala
ilimitada. — primeira linha ("Projeto de portfólio"), a nota de versão no topo
("Não significa pronto para SaaS em escala ilimitada") e "Observações importantes"

### Depois da 1.0.0

[x] Mover/renomear roadmap histórico para uma seção de histórico ou manter
claramente como documento de auditoria anterior.

> **Resolvido por remoção, não por renomeação.** O `MICROLOGIN_ANALISE_E_ROADMAP.md`
> foi deletado no commit `9c879bc` (`docs(roadmap): substitui as fases por
> defeitos e provas faltantes`), que reescreveu o plano como este checklist. O
> conteúdo que ainda valia foi absorvido por aqui e por `docs/SEGURANCA.md`. O
> README tem uma nota dizendo isso explicitamente, com o link para o substituto.
> **Não restaurar o arquivo**: ele descrevia fases como plano aberto, o que
> contradiz uma `1.0.0` com suíte verde. O que o item pedia — não deixar um
> roadmap histórico parecendo auditoria vigente — está feito; o meio foi remover
> em vez de arquivar, e isso está dito aqui para não parecer mais fiel ao item do
> que é.

[x] Não deixar no README uma lista de "TODOs" que pareça bloquear a versão
estável quando forem apenas melhorias futuras.

> O README não tem seção de TODO. As limitações estão declaradas como
> **limitações**, com o custo medido e a decisão que as justifica (D20, D21,
> D23), não como trabalho pendente. O que ainda está por fazer e é bloqueio real
> está no checklist, não no README.

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

- [x] Todos os P0 concluídos. (Itens 1.1–1.9, 2.1–2.4 e 5.1–5.3 verificados um a
  um, cada um com a mutação que o reprovaria.)
- [x] Todos os testes críticos verdes. (18 comandos reexecutados depois do
  `npm ci` do freeze: lint, typecheck, 925 unit, 42 integration, 16 e2e, 14
  credential theft, 13/13 infra, redis, redis volume-loss, backup, config-backup,
  deploy, replica-session, ddos, capacity, audit-ci, secrets, coverage 967.
  **Ressalva:** o `test:ddos` falhou 1 vez em 7 e passou 6 — ver "Achados".)
- [ ] CI verde no último commit da `main`. (**Não verificado:** sem token e sem
  `gh` CLI; a API sem auth devolve rate limit. `fe488b1` foi enviado, mas o
  resultado do CI precisa ser conferido por quem tem acesso.)
- [x] Release workflow corrigido e validado. (Item 1.9, com testes contra um
  repositório git real.)
- [ ] Docker release real, não apenas simulado por `echo`. (O passo de Docker foi
  reescrito para `buildx build --push` real e o comando é verificado por teste de
  política, mas **não foi executado**: exige registry e tag publicada.)
- [x] Documentação atualizada. (Seção 6 fechada item a item, com o defeito
  corrigido de cada arquivo.)
- [x] `RELEASE_1.0.0_REPORT.md` criado.
- [ ] `v1.0.0` criado em commit correto. (Depende do freeze; a tag atual ainda
  aponta para `e29032f`.)
- [ ] GitHub Release publicada.
- [ ] Imagem Docker versionada publicada.
- [ ] Smoke pós-release verde.
- [x] Nenhum TODO restante classificado como blocker. (O que resta aberta está
  listado em "O que falta, em ordem" abaixo, e cada item tem o motivo.)

## O Release 1.0.0 rodou e falhou: `JWT_SECRET` curto

- **O que aconteceu:** o `Release` disparado pelo push da tag (`dedea92`) rodou
  em 65 segundos e terminou em `failure`. `validate` passou, `quality` passou
  **inteiro** — os oito steps verdes, incluindo `audit-ci`, o que confirma que a
  remoção do `npm audit` foi a correção certa — e `tests` falhou no step `Run test
  suite`. `image`, `security` e `release` ficaram `skipped`.
- **Causa:** os jobs escreviam `JWT_SECRET=release-pipeline` (16 caracteres).
  `validateConfiguration()` exige **no mínimo 32** para `JWT_SECRET`. Sete testes
  de `security-config` derrubavam com `Configuração inválida: - JWT_SECRET deve
  ter pelo menos 32 caracteres`.
- **Por que ninguém viu localmente:** rodada de unitário nesta máquina passa
  porque o `.env` não existe e não há `JWT_SECRET` no shell, então a validação
  nem entra no caminho. Só o job do runner monta o ambiente — e era a primeira
  vez que esse ambiente era montado por alguém.
- **`ci-cd.yml` tinha o mesmo defeito**, com `JWT_SECRET=test-secret-ci-cd`
  (20 caracteres), rodando exatamente a mesma suíte. Nunca observável aqui pelo
  mesmo motivo.
- **Correção:** os dois workflows passaram a escrever segredos de teste com
  40 e 35 caracteres. O nome diz que não é segredo real
  (`ci-release-pipeline-secret-nao-e-real-32`), porque é isso que é: valor de
  fixture, num job de teste.
- **Teste que fecha a classe do defeito:** `tests/unit/release-pipeline.test.ts`
  agora extrai todo `VAR=valor` escrito em `$GITHUB_ENV` de `release.yml` e
  `ci-cd.yml`, e passa esse ambiente pelo **`validateConfiguration()` real** —
  não por uma regra copiada. Falha se a configuração rejeitar. Verificado que
  tem dentes: restaurando o valor curto, o teste falha com a mensagem de 32
  caracteres.
- **A lição, pela terceira vez:** `npm audit` que reprovava sempre, preflight de
  DDoS que não verificava nada, e agora um valor de ambiente inválido. Os três
  eram **valores e gates de workflow que ninguém nunca executou**. Nenhum dos
  três apareceu em nenhum gate local, porque nenhum deles é alcançável sem o
  runner. Pre-flight local encontra a maior parte; esta classe só aparece
  executando.

## Decisões tomadas sem verificação possível

Esta seção existe porque um checklist que só registra o que deu certo serve
para nada quando alguém precisa saber em que ponto o registro é paroleiro.

- **A tag `v1.0.0` foi movida sem CI verificado.** O gate "CI verde" do item 3
  do estado final **não foi checado** nesta máquina: sem token, sem `gh` CLI, e
  a API do GitHub sem autenticação responde rate limit. A decisão foi tomada
  pelo owner após a informação estar disponível e exposta duas vezes, e a
  operação é reversível (`e29032f` é ancestral de `main`). O registro fica
  explícito: **quem confirmar o CI agora confirma depois do fato.**
- **O `Release` foi observado em execução, e falhou.** O push da tag disparou o
  workflow, e a execução é pública: `validate` e `quality` verdes, `tests`
  vermelho, `image`/`security`/`release` `skipped`. Causa e correção na seção
  "O Release 1.0.0 rodou e falhou" acima. Os outros três achados desta passagem
  (`npm audit`, preflight de DDoS, arm64) vieram de **pre-flight local**; este
  quarto só apareceu porque alguém rodou. Ainda não há execução do `release.yml`
  que chegue ao fim.
- **A etapa de release que falta confirmar é o `image`.** Foi a única que não
  pôde ser reproduzida: exige `buildx --push` contra registry e token do GHCR.
  A parte local foi verificada (build do stage `production`, argon2 nativo,
  OpenAPI com 21 endpoints dentro da imagem, boot via `test:deploy`).
- **Nada de staging ou produção foi exercitado, e continua valendo:** não há
  `STAGING_DEPLOY_HOST`, `PRODUCTION_DEPLOY_HOST` nem secrets correspondentes.

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

### `test:ddos` falhou uma vez em sete execuções, e a causa não foi capturada

- **Sintoma:** na primeira execução depois do `npm ci` do freeze, o drill
  terminou com `exit 1` e `checks: 99.69% (3301 de 3311)` — **10 checks
  falharam**. As seis execuções seguintes passaram com `100.00%`.
- **O que se sabe:** os checks do script (`k6/ddos-survival.js:95-147`) são
  `status < 500` em login, refresh, register e forwarded-IP, e
  `status === 200` em liveness. Os *thresholds* são `ddos_liveness_failures:
  ['count==0']` e `ddos_server_errors: ['count<5']`.
- **O que NÃO se sabe, e é o problema:** **quais** checks falharam. A saída
  daquela execução foi filtrada por `grep` e o nome dos checks que falharam se
  perdeu. Não dá para distinguir "o liveness piscou 10 vezes" de "um 5xx no
  register flood" — que são defeitos completamente diferentes.
- **Leitura provável:** 10 falhas em 3311 checks, com 2 VUs de liveness por 20s,
  é a assinatura de `liveness stays 200 during flood` cedendo algumas vezes
  durante o flood — exatamente a propriedade que o drill existe para proteger
  (itens 2.4 e o escopo de DDoS). **É hipótese, não medição.**
- **Por que não foi reproduzido:** seis execuções seguidas passaram. O drill
  demora ~2 min cada e exige compose próprio; a taxa de falha observada é de
  ~1 em 7, o que significa que fewar mais execuções pode não reproduzir.
- **Não é bloqueante para a 1.0.0**, por duas razões: a propriedade testada
  (o serviço sobrevive ao flood, com liveness em 200 e o resto em 429) foi
  verificada nas seis execuções seguintes, e a falha não se reproduz. **Mas
  fica como pendência real**, e a ação sugerida é rodar o drill em CI algumas
  vezes e falhar o build quando os checks caírem — é a forma de transformar um
  sintoma intermitente em dado.
- **Correção de processo que já vale:** em gate que possa falhar, capturar a
  saída inteira (com `tee`), não filtrar com `grep`. Foi esse filtro que
  destruiu a evidência.

### O `release.yml` tinha um gate que nunca podia passar

- **Sintoma:** nenhum. O pipeline nunca foi executado de ponta a ponta, então
  ninguém tinha visto o step falhar.
- **O step:** `release.yml`, job `quality`, tinha
  `npm audit --audit-level=moderate` como step de gate. Medido nesta árvore:
  **exit 1**. O `npm audit` não tem mecanismo de exceção, e a única advisory
  `moderate+` da árvore (`GHSA-vfj7-8cjw-p6xm`, `braces`) está allowlisted no
  `.audit-ci.json` até 2027-01-01 justamente porque **não existe versão
  corrigida** para instalar.
- **Por que era bloqueador, e não cosmético:** `quality` está em `needs` de
  `image`, e `image` em `needs` de `release`. Um step que sempre falha nesse
  caminho significa que **a release nunca seria publicada**. E o dano só
  apareceria **depois** da tag `v1.0.0` reescrita, com `e29032f` já
  irrecuperável por tag.
- **Agravante:** o próprio checklist diz, em 3.1, que "`npm audit` não tem
  mecanismo de exceção" e que "o gate que decide é o `audit-ci`". O `release.yml`
  mantinha os dois, e o que não tem exceção era o que barrava. O item 5.2
  afirmava "`npm audit` e `audit-ci` estão verdes" — afirmação falsa, corrigida.
- **Correção:** o step `npm audit` foi removido do job `quality`, e o `audit-ci`
  ficou como o gate de dependências. O `audit-ci` cobre o mesmo threshold
  (`moderate: true` no `.audit-ci.json`) **com** a exceção, então nada se perde
  em cobertura — inclusive a proteção contra advisory `moderate+` nova, que é
  o que o step estava ali para pegar.
- **Teste que trava a correção:** em `tests/unit/release-pipeline.test.ts`, o
  gate que **exigia** o step quebrado foi invertido em
  `o gate de dependências não é o npm audit cru, porque ele nunca passa`, que
  falha se `npm audit --audit-level` voltar a aparecer em qualquer `run:`.
  Antes o teste protegia o defeito; agora protege a correção.
- **Lição de processo, a mesma do `test:ddos`:** os dois problemas encontrados
  nesta passagem final eram **steps e gates que ninguém nunca executou**. Um gate
  não exercitado não é evidência de nada — é uma hipótese. Vale executar o
  pipeline de release completo ao menos uma vez, mesmo em um repositório de
  portfólio.

### O "gate" de DDoS no pipeline não é um gate

- **O que parece:** `npm run test:ddos -- --preflight-only` no job `tests`, ao
  lado de `test:unit`, `test:credential-theft` e `test:integration`. Lido de
  relance, parece que a release prova resiliência a DDoS.
- **O que é:** o flag retorna em `scripts/ddos-survival-test.mjs` **antes** das
  checagens de Docker, k6, bash e openssl. Ele resolve e imprime a URL alvo.
  Passei com ou sem k6 instalado — medido.
- **Por que ficou assim, e não é omissão:** a suíte real exige host
  provisionado, e `test:ddos` **falhou 1 vez em 7**. Como gate de release, a
  consequência seria trocar "release nunca publicada" por "release falha 1 em 7".
- **O que era perigoso:** não o passo em si, e sim ele parecer uma verificação.
  É a mesma classe do `npm audit` removido —aparência de proteção. A diferença
  é que aqui a omissão é deliberada, e **deliberação não escrita vira engano na
  próxima leitura**. O comentário no `release.yml` agora diz, na cara de quem
  for ler, que aquilo não é um gate de DDoS e por quê.
- **Testes que prendem os dois lados:** um exige que o job continue em modo
  preflight (se o flag sumir, o job passa a exigir k6 no runner e reprova), e
  outro **executa** o script com um `PATH` sem `k6`/`docker`/`bash`/`openssl`
  para provar que o retorno acontece antes das checagens — o que também impede
  que alguém "conserte" o early return e transforme o passo em dependência de
  binários do host.
- **O que fica fora do pipeline, e é onde a resiliência é medida:** o drill do
  k6 roda localmente e o resultado está no relatório de release.

### A imagem de produção, e o arm64 que saiu

- **`docker build` do stage `production` foi executado** (exit 0). Antes disso
  só havia inspeção, o que não é evidência.
- **Dentro da imagem, verificado:** o `@node-rs/argon2` nativo carrega e faz
  hash/verify corretos. Isso era o ponto sensível — `npm ci --omit=dev` precisa
  trazer o binário **musl** certo, e um stage de produção com dependência nativa
  errada só quebra em runtime, nunca em build.
- **O risco do `src/` não copiado foi checado:** o `swagger-jsdoc` lê as rotas
  em disco, e a imagem traz só `dist/`. O glob tem dois layouts e, compilado,
  aponta para `dist/application/routes/*.js` — gerar **21 endpoints** dentro da
  imagem. Se isto estivesse quebrado, `/api-docs` seria uma página bonita e
  vazia — o tipo de defeito que ninguém percebe até alguém tentar usar a API a
  partir da documentação.
- **O boot da imagem de produção já era coberto:** `scripts/deploy.sh` faz
  `docker build` (stage padrão = produção) e espera `/health` antes de dar
  sucesso, e `test:deploy` passou.

#### O arm64 saiu do build

- **O `image` job publicava `--platform linux/amd64,linux/arm64`.** Dois defeitos,
  e o primeiro é o que importa.
- **`buildx` constrói todas as plataformas numa única invocação.** Se o arm64
  falhasse, a release inteira cairia — inclusive para quem só puxa amd64. O
  `--platform` não é "um extra opcional": ele coloca a plataforma no caminho
  crítico.
- **Não havia nada consumindo arm64.** Nenhum `docker-compose*.yml` pinando
  plataforma, nenhum script de deploy tocando arm64, nenhum
  `STAGING_DEPLOY_HOST` nem `PRODUCTION_DEPLOY_HOST`. E nunca foi verificado: a
  máquina não tem QEMU, então a única evidência era o lock mostrar
  `linux-arm64-musl` com `resolved` e `integrity`.
- **Saiu por decisão, não por esquecimento**, e o teste exige
  `not.toMatch(/linux\/arm64/)` para ninguém reintroduzi-lo em silêncio. O
  comentário no `release.yml` registra o motivo ao lado do comando.
- **O risco era de build, não de segurança:** com `@node-rs/argon2`, é bem
  provável que o arm64 *funcionasse*. Publicar uma plataforma sem consumidor e
  sem verificação, dentro do caminho crítico, compra um modo de falha em troca
  de nada.
- **Quando alguém precisar de arm64:** entra como item próprio, com build e
  verificação próprios.

#### Por que plataforma importa num projeto que parece universal

- **Node é universal; a imagem não é.** O código roda em Linux, macOS e
  Windows, e o lock traz `darwin-*` e `win32-*`. Mas o `Dockerfile` se
  compromete com `node:22-alpine` — **musl**, não glibc — e com uma arquitetura
  de CPU. `apk add`, `addgroup -g 1001` e `dumb-init` são Linux.
- **A prova está no próprio lock:** `@node-rs/argon2` tem **13 pacotes**
  plataformaspecíficos, cada um com `cpu`, `os` e `integrity` próprios.
- **N-API padroniza a interface de chamada, não o artefato compilado.** Não
  existe bytecode sem arquitetura em addon nativo; por isso `linux-arm64-musl` é
  um pacote à parte.
- **O musl é o canto mais afiado:** um addon que compila via `node-gyp` precisa de
  `python3`, `make` e `g++`, que o Alpine não tem. O projeto escapa por usar
  `@node-rs`, e não o `argon2` do node-gyp — o mesmo passo quebraria no arm64 e
  passaria no amd64. Universalidade que depende de qual pacote você escolheu não
  é universalidade.

### Tag `v1.0.0` movida para o commit de freeze

- **Estado:** **executado.** `v1.0.0` aponta para `1392e2b`, local e no remote.
  Confirmado por `git ls-remote --tags origin` e por
  `git rev-parse v1.0.0^{commit}`. A tag é anotada
  (`git cat-file -t v1.0.0` devolve `tag`); o objeto tag tem SHA próprio e o
  commit, outro.
- **Movida três vezes, e cada movimento tinha um motivo:** para `dedea92`
  (freeze), depois para `f680df8` (`JWT_SECRET` curto), depois para `3324ef1`
  (`--tag` separado por vírgula), e por fim para `1392e2b` (npm na imagem de
  runtime). A tag nunca foi movida por conveniência: cada `--force` cobriu um
  pipeline que tinha reprovado de verdade.
- **Antes disso:** `v1.0.0` apontava para `e29032f`, 91 commits atrás de `main`,
  sem release, imagem nem digest. Era uma tag plantada antes de o projeto
  existir como produto.
- **Decisão (2026-10-04): mover a tag para o commit de freeze.** A alternativa —
  publicar `v1.0.1` — foi descartada porque o checklist inteiro, o
  `package.json`, o `/health` e o README já declaram `1.0.0`, e `release.yml`
  exige que a tag e o `package.json` concordem. Duas tags apontando para versões
  diferentes do mesmo código é pior que reescrever uma tag que nunca foi publicada.
- **O que isso custou:** `e29032f` deixou de ser recuperável **por tag**. O commit
  não some — continua no histórico e é ancestral de `main` —, mas `git pull
  v1.0.0` devolve o freeze. O `--force` no push da tag é o passo destrutivo, e é
  intencional.
- **Reversão, se for preciso:** `git tag -f -a v1.0.0 -m "..." e29032f &&
  git push --force origin v1.0.0`. Registrado porque `e29032f` é ancestral de
  `main` e, portanto, alcançável — a operação é destrutiva, mas não é
  irrecuperável.
- **Efeito colateral no changelog do pipeline:** `release.yml` resolve a tag
  anterior com `git describe --tags --abbrev=0 "${TAG}^"` (linha 120). Depois do
  movimento, não sobra nenhuma outra tag no repositório, então essa resolução
  devolve vazio e o corpo da release assume o ramo `else` de
  `Generate changelog` (linha 366): "Primeira versão publicada a partir deste
  repositório". Isso é **exato** — depois do movimento, é a primeira. O
  `CHANGELOG.md` versionado no repositório é outro arquivo, com o histórico
  completo, e não é sobrescrito pelo pipeline (que só o usa como `body_path`).
- **Comando executado**, no lugar de `git tag -a v1.0.0`. Repetido três vezes,
  cada uma apontando para o commit que corrigia a falha anterior:

```bash
git tag -f -a v1.0.0 -m "Release v1.0.0" dedea92   # freeze
git push origin main
git push --force origin v1.0.0
# depois: f680df8 (JWT_SECRET), 3324ef1 (--tag), 1392e2b (npm na imagem)
```

- **Disparo:** `on: push: tags: 'v*.*.*'` casa com `v1.0.0`, então o `Release`
  foi disparado pelo push. Se não aparecer no GitHub, o caminho é
  `workflow_dispatch` com `tag: v1.0.0` — o dispatch não cria tag, usa a que já
  existe.

## Estado final

### Pós-release, item a item

Verificado contra a imagem **publicada**, puxada de `ghcr.io` por digest, com o
Mongo e o Redis reais:

| Item | Estado | Evidência |
|---|---|---|
| GitHub Release `v1.0.0` existe | ✅ | HTTP 200, marcada `Latest` |
| Não está como draft/prerelease | ✅ | sem marcador `Draft` nem `Pre-release` |
| Changelog correto | ✅ | "Primeira versão publicada a partir deste repositório" |
| Assets esperados presentes | ✅ | nenhum asset — a imagem é a release |
| Imagem `1.0.0` existe | ✅ | `1.0.0`, `v1.0.0`, `1392e2b`, `latest` |
| Digest bate com o do workflow | ✅ | `sha256:e9af7259e…` no corpo e em execução |
| Pull da imagem funciona | ✅ | `docker pull` anônimo, sem login |
| Container sobe da imagem publicada | ✅ | sobe e fica `healthy` |
| `/health` responde | ✅ | 200, `mongodb: connected`, `redis: healthy` |
| `/readiness` responde | ✅ | 200, `ready: true`, `degraded: false` |
| Smoke funcional | ✅ | login 400 validando, 404 em rota inexistente |
| Rollback funcional | ✅ | `npm run test:deploy` verde |
| Commit/tag documentados | ✅ | `1392e2b` |

O rollback foi o único que exigiu execução: `npm run test:deploy` roda v1 → v2 →
v3 com Mongo na porta errada, e o script aborta no health check e restaura
imagem, digest e env da v2. Todas as etapas verdes.

E foi justamente esse drill que revelou um quinto defeito — ver abaixo.

### Estado final

```text
[x] NÃO PRONTO            <- estado em 2026-10-04, ver abaixo
[x] CANDIDATO A RELEASE
[x] 1.0.0 LANÇADA          <- Release publicada em 2026-10-04T17:42:35Z
```

**1.0.0 lançada em 2026-10-04T17:42:35Z.** O freeze local está fechado
(lockfile congelado, gates reexecutados) e o pipeline foi até o fim, depois de
quatro execuções em que cada uma reprovou por um defeito do workflow. O único
item que continua aberto é a prova em staging/produção, e ele depende de hosts e
secrets que não existem aqui.

### O que falta, em ordem

1. ~~**Commit** das alterações desta revisão.~~ **Feito:** `fe488b1`, e mais
   `12a4b95`, `d15c562`, `8445b36`, `dedea92`, `bca1014`, `f680df8`, `3324ef1`
   e `1392e2b` — todos na `main`.
2. ~~**Congelar o lockfile** (`npm ci`).~~ **Feito:** `npm ci` exit 0,
   `package.json`/`package-lock.json` intactos, `npm ls --all` sem `invalid`,
   e os 18 gates reexecutados depois dele — todos verdes, exceto a
   intermitência do `test:ddos` registrada acima.
3. ~~**CI verde**~~. **Feito.** Passou por quatro execuções, e cada uma
   reprovou por um defeito diferente do pipeline — nenhum deles no código do
   serviço. Registrados abaixo como "Os cinco defeitos".
4. ~~**Mover a tag** `v1.0.0` para o commit de freeze.~~ **Feito:** a tag foi
   movida três vezes, terminar em `1392e2b`, verificado por
   `git ls-remote --tags origin`.
5. ~~**Release real**: `buildx build --push`, digest, SARIF, GitHub Release.~~
   **Feito.** Run `37221333414`, os seis jobs verdes:
   `validate`, `quality`, `tests`, `image`, `security`, `release`.
   Release `v1.0.0` publicada em `2026-10-04T17:42:35Z`, com o digest
   `sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b`.
6. ~~**Smoke pós-release** contra a imagem publicada.~~ **Feito.** A imagem foi
   puxada de `ghcr.io` **por digest**, sem tag, e rodada contra o Mongo e o
   Redis reais do compose: `readiness` 200 com `mongodb: connected` e
   `redis: healthy`, `login` 400 em payload inválido, rota inexistente 404,
   `node v22.23.3`, 222 pacotes de produção, e `npm` ausente. Detalhes em
   "Smoke pós-release", abaixo.
7. **Provas de staging/produção** (`workflow_dispatch` com `environment=staging`),
   que dependem de `STAGING_DEPLOY_HOST`/`PRODUCTION_DEPLOY_HOST` e secrets
   externos. Não são bloqueantes para a release, mas **são** para afirmar que o
   deploy foi exercitado em produção.

### Os cinco defeitos

Nenhum era do serviço. Três estavam no workflow e um no script de drill. Dois
deles eram visíveis sem rodar nada — o teste que deveria cobri-los existia e
passava.

1. **`JWT_SECRET` curto nos jobs `quality` e `tests`** (run `37214687216`).
   16 caracteres, mínimo 32. `validate` passou; `quality` e `tests` reprovaram.
2. **Um `--tag` para quatro tags** (run `37216423853`). O script juntava as
   tags numa string separada por vírgula:
   `--tag "img:1.0.0,img:v1.0.0,img:sha,img:latest"`. O buildx recusa com
   `invalid reference format` e o build falha antes de tocar no registry.
   Bug pré-existente: o workflow antigo construía `TAGS` do mesmo jeito, e
   nunca tinha rodado — `image` é o primeiro job que empurra para um registry.
   **O teste passava com o comando quebrado**, porque conferia substring
   (`:1.0.0`, `:v1.0.0`) e a string unida por vírgula contém ambos. O stub de
   docker aceitava qualquer coisa e só registrava. O stub agora valida cada
   referência com o mesmo critério do buildx.
3. **O npm da imagem base reprovava o gate do Trivy** (run `37217066854`).
   10 HIGH, todas em `/usr/local/lib/node_modules/npm/node_modules/` — a árvore
   que o npm embarcado na base traz, não nosso código nem nosso lockfile. Zero
   vulnerabilidades de SO. Nosso `node_modules` estava limpo
   (brace-expansion 1.1.21, picomatch 2.3.2, ip-address 10.7.2).
   Não dava para consertar pelo caminho óbvio: as correções exigem pacote
   `>=21.5.1` e brace-expansion `>=5.0.11`, e **`node:24-alpine` não resolve** —
   verificado, ele embarca brace-expansion 5.0.7, e 4 dos 5 CVEs daquele pacote
   só fecham a partir de 5.0.11. Remover o npm da imagem de runtime resolve, e
   é a correção verdadeira: o código vulnerável sai em vez de o scanner ser
   silenciado.

4. **O cleanup do drill de deploy nunca removeu uma imagem** (`f4dbf69`).
   Achado depois da release, ao rodar `npm run test:deploy` para fechar o item
   "rollback funcional" do pós-release. Termina com
   `--filter "reference=deploy-drill*"`; o glob do filtro `reference` do Docker
   segue o `filepath.Match` do Go, em que `*` **não** atravessa `/`, e o filtro
   compara contra `repo:tag`, que tem barra. Medido com as 10 imagens do drill
   existindo: `deploy-drill*` → 0, `deploy-drill/*` → 7. Cada execução vazava
   ~3,4 GB, e o drill roda em CI.

   O detalhe que escondeu: filtro que não casa nada devolve vazio, e vazio parece
   "já estava limpo". Com `2>/dev/null`, `|| true` e o pipeline sem `pipefail`, o
   zero parecia um sucesso silencioso. Em revisão,
   `docker image rm $(docker image ls --filter ... -q)` parece obviamente correto
   — eu escrevi isso e não duvidei.

Todos foram corrigidos com teste que falha se o defeito voltar. Nos dois casos em
que o teste antigo era insuficiente, verifiquei reintroduzindo o defeito:

- **item 2:** restaurada a vírgula, o teste reprova com a mensagem do buildx.
- **item 4:** restaurado o `--filter`, 5 dos 7 testes reprovam.

O teste do item 4 executa o `awk` do próprio script, trocando só a fonte
(`docker images` → `cat`). Reescrever a lógica no teste faria o teste passar com
o mesmo defeito — que é exatamente o modo de falha do item 2.

### Smoke pós-release

Imagem puxada de `ghcr.io/dioneyfroes-coder/micrologin` **por digest**, sem tag,
na rede do compose, com o mesmo ambiente que o serviço recebe:

```text
readiness .............. 200
checks ................. ready | mongo: connected | redis: healthy
login payload vazio ... HTTP 400
rota inexistente ..... HTTP 404
npm na imagem ......... AUSENTE
node ................... v22.23.3
deps de produção ....... 222 pacotes
digest rodando ......... sha256:e9af7259e545b1880d1837311e54d984b3a7366c84ce40ba26e622586cae348b
```

O digest rodando é o mesmo que o pipeline registrou na release. As quatro tags
(`1.0.0`, `v1.0.0`, `1392e2b`, `latest`) respondem em `ghcr.io`.

Pull anônimo funciona, mas com uma ressalva que não é óbvia: `curl` direto no
manifest retorna 401, e o `docker pull` funciona. O token anônimo que o
`ghcr.io` emite carrega identidade vazia (`0:...`), e o `curl` não consegue
negociar o escopo. Quem for consumir a imagem por script precisa passar por um
cliente que faça a troca de token — `docker pull` e `docker manifest inspect`
funcionam, `curl` cru não.

---

## Referências técnicas atuais consultadas em 2026-10-02

- audit-ci: https://github.com/IBM/audit-ci
- CodeQL Action: https://github.com/github/codeql-action
- Codecov Action: https://github.com/codecov/codecov-action
- Trivy Action: https://github.com/aquasecurity/trivy-action
- action-slack arquivada: https://github.com/8398a7/action-slack
- Slack GitHub Action: https://github.com/slackapi/slack-github-action
- GitHub Release Action: https://github.com/softprops/action-gh-release
