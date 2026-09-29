# Métricas

Números medidos neste repositório, com o comando que os produziu. Vale como
evidência local; em produção os valores só se confirmam com medição no ambiente
alvo.

Data da medição: 2026-09-29.

> **As linhas de bcrypt abaixo são registro histórico**, medidas enquanto o
> bcrypt ainda era o algoritmo do serviço. Ele foi removido do projeto depois da
> decisão `D16` (laboratório, sem usuários antigos a preservar), então o script
> de benchmark hoje mede apenas argon2id. As linhas foram preservadas porque
> foram elas que embasaram a troca — sem elas, a decisão fica sendo opinião.
> Para reexecutar a comparação seria preciso instalar `bcrypt` à mão no
> ambiente de medição, já que ele não é mais dependência do projeto.

## 1. Custo de hashing de senha

Comando:

```bash
# no host, para iteração rápida
node scripts/benchmark-password-hash.mjs --iterations 20 --concurrency 1,2,4

# no orçamento real de produção: 2.0 CPU e 512 MB
docker run --rm --cpus 2.0 --memory 512m -v "$PWD/scripts:/bench:ro" node:22-alpine \
  sh -c 'cd /tmp && npm i @node-rs/argon2 --no-audit --no-fund --silent \
  && cp /bench/benchmark-password-hash.mjs /tmp/ \
  && node /tmp/benchmark-password-hash.mjs --iterations 20 --concurrency 1,2,4'
```

`pico RSS` é a marca d'água de RSS (`process.resourceUsage().maxRSS`) de um
processo separado que só executou aquele candidato, para 1 e para 4 logins
simultâneos. Medir no próprio processo do benchmark daria sempre ~0 MB: a
memória do argon2 já voltou ao pool quando o `await` termina.

### Dentro de 1 GiB / 2.0 CPU (teto atual de produção)

| candidato | hash p50 | verify p50 | login (verify+rehash) p95 | pico RSS x1 | pico RSS x4 |
| --- | --- | --- | --- | --- | --- |
| argon2id OWASP forte (m=46MiB, t=1, p=1) | 36.7 ms | 42.8 ms | 137.6 ms | 111 MB | 239 MB |
| argon2id OWASP mínimo (m=19MiB, t=2, p=1) | 22.9 ms | 24.7 ms | 48.9 ms | 86 MB | 145 MB |
| argon2id OWASP mínimo + pepper | 19.6 ms | 21.0 ms | 42.7 ms | 86 MB | 145 MB |
| argon2id OWASP econômico (m=12MiB, t=3, p=1) | 20.8 ms | 21.9 ms | 45.5 ms | 79 MB | 115 MB |
| argon2id 64MiB (m=64MiB, t=3, p=1) | 115.9 ms | 148.4 ms | 256.8 ms | 131 MB | 325 MB |
| argon2id 64MiB t=3 p=4 (roadmap) | 90.8 ms | 223.8 ms | 373.0 ms | 131 MB | 325 MB |

Login concorrente, dentro de 1 GiB / 2.0 CPU:

| candidato | c=1 p95 | c=4 p95 | logins/s em c=4 | logins/s em c=8 |
| --- | --- | --- | --- | --- |
| argon2id OWASP forte (m=46MiB, t=1, p=1) | 77.5 ms | 157.6 ms | 45 | 164 |
| argon2id OWASP mínimo (m=19MiB, t=2, p=1) | 49.7 ms | 35.6 ms | 137 | 271 |
| argon2id OWASP econômico (m=12MiB, t=3, p=1) | 48.0 ms | 39.9 ms | 133 | 260 |
| argon2id 64MiB (m=64MiB, t=3, p=1) | 297.2 ms | 203.1 ms | 23 | 47 |
| argon2id 64MiB t=3 p=4 (roadmap) | 305.0 ms | 315.0 ms | 18 | 41 |

**O que o teto maior mudou: nada no throughput.** O `m=64MiB` caberia folgado
em 1 GiB e continua pedindo 325 MB de pico e ~1/6 dos logins/s do mínimo OWASP.
A memória deixou de ser restrição sem virar bottleneck.

**O gargalo é CPU, e a conta bate.** Quando o serviço está limitado por CPU, o
teto de throughput é `núcleos ÷ tempo_por_hash`. Medido em 4 vCPU:

| candidato | p50 | `4 ÷ p50` (teórico) | medido em c=4 |
| --- | --- | --- | --- |
| m=19MiB, t=2, p=1 | 26.3 ms | 152/s | 100/s |
| m=46MiB, t=1, p=1 | 34.6 ms | 116/s | 92/s |
| m=64MiB, t=3, p=1 | 133.4 ms | 30/s | 29/s |
| m=64MiB, t=3, p=4 | 112.2 ms | 36/s | 20/s |

Onde a previsão bate com a medição, o limite é CPU. O caso do `p=4` é o mais
instrutivo: 4 threads por hash **não** são 4 CPUs extras, é o mesmo CPU
dividido — e por isso o `p=4` entrega 20/s contra 29/s do `p=1` no mesmo
parâmetro. Mais memória (4 GB em vez de 1) e mais CPU (4 vCPU em vez de 2) não
melhoram esse número.

### Antes: orçamento de 512 MB / 2.0 CPU (primeira medição)

| candidato | hash p50 | verify p50 | login (verify+rehash) p95 | pico RSS x1 | pico RSS x4 |
| --- | --- | --- | --- | --- | --- |
| bcrypt cost 12 (atual) | 365.7 ms | 326.8 ms | 772.8 ms | 65 MB | 63 MB |
| bcrypt cost 13 | 722.1 ms | 660.3 ms | 1477.2 ms | 64 MB | 64 MB |
| bcrypt 12 + pepper | 356.6 ms | 358.5 ms | 604.0 ms | 64 MB | 62 MB |
| argon2id OWASP forte (m=46MiB, t=1, p=1) | 31.4 ms | 25.6 ms | 94.0 ms | 114 MB | 208 MB |
| argon2id OWASP mínimo (m=19MiB, t=2, p=1) | 27.8 ms | 24.3 ms | 60.5 ms | 87 MB | 146 MB |
| argon2id OWASP mínimo + pepper | 26.2 ms | 26.0 ms | 51.7 ms | 87 MB | 146 MB |
| argon2id OWASP econômico (m=12MiB, t=3, p=1) | 24.7 ms | 25.6 ms | 74.3 ms | 80 MB | 119 MB |
| argon2id 64MiB (m=64MiB, t=3, p=1) | 133.4 ms | 127.0 ms | 302.5 ms | 132 MB | 326 MB |
| argon2id 64MiB t=3 p=4 (roadmap) | 75.0 ms | 85.4 ms | 313.8 ms | 133 MB | 326 MB |

Login concorrente (ms por requisição, do ponto de vista de quem pediu):

| candidato | c=1 p95 | c=2 p95 | c=4 p95 | logins/s em c=4 |
| --- | --- | --- | --- | --- |
| bcrypt cost 12 (atual) | 815.5 ms | 370.2 ms | 358.6 ms | 13 |
| bcrypt cost 13 | 1396.8 ms | 1056.8 ms | 620.0 ms | 7 |
| argon2id OWASP mínimo (m=19MiB, t=2, p=1) | 65.7 ms | 45.2 ms | 39.5 ms | 125 |
| argon2id 64MiB (m=64MiB, t=3, p=1) | 312.2 ms | 398.4 ms | 261.8 ms | 22 |

### Leitura

- **O bcrypt cost 12 de hoje é 13x mais caro que o mínimo da OWASP em argon2id**
  (365.7 ms contra 27.8 ms) no mesmo orçamento de CPU. Subir para cost 13
  custaria o dobro e deixaria 1.4 login/s por núcleo.
- **A proposta do roadmap (64 MiB) não é "mais forte que o atual" em CPU**: ela é
  2.7x mais barata que o bcrypt 12 de hoje. A justificativa dela é outra —
  memória, e memória é o que realmente incomoda quem quebra senha em GPU.
- **A memória é o gargalo real, não o tempo.** 4 logins simultâneos com 64 MiB
  dão 326 MB de pico: 64% do limite do container e acima do limiar de 200 MB que
  o próprio `/health` usa para marcar `warning` (`src/shared/utils/healthCheck.ts:94`).
  Com 19 MiB, o pico fica em 146 MB, dentro do orçamento mesmo com rajada.
- **p=4 não é ganho de segurança, é troca de CPU.** Dentro de 2.0 CPU, `p=4`
  derruba a latência de um hash (75 ms contra 133 ms) porque usa mais bandas de
  memória ao mesmo tempo, mas passa a consumir 4 threads por requisição: com
  dois logins simultâneos, um hash já ocupa o container inteiro. Os autores do
  Argon2 e o guideline da OWASP pedem `p=1` em servidor.
- **Pepper não tem custo mensurável** (26.2 ms contra 27.8 ms; no bcrypt,
  diferença menor que a variação entre execuções). Ou seja: a discussão sobre
  pepper não é de desempenho, é de operação — ver `D17` em `docs/SEGURANCA.md`.

### Ruído e reprodutibilidade

O host da medição é um notebook com 4 vCPU, e a mesma amostra de bcrypt 12
variou entre 264 ms e 366 ms de p50 entre execuções. Os números acima são de uma
execução por ambiente, com 20 iterações por amostra após 3 de aquecimento. Para
comparar candidatos, o que importa é a ordem de grandeza e a razão entre
candidatos dentro da mesma execução, não o decimal.

## 2. Autenticação sob carga

`k6` não está instalado neste ambiente, então o p95 de `/login` é medido com
`node` e `fetch`, contra o stack real (`docker-compose.prod.yml`, 2.0 CPU,
1 GiB, 4 workers):

```bash
# o limitador de /login de produção é 5 req/15 min, então a medição sobe o
# orçamento. Sem isso a própria medição toma 429 e mede o limiter, não o login.
# O limite de IP também precisa subir: em c=8 o limite por IP (100/min) corta a
# medição antes do limite por login. Ambos voltam ao valor normal depois — e
# as chaves de rate limit no Redis são apagadas, senão o orçamento inflado
# continua valendo e o próximo teste mede 429.
cp .env.prod /tmp/env.prod.bak
printf 'RATE_LIMIT_PROD_LOGIN_POINTS=100000\nRATE_LIMIT_PROD_LOGIN_DURATION=60\n\
RATE_LIMIT_PROD_LOGIN_BLOCK_DURATION=1\nRATE_LIMIT_PROD_IP_POINTS=100000\n\
RATE_LIMIT_PROD_IP_DURATION=60\n' >> .env.prod
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate auth-service

node scripts/measure-login-latency.mjs --url http://localhost:3100 \
  --user mede_bench --password "$SENHA" --requests 25 --concurrency 1,4,8

# devolve o orçamento de rate limit
cp /tmp/env.prod.bak .env.prod
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate auth-service
docker exec redis-prod redis-cli -n 1 --scan --pattern 'rl_*' \
  | xargs -r -n1 docker exec redis-prod redis-cli -n 1 DEL
```

Credenciais válidas, 25 logins por nível, 1 de aquecimento. O tempo é medido do
lado de quem pediu, e o token emitido a cada resposta é descartado.

| `/login` | p50 | p95 | max | logins/s |
| --- | --- | --- | --- | --- |
| **bcrypt 12 (antes)** c=1 | 393.0 ms | 491.0 ms | 519.5 ms | 2.5 |
| **bcrypt 12 (antes)** c=4 | 717.8 ms | 1601.3 ms | 1692.7 ms | 4.7 |
| **bcrypt 12 (antes)** c=8 | 1207.0 ms | 1867.6 ms | 1868.5 ms | 5.8 |
| **argon2id 19MiB (depois)** c=1 | 32.9 ms | 45.4 ms | 53.1 ms | 29.1 |
| **argon2id 19MiB (depois)** c=4 | 82.8 ms | 115.6 ms | 117.9 ms | 46.4 |
| **argon2id 19MiB (depois)** c=8 | 147.7 ms | 191.0 ms | 255.0 ms | 49.2 |

O p95 de `/login` caiu de 491 ms para 45.4 ms em c=1, e o serviço passou de
2.5 para 29.1 logins/s. A fila é o que mais dobra: em c=8, a latência por
requisição caiu de 1868 ms para 191 ms, porque o hash deixou de ocupar um núcleo
por 365 ms.

A reescrita aconteceu no mesmo teste: o hash de `mede_bench` estava em bcrypt
antes da primeira requisição e já estava em `$argon2id$v=19$m=19456,t=2,p=1$`
depois, com `passwordHistory` vazio — o login reescreveu sem trocar a senha do
usuário. Foi a única vez que a base teve material bcrypt: o algoritmo foi removido
em seguida, e hoje o `compare` entende apenas argon2id.

### Remedição no teto de 1 GiB

Mesma medição, mesmo script, depois de subir o `mem_limit` de 512 MB para 1 GiB:

| `/login` (argon2id 19MiB) | p50 | p95 | max | logins/s |
| --- | --- | --- | --- | --- |
| c=1 | 44.1 ms | 61.8 ms | 75.9 ms | 22.1 |
| c=4 | 112.0 ms | 219.8 ms | 241.1 ms | 32.8 |
| c=8 | 215.3 ms | 305.1 ms | 355.4 ms | 33.3 |

Subir a memória **piorou** os números do `/login` (c=1: 45.4 ms → 61.8 ms de
p95). Não é o hash ficando mais lento — os parâmetros são os mesmos, e o
benchmark isolado mediu 22.9 ms de p50 para `m=19MiB` no teto novo contra 27.8 ms
no antigo. É a CPU da máquina, que agora divide 4 vCPU com o resto do que roda
nela (Mongo, Redis, Portainer, outro projeto), enquanto a primeira medição teve
CPU mais livre. **Em servidor compartilhado o número que decide é o do endpoint,
não o do benchmark isolado** — e o endpoint diz que o teto de memória não era o
que limitava o login.

Consumo do container: 112 MB de RSS em repouso, ~200 MB no pico medido com 8
logins simultâneos, contra o limite de 1 GiB.

### Limite de 4 workers

Com 4 workers e 2.0 CPU, o custo por hash continua sendo o gargalo, mas em
c=1 o serviço entrega ~22 logins/s: o `/login` deixou de ser o caminho crítico
e a próxima temporada de latência deve ser medida em outro lugar (Mongo,
Redis, TLS). K6 continua sendo a ferramenta certa para isso; o script de
medição cobre o caso de um acesso pontual e reproduzível.
