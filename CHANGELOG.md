# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), e o
projeto segue [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não publicado]

Nada ainda.

## [1.0.0] — primeira release estável

"Estável" aqui significa **suíte de release verde e limitações declaradas** —
não prontidão para SaaS. As limitações estão em
[`README.md`](README.md#limitações-conhecidas) e as decisões que as justificam,
em [`docs/SEGURANCA.md`](docs/SEGURANCA.md).

O item a item, com a evidência de cada um, está em
[`MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md`](MICROLOGIN_1.0.0_RELEASE_CHECKLIST.md).

### O que `1.0.0` significa neste repositório

**A semântica do número começa aqui, e não no primeiro commit.**

O `package.json` deste projeto diz `1.0.0` desde o commit `011769e` — o primeiro
que o contém, quando o projeto ainda se chamava `autentication` e o código não
tinha nenhuma das garantias listadas abaixo. A versão teve **um único valor em
toda a história do repositório**: nunca `0.1.0`, nunca `0.9.0`. Ela não subiu até
`1.0.0`; ela já estava lá.

Isso importa para como se lê este changelog. Um número de versão escrito antes de
o código existir não é promessa cumprida, é texto de arquivo. Então:

- **Não** leia `1.0.0` no `package.json` como afirmação de prontidão. Ele estava
  lá antes de qualquer coisa estar pronta.
- Leia a **tag** `v1.0.0` e a **release**. Elas existem porque o pipeline rodou
  de verdade e passou: imagem construída e publicada por digest em
  `ghcr.io`, gate do Trivy verde, SARIF enviada, e a release gerada pelo
  workflow.

O que tornou esta `1.0.0` verdadeira foi o trabalho, não o número:

- **O pipeline roda e barra de verdade.** Quatro defeitos de workflow foram
  encontrados **pelo próprio pipeline**, não por revisão: `JWT_SECRET` curto nos
  jobs, quatro tags num `--tag` só (que o buildx recusa), 10 vulnerabilidades
  HIGH vindas do npm que a imagem base embarca, e um cleanup de drill que nunca
  removeu uma imagem. Cada um corrigido com teste que reprova se o defeito
  voltar.
- **944 testes** em 65 suítes, e o `test:deploy` prova backup, readiness, smoke
  e **rollback** de imagem e configuração.
- **A imagem publicada foi exercitada**, não só construída: puxada de `ghcr.io`
  por digest, containers de Mongo e Redis reais, `readiness` 200 com ambos
  healthy.

A consequência prática: este repositório não tem track record de versões
estáveis. Esta é a primeira, e nenhuma `0.x` foi publicada. A partir daqui a
semântica é a do [SemVer](https://semver.org/lang/pt-BR/) — `0.x` para
instável, e um próximo `1.1.0` vai ser a primeira versão que **ganhou** o sinal
de estabilidade em vez de herdá-lo.

### Correção de segurança

### Correção de segurança

- **Enumeração de usuários por timing mitigada** no login e no registro: respostas
  de credencial inválida e de usuário inexistente passam a ter o mesmo custo e a
  mesma forma. O mesmo padrão ainda **não** foi aplicado a
  `updateUserProfile`, e isso está registrado como pendência em
  [`docs/SEGURANCA.md`](docs/SEGURANCA.md).
- **Segredos de sessão segregados por tipo**: access e refresh passam a ser
  distinguidos por `token_type` validado, e não por um segredo separado — os dois
  tokens deixam de ser intercambiáveis.
- **Logout encerra a sessão inteira**, revogando o refresh a partir do próprio
  refresh token, em vez de encerrar apenas o access token atual.
- **Revogação antes de remover**: `deleteUser` e a troca de senha revogam as
  sessões existentes **antes** de gravar, e uma revogação não confirmada faz a
  operação recusar. Sem isso, o serviço emitia token para conta morta.
- **Limite de concorrência do Argon2 virou limite real**: um semáforo com
  orçamento de memória e fila FIFO (D30) — o limite anterior só era um número no
  log. Excesso devolve `503` com `Retry-After`, e o que é medido em D20 entrou no
  registro de decisões.
- **Argon2id como algoritmo único**, com migração silenciosa a partir do bcrypt
  já gravado; `bcrypt` saiu do projeto.
- **`TRUST_PROXY` deixa de ser decorativo**: com a variável ligada e mal
  configurada, o rate limit por IP ficava sem dono (D24).

### Correção de correção

- **Rotação de refresh token**: a chave nova era verificada *antes* de a anterior
  ser removida do estado; a verificação de existência acontece primeiro, e a
  janela deixou de derrubar sessão.
- **`uncaughtException` não engole mais `forEach`**: o tratamento especial
  removido era o que escondia falha real de estrutura de dados.
- **Reconexão sem desistência, e queda de dependência sem mentira**: o Redis
  volta a conectar sozinho e o health check passa a degradar honestamente em vez
  de se chamar saudável.

### Chave ES256

- A chave provisionada é validada no **formato que o app realmente assina**, e não
  apenas convertida.
- **Janela de rotação com `kid`**: o token carrega o `kid` no header e o validador
  aceita a chave atual e a anterior, o que permite trocar a assinatura sem
  derrubar tokens já emitidos. Par sem nome não rotaciona.

### Resiliência e continuidade

- **Persistência da revogação no Redis** com AOF `everysec` e snapshot RDB como
  segunda camada, em volume nomeado — a blacklist sobrevive a restart e a perda do
  container.
- **Dependências autenticadas com segredo em arquivo**, sem `requirepass` em linha
  de comando, e **rotação com janela** das senhas do Redis e do Mongo.
- **Backup criptografado e restore verificados do MongoDB** (`gpg` AES-256), com
  RPO/RTO medidos por drill e não estimados.
- **Backup da configuração em vigor**: a fonte da verdade é o container em
  execução, não o `.env` do disco — editar o arquivo sem redeployar não pode mais
  fazer o rollback restaurar o valor errado.
- **Rollback restaura imagem e configuração**, com a config aplicada antes de
  subir o compose.
- **Nginx de borda** com proteção contra DDoS, e **teto de vida útil de requisição
  HTTP** no Node.
- **Contagem de réplicas por `instance_id`** (não por PID) para que o limite de
  requisições seja o mesmo com uma ou com N réplicas.
- **Empilhamento 512 MB por processo** a partir da medição de GC, e workers que
  seguem a cota do cgroup em vez da contagem de CPUs da máquina.

### Observabilidade

- Endpoint próprio `/observability`, **derivado de logs** — não há mais um buffer
  de eventos duplicando estado.
- Probes separados (`/health` e `/readiness`) e métricas de autenticação.
- **Confiança em proxy** exposta, e réplicas identificadas nos snapshots.
- Toda falha de autenticação colapsava em `error` no metricador; agora o desfecho
  real da operação é o que aparece.

### API

- **Swagger/OpenAPI**: o glob de rotas apontava para um diretório inexistente, e a
  versão deixou de ser digitada à mão — `src/shared/utils/version.ts` é a fonte
  única, usada pelo spec e pelo `/health`.
- Política de senha em fonte única, histórico de senha e troca com step-up.
- Superfície HTTP documentada no spec: `POST /login`, `POST /register`,
  `POST /refresh`, `POST /logout`, `GET /profile`, `PUT /update`,
  `PUT /password`, `DELETE /delete`, com as probes `GET /liveness`,
  `GET /readiness` e `GET /health`.

### CI/CD e release

- **Pipeline de release reescrito** para entregar release de verdade: tag Git
  como fonte da verdade, changelog determinístico, `buildx build --push` de
  verdade (antes havia apenas um `echo` de sucesso), digest publicado no resumo da
  execução, e `concurrency` por tag.
- **Ambiente de deploy escolhido por input** — nada mais decide, e uma execução
  que escolha staging não toca production por construção.
- **Trivy virou gate**, e não roda só depois do merge.
- Dependências: dois `high` removidos do grafo e o terceiro com exceção datada;
  o gate do `audit-ci` foi corrigido.
- Actions obsoletas/arquivadas removidas; nenhuma ação em tag flutuante.
- **`npm ci` reproduz o lockfile**, que passa a ser versionado.

### Operação

- Deploy e rollback com checagem explícita, hook tolerante e CI restrito à `main`.
- Configuração centralizada no `.env` como fonte da verdade das portas;
  `Dockerfile` multi-stage e Compose de produção enxuto.
- `pm2` e `cluster` module não podem mais subir juntos: o serviço **recusa
  arrancar** nessa combinação.

### Documentação

- `docs/ARQUITETURA.md`, `docs/SEGURANCA.md`, `docs/metricas.md`, `docs/REDIS.md`,
  `docs/ROTACAO.md`, `docs/BACKUP.md`, `docs/CONFIG.md` e
  `docs/DASHBOARD_SEGURANCA_GUIA.md` reescritas contra o código real.
- O projeto passa a se chamar **`micrologin`**. O nome do serviço no Compose
  (`auth-service`), o usuário ACL do Redis e o processo pm2 (`autenticacao`)
  foram **mantidos** de propósito: são identificadores de operação referenciados
  em compose, backup, deploy e drill.
- `MICROLOGIN_ANALISE_E_ROADMAP.md` foi removido do repositório; o checklist de
  release e `docs/SEGURANCA.md` absorveram o conteúdo dele que ainda valia.
- A projeção para hardware grande (120 núcleos) em
  [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) foi extrapolada **a partir de
  medição**, não de suposição.

[Não publicado]: https://github.com/dioneyfroes-coder/micrologin/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dioneyfroes-coder/micrologin/releases/tag/v1.0.0
