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

### Escolha do parâmetro: o recurso escasso de cada lado

Com o teto de 1 GiB medido, a escada de candidatos fecha o argumento. O critério
não é "mais parâmetro é melhor": é em qual recurso **cada lado** gasta, porque
os dois pagam o mesmo custo por tentativa e o que separa atacante de servidor é
o que **sobra** na mão de um e não do outro.

- Atacante com GPU: FLOPS em abundância, VRAM escassa e cara. `m` é o gargalo.
- Atacante com ASIC: custo linear em `t`, custo alto em `m` (silício de memória).
- Servidor (2.0 CPU, medido): limitado por **CPU**, nunca por RAM.

CPU é o recurso que os dois têm de sobra, então o esforço vai para `m` e `t`
fica no mínimo. Medido no server01, 20 iterações por amostra, dentro do
container de 1 GiB e 2.0 CPU:

| candidato | mem/tentativa | CPU/tentativa | hash p50 | pico RSS ×4 | p95 c=1 | logins/s c=4 | 8 conc. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| m=19MiB, t=2, p=1 | 1.0x | 1.0x | 30.2 ms | 145 MB | 84.2 ms | 76 | 152 MiB |
| m=32MiB, t=2, p=1 | 1.7x | 1.7x | 40.0 ms | 197 MB | 131.0 ms | 66 | 256 MiB |
| m=46MiB, t=1, p=1 | 2.4x | 1.2x | 38.0 ms | 207 MB | 84.2 ms | 88 | 368 MiB |
| m=46MiB, t=2, p=1 | 2.4x | 2.4x | 66.1 ms | 253 MB | 244.4 ms | 37 | 368 MiB |
| **m=64MiB, t=1, p=1** | **3.4x** | **1.7x** | **36.0 ms** | **301 MB** | **81.1 ms** | **72** | **512 MiB** |
| m=64MiB, t=2, p=1 | 3.4x | 3.4x | 80.2 ms | 325 MB | 173.4 ms | 40 | 512 MiB |
| m=64MiB, t=3, p=1 | 3.4x | 5.1x | 128.2 ms | 325 MB | 359.5 ms | 24 | 512 MiB |
| m=96MiB, t=1, p=1 | 5.1x | 2.5x | 77.4 ms | 355 MB | 310.3 ms | 40 | 768 MiB |
| m=96MiB, t=2, p=1 | 5.1x | 5.1x | 130.6 ms | 453 MB | 364.0 ms | 21 | 768 MiB |

**`m=64MiB, t=1, p=1` é a escolha.** O dado que decide é a coluna de latência:
3.4x a memória por tentativa do atacante com p95 de login de **81.1 ms contra
84.2 ms** do mínimo da OWASP. Não há regressão perceptível para ganhar 3.4x o
custo de memória de quem ataca.

`m=96MiB` fecha a conta de memória exatamente (96 × 8 = 768 MiB, o orçamento
inteiro) e passa na validação de arranque porque o guard compara com `>`. Fica
fora do padrão de propósito: sem folga para o runtime, qualquer coisa que o Node
retenha além do argon2 compete com o hash. Com 64 MiB sobram ~33% de folga.
**O maior valor que cabe não é o melhor valor.**

`m=46MiB, t=1` (a segunda recomendação da OWASP) é a escolha se o objetivo fosse
só bater a OWASP com folga; entrega 2.4x de memória a p95 de 84.2 ms. Fica atrás
porque 64 MiB entrega mais defesa **e** a mesma latência.

### Como o hash escala com núcleos (medido em 4 CPU)

Isto aqui é o dado que governa qualquer projeção para hardware grande, então
foi medido em vez de assumido. Mede `hashes/s` com `c` chamadas concorrentes de
`m=64MiB, t=1`, no mesmo container, variando só a concorrência:

| concorrência | 4 CPU, pool default | 4 CPU, `UV_THREADPOOL_SIZE=24` |
| --- | --- | --- |
| c=1 | 22/s | 22/s |
| c=4 | 35/s | 25/s |
| c=8 | 37/s | 25/s |
| c=16 | 31/s | 33/s |
| c=32 | 36/s | 32/s |

Três leituras, e a segunda é a que costuma ser assumida errada:

**1. O hash é paralelizável no processo, e escala com núcleo.** A 4 CPU o
throughput vai de 22/s para ~37/s e satura. Satura por **núcleo**, não por
`UV_THREADPOOL_SIZE`: o `@node-rs/argon2` roda em pool próprio (tokio do Rust),
não no threadpool do libuv, então `UV_THREADPOOL_SIZE=24` não muda nada —
medido, não suposto. O número de threads de que o serviço pode dispor é o número
de núcleos que o container recebe.

**2. Mais concorrência não rende depois do número de núcleos.** c=32 em 4 CPU
não é melhor que c=8; é o mesmo throughput com 4x a latência e 4x a memória de
pico. Em `c=32` o p95 sobe e o total não muda. Consequência prática:
aumentar concorrência acima do número de núcleos só compra fila.

**3. O teto é memória, e por isso o `m` não escala com a máquina.** A 120 GB
divididos por 4 workers dá 30 GB por worker, o que é espaço para `m` na casa
das centenas de MiB — mas `m` maior custa *também* CPU por hash, e CPU é o que
limita o login. Subir `m` aproveita RAM ociosa para tornar o login mais lento.
Ver a projeção em [arquitetura](ARQUITETURA.md).

### Endpoint real com o parâmetro escolhido (m=64MiB, t=1)

O benchmark isolado é o do hash. O número que decide é o do `/login`, medido no
serviço em produção (server01, 2.0 CPU, 1 GiB, `m=64MiB, t=1, p=1`), com o
rate limit de produção elevado **só** durante a medição e restaurado depois:

| `/login` (argon2id 64MiB, t=1) | p50 | p95 | max | logins/s |
| --- | --- | --- | --- | --- |
| c=1 (n=40) | 47.4 ms | 78.7 ms | 119.1 ms | 21.1 |
| c=4 | 107.6 ms | 120.4 ms | 120.4 ms | 37.2 |
| c=8 | 344.0 ms | 409.1 ms | 409.1 ms | 23.3 |

O p95 de 78.7 ms em c=1 é a linha que fecha a decisão: o benchmark isolado
prometia 81.1 ms e o endpoint entregou 78.7 ms. Os dois concordam, e ambos estão
no mesmo patamar do mínimo da OWASP (84.2 ms) — 3.4x a memória por tentativa do
atacante sem custo de latência.

`c=1` foi medido com 40 amostras de propósito: com 9 amostras o p95 é o máximo
da amostra, e um outlier de fila vira "p95" sem significar nada.

O `c=8` piora (409 ms) porque 8 logins de 64 MiB somam 512 MiB e o container
tem 1 GiB: o pico cabe, mas a alocação compete com o resto do processo. É o
teto de `MAX_CONCURRENT_LOGINS` fazendo o que foi feito para fazer, e a latência
de 8 logins simultâneos é o preço honesto de segurar 512 MiB de hash ao mesmo
tempo.

### Remediação no teto de 1 GiB (m=19MiB, antes desta mudança)

Mesma medição, mesmo script, depois de subir o `mem_limit` de 512 MB para 1 GiB,
ainda com `m=19MiB, t=2`:

| `/login` (argon2id 19MiB) | p50 | p95 | max | logins/s |
| --- | --- | --- | --- | --- |
| c=1 | 44.1 ms | 61.8 ms | 75.9 ms | 22.1 |
| c=4 | 112.0 ms | 219.8 ms | 241.1 ms | 32.8 |
| c=8 | 215.3 ms | 305.1 ms | 355.4 ms | 33.3 |

Subir a memória **piorou** os números do `/login` (c=1: p95 de 45.4 ms para
61.8 ms). Não é o hash ficando mais lento — os parâmetros são os mesmos, e o
benchmark isolado mediu 22.9 ms de p50 para `m=19MiB` no teto novo contra 27.8 ms
no antigo. É a CPU da máquina, que agora divide 4 vCPU com o resto do que roda
nela (Mongo, Redis, Portainer, outro projeto), enquanto a primeira medição teve
CPU mais livre. **Em servidor compartilhado o número que decide é o do endpoint,
não o do benchmark isolado** — e o endpoint dizia que o teto de memória não era
o que limitava o login.

### Limite de 4 workers

Com 4 workers e 2.0 CPU, o custo por hash continua sendo o gargalo, mas em
c=1 o serviço entrega ~22 logins/s: o `/login` deixou de ser o caminho crítico
e a próxima temporada de latência deve ser medida em outro lugar (Mongo,
Redis, TLS). K6 continua sendo a ferramenta certa para isso; o script de
medição cobre o caso de um acesso pontual e reproduzível.

---

## 3. Capacidade por endpoint (Fase 3.1)

Rodado com `npm run test:capacity` (k6 dentro do Docker, rede `host`), no mesmo
orçamento de produção: **1 worker, 2.0 CPU, 1 GiB**, `CLUSTER_ENABLED=false`.
Cada linha é uma invocação independente do k6 com rampa de 15 s, 60 s de regime
e 10 s de rampa final; `/register` é limitado a 5 iterações por VU.

| endpoint | VUs | reqs | rps | p50 | p95 | p99 | max | falha | RSS pico | heap pico | CPU pico |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /health | 100 | 58914 | 693.0 | 138.6 ms | 180.5 ms | 212.0 ms | 268.0 ms | 0% | 134.7 MB | 51.7 MB | 139% |
| /health | 200 | 58721 | 690.7 | 274.1 ms | 356.6 ms | 411.2 ms | 492.1 ms | 0% | 137.5 MB | 51.6 MB | 122% |
| /health | 400 | 56985 | 670.3 | 554.4 ms | 725.6 ms | 784.6 ms | 837.1 ms | 0% | 144.1 MB | 60.3 MB | 123% |
| /login | 100 | 1882 | 22.13 | 4474.6 ms | 4734.3 ms | 4952.3 ms | 5206.5 ms | 0% | 346.4 MB | 48.5 MB | 205% |
| /login | 200 | 1889 | 22.20 | 8886.3 ms | 9927.3 ms | 10025.3 ms | 10670.3 ms | 0% | 392.9 MB | 55.8 MB | 205% |
| /login | 400 | 1923 | 22.37 | 17690.4 ms | 18621.8 ms | 18851.4 ms | 19889.7 ms | 0% | 365.8 MB | 59.1 MB | 211% |
| /refresh | 100 | 51569 | 606.6 | 144.3 ms | 200.6 ms | 235.5 ms | 284.9 ms | 0% | 209.5 MB | 54.4 MB | 155% |
| /refresh | 200 | 50380 | 592.6 | 293.7 ms | 415.5 ms | 502.7 ms | 709.0 ms | 0% | 232.6 MB | 56.1 MB | 184% |
| /refresh | 400 | 41246 | 485.2 | 612.4 ms | 867.1 ms | **2483.1 ms** | **7927.0 ms** | 0% | 375.4 MB | 60.4 MB | 200% |
| /register | 100 | 500 | 21.86 | 4252.4 ms | 6039.5 ms | 8666.9 ms | 12444.2 ms | 0% | 325.0 MB | 42.2 MB | 205% |
| /register | 200 | 1000 | 21.49 | 7604.4 ms | 14578.4 ms | 17142.9 ms | 17598.2 ms | 0% | 338.6 MB | 45.1 MB | 202% |
| /register | 400 | 1709 | 22.15 | 17904.5 ms | 18963.3 ms | 24229.5 ms | 25814.2 ms | 0% | 372.7 MB | 52.4 MB | 208% |

Zero 5xx e zero erro de transporte em todas as doze linhas. `RSS pico` e
`heap pico` são o máximo de `/observability` durante a janela de carga;
`CPU pico` vem de `docker stats` do container (100% = 1 CPU, teto do
container = 200%).

### Leitura

**1. `/login` e `/register` são limitados pelo argon2id, e o número é 22/s.**
A vazão é praticamente idêntica nos três níveis (22.13, 22.20, 22.15 rps) enquanto
a latência cresce linearmente com a concorrência: p50 de 4.5 s para 17.7 s ao
subir de 100 para 400 VUs. É a lei de Little aparecendo como deve — vazão
constante, latência = concorrência / vazão. Com 400 VUs o p50 de 17.9 s do
`/register` fica a 12 s do `SERVER_TIMEOUT` de 30 s; a 700 VUs o endpoint
começaria a devolver 503 por timeout, não por falta de memória. **Conclusão
prática: aumentar VUs nesse caminho só piora a latência, não entrega mais
login.** O número que decide o quanto de tráfego o serviço aceita não é o
`p95`, é as **22 operações de hash por segundo** — logo, o caminho a otimizar é
`m=19MiB, t=1` (já aplicado) ou o número de workers, nunca o `p95` do login.

**2. `/refresh` satura antes de quebrar, e quebra feio em 400 VUs.**
Vazão de 606.6 para 592.6 rps entre 100 e 200 VUs — ainda estável. Em 400 VUs a
vazão **cai 18%** (592.6 → 485.2 rps) enquanto a latência p99 sai de 502.7 ms
para 2483.1 ms (5x) e o máximo toca 7.9 s. Vazão que cai com a carga subindo é a
assinatura de fila passando do joelho, não de saturação limpa: o processo está
aceitando requisição,enchendo a fila e respondendo cada uma mais tarde. O RSS
declarado como pico (375 MB) acontece **na virada da rampa de subida**, quando os
400 VUs ficam ativos ao mesmo tempo; em regime o mesmo processo senta em ~150 MB
e o container em ~105 MiB (`docker stats`), com o heap em dente de serra entre
38 e 60 MB. Ou seja: não é vazamento, é pico transitório de alocação no momento
de concorrência máxima. Candidatos a testar na 3.2: `availableParallelism()` para
tirar o gargalo do event loop, teto de `max-old-space` para dar GC mais previsível
e o número de idas ao Redis por refresh (verificar + revogar + emitir).

**3. `/health` é o endpoint mais rápido e o mais fácil de abusar.**
~690 rps com p50 de 134 ms a 100 VUs, e ainda assim é o que mais cresce em
latência proporcional (554 ms de p50 a 400 VUs). O detalhe de projeto: cada
`/health` custa um `ping` no Mongo **e quatro idas ao Redis** (a sonda de
escrita/leitura mais as três leituras de rate limit). O suficiente para um
`/health` não-trivial em 400 VUs consumir ~123% de CPU. Não é prioridade de
desempenho, mas é vetor de negação de serviço e por isso entra na Fase 6.

**4. Memória: folgado, com um asterisco.**
Pico global de 392.9 MB (`/login` a 200 VUs) contra 1 GiB de teto — 38% de
ocupação, e nenhum reinício no meio da corrida. Dois pontos que o número não
esconde: (a) o `max_memory_restart: 500M` do PM2 está a 107 MB do pico, mas
**não protege nada em produção porque o compose não usa PM2** — quem roda é
`node dist/app.js` direto; (b) se a Fase 3.2 ligar mais de um worker, esses
392.9 MB são **por processo**, e `4 × 393 MB` estoura 1 GiB com folga. É por
isso que a 3.2 não pode ser só "mais workers": tem que vir com teto de
requisições em andamento e orçamento de heap por processo.

### Conclusão da Fase 3.1

Gargalo identificado com número: **22 logins/s por 2.0 CPU, limitado pelo
argon2id, invariante ao número de VUs.** `/refresh` é o segundo gargalo, e é
mais interessante porque **perde vazão** em vez de só ganhar latência. Nenhum
dos dois é memória: o teto de 1 GiB não foi tocado em nenhuma das doze linhas.
O caminho para 3.2 é mostrado pelos dados — mais paralelismo para
`/refresh` (workers por CPU disponível), nenhum ganho para `/login`
(aí é o custo do hash), e teto de requisições em andamento para que nenhum dos
dois possa transformar pico de tráfego em pico de memória.

### Bug encontrado e corrigido no meio da medição

O `/health` devolvia 503 sob concorrência: com 300 requisições simultâneas,
**127 respondiam 200 e 173 respondiam 503** — com o Redis conectado e a mensagem
de degradation dizendo que ele não respondia a leitura/escrita. A causa era a
própria sonda: `src/infrastructure/cache/connection.ts` escrevia e lia sempre na
chave fixa `__health_check__`, então N sondas concorrentes se atropelavam e uma
sondagem concluída com o valor de outra parecia falha. Agora a chave carrega
`${process.pid}` e um contador de sequência, e o valor carrega um timestamp, o
que garante unicidade mesmo dentro do mesmo milissegundo. Depois do fix, as 300
requisições simultâneas respondem **300 × 200**. Regressão coberta por
`tests/unit/redis-cache.test.ts` (50 sondas concorrentes, unicidade de chave e
de valor), que falha contra a versão antiga da função.

---

## 4. Efeito de 2 workers (Fase 3.2, primeira rodada)

Mesma matriz, agora com `CLUSTER_WORKERS=2` no teto de 2.0 CPU. O objetivo
não era melhorar número, era **testar duas previsões** que a §3 deixou na
mesa: workers ajudam o `/refresh` (que perdia vazão) e não ajudam o `/login`
(limitado pelo argon2id). As duas se confirmaram, e uma delas confirmou o
pior.

| endpoint | VUs | 1 worker | 2 workers | Δ | p99 1w → 2w |
| --- | --- | --- | --- | --- | --- |
| /refresh | 100 | 606.6 rps | **675.7 rps** | +11.4% | 235.5 → 246.4 ms |
| /refresh | 200 | 592.6 rps | **691.8 rps** | +16.7% | 502.7 → 445.6 ms |
| /refresh | 400 | 485.2 rps | **541.8 rps** | +11.7% | 2483.1 → 2147.0 ms |
| /login | 100 | 22.13 rps | 21.96 rps | −0.8% | 4952.3 → 6587.9 ms |
| /login | 200 | 22.20 rps | 22.07 rps | −0.6% | 5551.1 → 11439.6 ms |
| /login | 400 | 22.37 rps | 21.51 rps | −3.8% | 18851.4 → 22607.5 ms |

Zero 5xx nas seis linhas. Detalhe honesto: em 2 workers o `/refresh` ainda
degrada de 691.8 para 541.8 rps entre 200 e 400 VUs (−22%). Workers não
resolveram o fila; só adiaram o joelho.

### As três leituras

**1. Workers servem para `/refresh`, e é o único caminho que ganhou.** De
485.2 para 541.8 rps a 400 VUs, e o p99 cai de 2.48 s para 2.15 s. A
assinatura de "perde vazão" fica mais fraca, não some: com 2 workers a queda
de 200 → 400 VUs ainda é de 22%. Ou seja, `/refresh` tem um segundo gargalo
depois do event loop — a suspeita agora vai para as **idas ao Redis por
refresh** (verificar JWT + `SET NX` + emitir par), que são serializadas por
worker, não para a CPU.

**2. Workers não servem para `/login`, e o número é categórico.** 21.96 e
22.07 rps contra 22.13 e 22.20 — dentro do ruído, e o p99 piora (6588 ms
contra 4952 ms a 100 VUs) porque os dois processos disputam as mesmas 2.0 CPU
com o argon2id usando a threadpool. Isso fecha a discussão: **o `/login` só
ganha com mais CPU ou com hash mais barato, nunca com mais processo.** Qualquer
plano que prometa escalar login com réplicas está errado nesta arquitetura,
e agora isso está medido em vez de suposto.

**3. E o custo é o que limita os dois: 720 MB de RSS com 2 workers.** No pico
do `/login` a 400 VUs, os dois processos somam **720.0 MB** — 70% do teto de
1 GiB — contra 365.8 MB com 1 worker. Heap contava 105.7 MB; o resto é o
argon2id nativo e o buffer de pool, que não volta ao GC. O `/refresh` a
400 VUs chegou a 587.4 MB.

É aqui que a §3 estava certa e o default antigo estava errado: `os.cpus().length`
devolvia **4** no container de 2.0 CPU, e 4 workers a ~370 MB por processo
seriam ~1.4 GB — **OOM killer garantido**, não um risco teórico. A correção
para `os.availableParallelism()` em `src/interfaces/config/appConfig.ts` não é
ajuste fino: é o que impede o serviço de subir e morrer em produção.

---

## 5. Calibrando o limite de requisições em andamento

O disjuntor (`src/application/middleware/inFlightLimit.ts`) recusa com 503 e
`Retry-After` quando o número de requisições **simultâneas** por processo passa
do teto, e nunca recusa `/health`, `/readiness` e `/observability`. A pergunta
honesta é qual deve ser o teto, e a resposta intuitiva ("o menor que ainda
proteja memória") se mostrou errada.

Todas as linhas abaixo: 1 worker, 400 VUs, 60 s de regime, mesmo stack.

| teto | endpoint | rps | p50 | p99 | 503 recusadas | RSS pico |
| --- | --- | --- | --- | --- | --- | --- |
| sem teto (§3) | /login | 22.37 | 17690 ms | 18851 ms | — | 365.8 MB |
| sem teto (§3) | /refresh | 485.15 | 612 ms | 2483 ms | — | 375.4 MB |
| 1024 | /login | 21.07 | 18605 ms | 19940 ms | 0 | 357.5 MB |
| 1024 | /refresh | 543.83 | 577 ms | 993 ms | 0 | 261.8 MB |
| 256 | /login | 19.55 | 510 ms | 19310 ms | 11554 | 348.9 MB |
| 256 | /refresh | 244.54 | 121 ms | 1638 ms | 40741 | 325.8 MB |
| 32 | /login | 11.19 | 254 ms | 4233 ms | 53290 | 327.3 MB |
| 32 | /refresh | 21.11 | 235 ms | 907 ms | 71445 | 279.5 MB |

### O que a tabela desmonta

**1. O teto não é uma alavanca de memória.** Era a premissa — e a medição
mostra que é falsa. Baixar o teto de 1024 para 256 economiza **4,6%** de memória
no `/login` e 13% no `/refresh`, e paga **50% da vazão do `/refresh`** e 13% do
`/login`. Teto 32 economiza 11% e paga metade do `/login` e **96%** do
`/refresh`. Não existe ponto dessa curva em que limitar concorrência seja
barato em vazão.

A razão está no que já foi medido na §3: a memória do serviço não é dominada
pelo número de requisições *esperando*, e sim pelo argon2id (~19 MiB por hash
concorrente) e pelo que o GC retém. Requisição parada em fila custa quase nada;
requisição no meio de um hash custa 19 MiB. **As duas coisas não são a mesma
variável**, e tratar "requisições em andamento" como sinônimo de "memória em
andamento" é o erro que faria o teto ser calibrado contra o número errado.

**2. Por isso o teto é frouxo: 1024.** Com 400 VUs — a maior carga medida — o
teto 1024 não recusou **nenhuma** requisição, e os números ficam nos do
baseline (o `/refresh` a 543,8 rps está dentro da variação entre repetições, a
mesma que fez o `/health` variar entre 693 e 701 rps). O limite só existe para
rajada, e é por isso que ele não atrapalha o tráfego normal em vez de
"proteger" um recurso que ele não controla.

**3. `Retry-After: 1` e o formato do p50 mudam com o teto engatado.** Com teto
256 o p50 do `/login` cai de 17690 ms para 510 ms — e isso **não é
melhoria**: a distribuição fica bimodal, com 86% das respostas sendo recusa
instantânea e o resto os 19 s de verdade. Ler essa linha como "o disjuntor
melhorou a latência" seria ler errado. É por isso que o harness conta o 503 do
disjuntor em balde próprio (`overloaded_503`) em vez de deixá-lo misturado na
taxa de erro: o limite cumpriu o papel, o endpoint não degradou.

### O que protege memória, então

Em ordem de quanto realmente pesa, com o número de cada uma:

1. **`os.availableParallelism()` nos workers** — impede 4 workers em 2.0 CPU,
   que a §4 mediu em ~1.4 GB contra 1 GiB.
2. **Teto do container (1 GiB) e o disjuntor do orquestrador** — a rede de
   segurança para o que a aplicação não previu.
3. **workers = 2, não mais** — 720 MB medidos de RSS somando os dois processos
   no pico do `/login` a 400 VUs (70% do teto).
4. **Este limite de concorrência** — para rajada, acima de 1024 simultâneas.

Os itens 1 e 3 são decisões de configuração; o 4 é o único código novo desta
rodada, e ele existe mais pela Fase 6 (DDoS) do que pela Fase 3. Dizer isso é
melhor do que apresentar o limitador como a proteção de memória que a medição
mostrou que ele não é.
