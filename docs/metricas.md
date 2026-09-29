# Métricas

Números medidos neste repositório, com o comando que os produziu. Vale como
evidência local; em produção os valores só se confirmam com medição no ambiente
alvo.

Data da medição: 2026-09-29.

## 1. Custo de hashing de senha

Comando:

```bash
# no host, para iteração rápida
node scripts/benchmark-password-hash.mjs --iterations 20 --concurrency 1,2,4

# no orçamento real de produção: 2.0 CPU e 512 MB
docker run --rm --cpus 2.0 --memory 512m -v "$PWD/scripts:/bench:ro" node:22-alpine \
  sh -c 'cd /tmp && npm i bcrypt @node-rs/argon2 --no-audit --no-fund --silent \
  && cp /bench/benchmark-password-hash.mjs /tmp/ \
  && node /tmp/benchmark-password-hash.mjs --iterations 20 --concurrency 1,2,4'
```

`pico RSS` é a marca d'água de RSS (`process.resourceUsage().maxRSS`) de um
processo separado que só executou aquele candidato, para 1 e para 4 logins
simultâneos. Medir no próprio processo do benchmark daria sempre ~0 MB: a
memória do argon2 já voltou ao pool quando o `await` termina.

### Dentro do orçamento de produção (2.0 CPU, 512 MB)

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
512 MB, 4 workers):

```bash
# o limitador de /login de produção é 5 req/15 min, então a medição sobe o
# orçamento. Sem isso a própria medição toma 429 e mede o limiter, não o login.
RATE_LIMIT_PROD_LOGIN_POINTS=100000 RATE_LIMIT_PROD_LOGIN_DURATION=60 \
  RATE_LIMIT_PROD_LOGIN_BLOCK_DURATION=1 \
  docker compose --env-file .env.prod -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate auth-service

node scripts/measure-login-latency.mjs --url http://localhost:3100 \
  --user mede_bench --password "$SENHA" --requests 30 --concurrency 1,4,8
```

Credenciais válidas, 30 logins por nível, 1 de aquecimento. O tempo é medido do
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

A migração aconteceu no mesmo teste: o hash de `mede_bench` estava em bcrypt
antes da primeira requisição e já estava em `$argon2id$v=19$m=19456,t=2,p=1$`
depois, com `passwordHistory` vazio — o login migrou sem trocar a senha do
usuário.

### Limite de 4 workers

Com 4 workers e 2.0 CPU, o custo por hash continua sendo o gargalo, mas em
c=1 o serviço entrega 29 logins/s: o `/login` deixou de ser o caminho crítico
e a próxima temporada de latência deve ser medida em outro lugar (Mongo,
Redis, TLS). K6 continua sendo a ferramenta certa para isso; o script de
medição cobre o caso de um acesso pontual e reproduzível.
