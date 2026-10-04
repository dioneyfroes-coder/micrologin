# Redis: o que se perde, o que não se perde, e por quê

> Fase 2.2 do roadmap. O Mongo é a fonte de verdade e se restaura de um dump
> (`docs/BACKUP.md`); o Redis guarda o estado que decide **quem ainda pode
> entrar**. Este documento diz o que cada um garante, medido, e onde está o
> limite declarado.

## A falha que esta fase fecha

Até a 2.2, o Redis de produção rodava com `--save "" --appendonly no` — sem
persistência, por decisão consciente: o comentário no compose dizia que "cache e
blacklist são reconstruíveis".

A blacklist não é reconstruível. Ela é o registro do que **não** pode mais entrar
no serviço, e esse registro não se reconstrói sozinho: o logout aconteceu, o
usador foi avisado, e nada no sistema pode provar que aquilo aconteceu de novo.

O efeito é silencioso. Um restart de container apaga a blacklist, a versão de
sessão e o carimbo `user_tokens_revoked`, e os tokens revogados **voltam a valer**
até o expirar — sem erro, sem 5xx, sem nada no log que indique falha.

Medido, no stack de teste, com o mesmo caminho que o drill usa:

| passo | token revogado | token de controle (nunca revogado) |
| --- | --- | --- |
| depois do `/logout` | 401 | 200 |
| depois do restart do Redis **sem persistência** | **200** | 200 |
| depois do restart do Redis **com persistência** | **401** | 200 |

A linha do meio é o buraco: 401 → 200 sem nenhuma requisição mal-intencionada no
meio. O cliente que recebeu o "logout realizado com sucesso" volta a ter uma
sessão válida.

E o fail-closed não cobre. `SESSION_FAIL_OPEN` (default `false` em produção)
trata o Redis **fora do ar**: sem armazenamento de revogação disponível, o
serviço nega. O caso do Redis de pé com memória vazia é outro — o servidor
responde `PONG`, o middleware autentica, e a blacklist que deveria estar lá não
está. `docs/SEGURANCA.md` (D20) registra essa distinção.

## O que o Redis guarda, e o que cada chave custa perder

| chave | escrita por | quem depende | perder significa |
| --- | --- | --- | --- |
| `token_blacklist:jti:<jti>` | `revokeToken` (logout, logout-all) | verificação de token | o token específico volta a valer até expirar (access 15min, refresh 7d) |
| `user_session_version:<id>` | `revokeUserTokens` (INCR) | claim `sv` dos tokens | tokens antigos nascidos com `sv` antigo voltam a valer |
| `user_tokens_revoked:<id>` | `revokeUserTokens` (timestamp) | tokens antigos sem `sv` | idem, para tokens emitidos antes da claim existir |
| `token_blacklist:*` com `rotated` | `rotateRefreshToken` (SET NX) | reuso de refresh | um refresh já rotacionado pode ser reapresentado |
| contadores de rate limit | `advancedRateLimit` | proteção de login | janela de tentativas se reabre |

O TTL das três primeiras é o prazo natural de exposição: access 15min, refresh
7d, revogação em massa 7d. A persistência não muda esse teto — muda o que
acontece **antes** dele.

## A configuração

`docker-compose.prod.yml`, serviço `redis`:

```yaml
command: >-
  redis-server --aclfile /etc/redis/users.acl
  --appendonly yes --appendfsync everysec
  --save 60 1
volumes:
  - redis_data:/data
```

Três decisões, cada uma com seu porquê:

- **AOF `everysec`** — o Redis agrupa escritas e faz `fsync` no máximo 1s depois.
  É a garantia de que uma revogação confirmada não se perde num `SIGKILL`. O
  custo é um `fsync` por segundo, sobre um dataset pequeno.
- **snapshot RDB a cada 60s** — o AOF é reescrito do zero a cada 60s pelo Redis;
  um snapshot periódico é a rede de segurança se o arquivo de AOF se corromper.
  Não é a garantia primária: por isso `everysec` e não `always` (que faz
  `fsync` por operação e custa latência).
- **`/data` em volume nomeado** — dado no diretório efêmero do container morre
  com o container. Sem o volume, os dois flags acima seriam decorativos.

O que **não** mudou: a ACL por arquivo (`user default off`, `+@all -@admin
-@dangerous`). `--requirepass` continua fora de propósito, pela mesma razão da
1.4 — senha em `docker inspect` e `ps`, e amarrada a um usuário que ninguém é.

O stack de resiliência (`docker-compose.resilience.yml`) segue **sem**
persistência, de propósito: `scripts/infra-resilience-test.sh` reinicia o Redis
querendo medir o tempo de recuperação, e um volume ali mudaria o que ele mede.
`tests/unit/redis-persistence-config.test.ts` trava essa assimetria dos dois
lados, para ninguém "harmonizar" um stack no outro.

## RPO e RTO, medidos

| | Mongo | Redis |
| --- | --- | --- |
| papel | fonte de verdade (usuários) | estado de sessão e revogação |
| backup | `scripts/backup.sh`, cifrado gpg AES-256 (`docs/BACKUP.md`) | **não há** — ver abaixo |
| RPO | 24h por padrão (`--rpo-hours`), ajustável | **~1s** de escrita, 0 no restart |
| RTO de restauração | ~1s medido (drill da 2.1) | 0,5–0,6s medido (container → `PONG`) |
| o que acontece se perder | restore do dump; logins falham até acabar | tokens revogados valem de novo até expirar |

O RTO do Redis não é o número importante aqui: ele é rápido porque o restart
não é o evento. O evento é perder o volume, e esse caso não tem RTO — o serviço
volta, o volume não.

## Por que não há backup do Redis (e por que isso é uma decisão, não uma omissão)

Tentador seria: `BGSAVE`, copiar o `dump.rdb`, listo. O problema é que um restore
de Redis **restauraria o passado errado**: as chaves de revogação que existiam
naquele dump podem ser anteriores a revogações mais novas, e as entradas de
blacklist cujo TTL já venceu voltariam como "revogado" para tokens que já
expiraram — ou pior, o dump traria de volta um contador de versão de sessão
antigo, e tokens revogados depois do dump passariam a parecer válidos.

A propriedade que salva o caso é outra: **o Redis é regenerável por design**. Um
usuário que precisa voltar ao serviço faz login novo. O que não se regenera é o
Mongo — por isso ele tem backup, e o Redis não.

O que a persistência protege é o intervalo entre o logout e o próximo login: sem
ela, um cliente que recebeu confirmação de logout fica autenticado sem fazer
nada. Com ela, a revogação vale até o token expirar, como deveria.

Para **diagnóstico forense** (investigar um abuso, reconstruir quem estava
revogado em certo dia), aí sim o dump pontual serve — e é para isso que se deve
tirar, com data e retenção próprias, nunca para restore de serviço. A
recomendação é `redis-cli --rdb` ou `BGSAVE` sob demanda, guardado fora do
`serviço`, com a ressalva de que ele descreve um instante, não um estado
recuperável.

## Fail-open? Não — e o limite que a D20 registra como aceito

O fail-closed quando o Redis está indisponível é decisão antiga e mantida: sem
armazenamento de revogação não há como garantir que um token não foi revogado, e
"disponível aceitando sessão revogada" não é uma propriedade aceitável num
serviço de autenticação. O serviço responde **503**, não 401 — dizer "senha
errada" seria mentira.

O que fica **registrado e aceito como limite** (D20): se o volume do Redis for
destruído (falha de disco, `docker volume rm`, restauração de VM a partir de
snapshot antigo), o serviço volta **sem histórico de revogação** e opera em
fail-open de fato — não por escolha, mas por ausência do dado. O que fecha essa
lacuna de verdade é tirar a revogação do caminho de um único nó: ou um segundo
Redis com réplica e promote manual, ou persistir o carimbo de revogação também no
Mongo, que já é a fonte de verdade e já tem backup. Nenhuma das duas foi escolhida, e ambas mudam
o modelo de operação — por isso foram decisão, não detalhe de implementação.
A P11 optou por aceitar o limite como tal, e o custo foi medido em vez de
descrito: com o volume destruído e o Mongo intacto, o token de access revogado
volta a valer por ~15 min e o **refresh já consumido volta a valer e renova
access tokens durante 7 dias** (`npm run test:redis:volume-loss`), sem nenhum
erro no log. Ou seja: a janela real é a do refresh, porque a detecção de reuso
morre no mesmo volume.

Até lá, o operador tem dois drills: `npm run test:redis` prova, no ambiente de
teste, que a revogação sobrevive ao **restart**, e `npm run test:redis:volume-loss`
prova que a perda de **volume** expõe o serviço — e mede a janela. Rodar os dois
depois de qualquer mudança no compose do Redis é o mais barato que existe para
descobrir que alguém desligou a persistência, e para confirmar que o limite
aceito continua sendo o limite aceito.

### O que não fazer

**Nunca `docker compose -f docker-compose.prod.yml down -v` em produção.** O `-v`
apaga os volumes nomeados, e o do Redis é justamente onde mora a revogação: o
serviço volta de pé respondendo e sem nenhum histórico de revogação — o cenário
que a D20 deixa aberto, provocado por um comando de limpeza. Para reiniciar o
Redis, `docker compose restart redis` ou `up -d` sem o `-v`; para limpar o
ambiente de desenvolvimento, `make docker-clean` (que usa o compose de dev).

O mesmo vale para snapshot de VM: uma reposição a partir de um snapshot antigo
volta o `redis_data` junto com o resto, e a revogação do período mais recente
some. É o motivo de a decisão ser sobre *onde* a revogação mora, e não sobre
como ela é escrita.

## Como rodar

```bash
npm run test:redis        # drill completo: stack próprio, derruba o Redis, teardown
npm run test:redis -- --keep --skip-build   # deixa o stack de pé para docker logs
```

O drill (`scripts/test-redis-persistence.sh`):

1. sobe o stack próprio (`docker-compose.redis.yml`, porta 3301) com chaves e
   credenciais efêmeras, em produção (`NODE_ENV=production`);
2. confere, por fora do Redis, que `/data` é volume nomeado e que
   `/data/appendonlydir` existe — a ACL da aplicação nega `CONFIG` e `INFO`
   (ambos em `@admin`), então a config é conferida no sistema de arquivos;
3. registra dois usuários e autentica: **A** (será revogado) e **B**
   (controle, nunca revogado);
4. revoga a sessão de A por `/logout` e confirma 401;
5. confere no volume que a escrita foi mesmo para o AOF (o `.incr.aof` cresce);
6. reinicia o container do Redis e espera `PONG`;
7. exige **B em 200** (o Redis voltou e valida tokens de verdade) e **A em 401**
   (a blacklist sobreviveu);
8. confere que `user_session_version:<id>` tem o mesmo valor antes e depois.

O passo 7 é o que dá sentido ao teste: sem o controle, "401 depois do restart"
seria ambíguo — daria para o fail-closed estar barrando tudo por
indisponibilidade e o teste passaria por acidente.

O portão de CI sobre a configuração é
`tests/unit/redis-persistence-config.test.ts` (9 casos, sem docker): ele
lê o YAML dos três composes e falha se a persistência do prod for desligada, se
o drill divergir do prod, ou se o stack de resiliência passar a persistir.
