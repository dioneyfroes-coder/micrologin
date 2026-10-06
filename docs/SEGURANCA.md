# Threat model e decisões de segurança

Documento de portfólio com escopo explícito: o que este serviço defende, de quem,
com quais mecanismos, e — tão importante — **o que ele não defende**.

---

## 1. Escopo

**Dentro:** o serviço de autenticação. Recebe requisição HTTP, decide se a
credencial é válida, emite e revoga tokens de sessão, guarda usuário e senha.

**Fora:** o que o serviço não controla. Infraestrutura, TLS terminado no proxy,
rotina de backup, gestão de segredo, e a qualidade do ambiente onde roda.

**Não é:** um provedor de identidade. Não há MFA, recuperação de conta,
verificação de e-mail, federação, nem consentimiento. Quem precisa disso usa
Auth0, Keycloak ou Cognito.

---

## 2. Ativos e o que dói perdê-los

| Ativo | Onde está | Impacto de perda |
| --- | --- | --- |
| hash de senha | MongoDB, campo `password` | deriva de credencial em massa |
| segredo de assinatura | `JWT_SECRET` / `JWT_REFRESH_SECRET` | **forja de token** — aceita qualquer identidade |
| refresh token de usuário | resposta HTTP, cliente | sessão hijack sem furto de senha |
| versão de sessão | Redis `user_session_version:*` | revogação em massa deixa de revogar |
| dados do usuário | MongoDB | exposição de PII |

O segredo de assinatura é o ativo crítico: compromising a senha de um usuário
custa uma conta; compromising o segredo custa todas de uma vez, sem tocar em
nenhum hash.

---

## 3. Fronteiras de confiança

```text
   Internet  ──[1]──►  Proxy TLS  ──[2]──►  Serviço (HTTP interno)
                                                   │
                                        [3]        │        [4]
                              MongoDB ◄──────────┴──────────► Redis
```

| # | Fronteira | Controles |
| --- | --- | --- |
| 1 | cliente → proxy | TLS, HSTS, CORS por allowlist |
| 2 | proxy → serviço | rede interna; o serviço não reexpose TLS (ver decisão D7) |
| 3 | serviço → MongoDB | URI com credencial, sem auth em dev |
| 4 | serviço → Redis | é a fronteira mais crítica: **é ela que decide revogação** |

O serviço **confia** em `X-Forwarded-For` somente atrás de proxy com
`trust proxy` configurado — e `TRUST_PROXY=true` (confiar em toda a cadeia) faz o
app **recusar o arranque em produção**, porque a segurança desse valor depende de
um proxy que reescreva o cabeçalho, o que é propriedade da topologia e não
verificável de dentro do processo. O caminho declarado é o número de saltos
(`TRUST_PROXY=1`, o nginx sobrescrevendo o cabeçalho) ou a faixa CIDR do proxy;
`TRUST_PROXY_ALLOW_UNRESTRICTED=true` é o opt-in explícito para assumir essa
responsabilidade quando a topologia sustenta a afirmação.
Sem proxy declarado, o cabeçalho é do cliente e o forjador **não** ganha: ele
fica preso ao IP do socket, que é o que o rate limit por IP protege. O `liveness`
foi feito para não depender disso (ver README).

---

## 4. Ameaças e mitigação

| # | Ameaça | Mitigação | Onde |
| --- | --- | --- | --- |
| T1 | Credential stuffing / força bruta | rate limit por IP **e** por conta; login responde genérico | `advancedRateLimit.ts` |
| T2 | Enumeração de contas | `/login` não distingue usuário inexistente de senha errada; username normalizado; **tempo** dos dois caminhos equalizado com `compareDummy` (D34) | `AuthService`, `usernamePolicy.ts` |
| T3 | Roubo de refresh token | rotação `SET NX`; reuso publica `TOKEN_REUSE_DETECTED` (gravidade alta), revoga todas as sessões e responde 401 | `jwtTokenService.ts:refreshTokens`, `AuthService.refreshUserTokens` |
| T4 | Token revogado ainda aceito | blacklist por `jti` + `sv` de sessão; logout revoga o par inteiro | `AuthService.endSession` |
| T5 | Redis fora do ar | `SESSION_FAIL_OPEN=false` (padrão em produção) → `503`, nunca aceitar sem revogação | `isRevocationStoreReady` |
| T6 | SQL/NoSQL injection | sem SQL no projeto; Mongo comongoose sanitiza o objeto; input validado por tipo | `validation.ts` |
| T7 | XSS | API responde JSON, sem HTML; CSP restritiva; sem escaping na entrada | `helmet.ts` |
| T8 | Senha fraca ou reutilizada | mínimo 12, classe de caractere exigida, 5 hashes anteriores, troca exige a senha atual | `passwordPolicy.ts` |
| T9 | Timing attack na comparação de senha | a verificação do argon2id é de tempo constante por construção, e o `compare` não tem caminho de igualdade antecipada | `PasswordHasher` |
| T10 | Payload grande / DoS de parsing | limite de 100kb no `express.json`; rate limit antes do trabalho caro | `app.ts` |
| T11 | Clique em log de auditoria | usuário mascarado no console; refresh token nunca vai para o log de evento | `logToConsole` |
| T12 | Cliente forja identidade via proxy | `X-Request-Id` externo é recusado se não for UUID; IP confiável exige `trust proxy` | `requestLogger.ts` |
| T13 | Burst de login estoura a memória do container | semáforo de operações argon2id com fila limitada; `hash` e `verify` passam pelo mesmo mecanismo; fila cheia → 503 (D30) | `argon2Limiter.ts` |
| T14 | Senha trocada com sessões antigas vivas | revogação **antes** de persistir, com o retorno conferido; falha de revogação → 503 sem alterar a senha (D31) | `AuthService.changePassword` |
| T15 | Token de conta apagada continua renovando | existência do usuário conferida antes de rotacionar; token órfão é revogado (D31) | `AuthService.refreshUserTokens` |
| T16 | Refresh token de 7 dias usado como access | claim `token_type` conferida em qualquer algoritmo, inclusive HS256 (D33) | `jwtTokenService.ts` |

---

## 5. Riscos aceitos

Escrito para que ninguém descubra reviewing o código:

1. **Rate limit em memória quando o Redis cai.** Ele vira **por processo**. Com
   PM2 em cluster, N workers dão N vezes o limite. É proteção de borda, não
   controle distribuído. Aceito porque a alternativa (recusar tráfego quando o
   Redis cai) seria pior.
2. **Histórico de auditoria em memória, por processo.** Cap de 1000 eventos;
   reinício perde, e em cluster são N históricos. Aceite porque a auditoria aqui
   é sinalização, não registro de conformidade.
3. **Sem verificação de e-mail.** Registrar `ana@x.com` e `ana@y.com` cria duas
   contas. Uma API sem confirmação de posse é a mesma que a maioria dos
   portfólios assume; quem precisa do contrário deve usar um provedor de identidade.
4. **Sem MFA.** Senha roubada é sessão roubada. Aceito como escopo.
5. **Detecção de padrão é auxiliar e não bloqueia.** Os regexes de
   `securityMonitoring.ts` sinalizam; quem bloqueia é o rate limiter. Um regex
   que bloqueia é um regex que derruba usuário legítimo — e a proteção de entrada
   é a validação determinística, não o padrão de string.
6. **O token de admin de `/security/*` é um segredo compartilhado.** Sem
   identidade por trás. Em ambiente com mais de um operador, isso não serve.
7. **`METRICS_TOKEN` sem rotação nem escopo.** Protege um único manifesto. Nome
   legado, mantido por compatibilidade de configuração já implantada.
8. **O tempo de `PUT /update` ainda distingue username repetido de username
   livre.** A resposta HTTP é explícita por decisão de API, então quem chega ao
   endpoint já tem sessão válida — quem enumera já tem conta. Corrigir o tempo sem
   mudar o contrato seria trabalho invisível; mudar o contrato é decisão de API,
   não correção de segurança. Ver D34.

---

## 6. Log de decisões

Cada entrada responde: o que foi decidido, por quê, e o que foi recusado.

### D1 — Falha de revogação é fail-closed em produção
`SESSION_FAIL_OPEN=false` devolve `503 REVOCATION_UNAVAILABLE` em vez de aceitar
token sem poder checar revogação.
*Recusado:* aceitar token e logar o risco. A indisponibilidade do Redis passaria
a ser uma janela de replay, e a janela não seria visível para quem precisa ver.

### D2 — Blacklist chaveada por `jti`, nunca pelo token
`token_blacklist:jti:<jti>`. Tokens sem `jti` (emissão anterior) caem para
`token_blacklist:sha256:<hash>`.
*Recusado:* usar o token como chave. Isso colocaria um segredo de sessão em
memória e em log de sistema, e o tamanho da chave é o do token.

### D3 — Revogação em massa por contador (`sv`), não por timestamp
*Recusado:* gravar `user_tokens_revoked` com o instante da revogação e comparar
com `iat`. Token emitido no mesmo segundo seria rejeitado — que é justamente a
pessoa que acabou de trocar a senha. O timestamp segue existindo, mas só como
caminho de transição para tokens sem `sv`.

### D4 — Marcação de refresh consumido ANTES de emitir o par
`SET NX` em `rotated` antes de gerar o novo par.
*Recusado:* emitir e depois marcar. A janela entre os dois deixaria duas
requisições concorrentes emits ambas com `200`, e reuso deixaria de ser sinal de
comprometimento.

### D5 — Username normalizado em fonte única
`trim` + `lowercase` em registro, login, atualização e consulta.
*Recusado:* `lowercase` no schema do Mongo só. `Alice` e `alice` seriam
identidades diferentes na consulta e iguais no índice — o registro passaria e o
login não encontraria.

### D6 — Senha nunca é normalizada nem escapada
*Recusado:* escaping de HTML ou remoção de caractere em senha. Senha é segredo
opaco; transformá-la muda o valor que o cliente enviou e quebra a comparação com
o hash. `normalizeInput` mantém uma lista explícita de campos opacos.

### D7 — HSTS só quando o serviço serve HTTPS de verdade
`setupSecurity(app, serverConfig.ssl.enabled)`. Em container, o TLS termina no
proxy e o app serve HTTP interno.
*Recusado:* HSTS incondicional. O header declara "daqui em diante, só HTTPS" para
o domínio inteiro; declarar sobre um serviço que não serve TLS quebra o acesso a
todo o resto do domínio.

### D8 — Métricas de scrape removidas; observabilidade por porta
`setAuthEventSink` publica o evento de autenticação com rótulo já decidido. O
padrão é log estruturado, e `/observability` é derivado do `requestLogger`.
*Recusado:* manter a biblioteca de métricas. A forma de saída não era o problema;
o problema era a decisão de desfecho duplicada em cada consumidor, e um destino
trocável conserta isso sem impor formato de saída.

### D9 — Um buffer de eventos de segurança
O `threatLog` do monitor foi removido; o registro vai para o `events` do
`securityAuditLogger`.
*Recusado:* dois históricos. O mesmo evento gravado em dois lugares, com
`timestamp` em formatos diferentes, e sem consumidor para o segundo — é divergência
esperada, não uma redundância inofensiva.

### D10 — `sv` e a marca legada usam constantes
`USER_SESSION_VERSION_PREFIX` e `USER_TOKENS_REVOKED_PREFIX`, com round-trip
coberto por teste.
*Recusado:* montar a chave inline na leitura e na escrita. Divergir entre as
pontas faria `isUserRevoked` devolver `false` — token revogado aceito, sem erro
em lugar nenhum. É o tipo de bug que nenhum teste de integração pega, porque as
duas pontas usam a mesma constante errada.

### D11 — A reconexão do Redis é infinita; quem desiste é o processo
Backoff dobrando a partir de 100ms, teto de 5s, sem previsão de desistência.
*Recusado:* desistir depois de N tentativas. Sob fail-closed, um cliente morto
com `isReady === false` deixa o serviço inteiro devolvendo `503` até alguém
reiniciar o processo — bastava uma queda de meio segundo para travar a
autenticação de forma permanente, e o único sinal era uma linha de log. O
espelho também vale: ao encerrar, o processo **destrói** o socket em reconexão
em vez de mandar `quit()` (um comando que ninguém vai atender) — senão o timer
pendente segura o processo no event loop e o container não para.

### D12 — `ready` da reconexão não disputa a saúde com o `init`
O `ready` do node-redis emite na conexão inicial também. O handler só roda
depois que a conexão inicial se assentou; antes disso, quem responde por
`isHealthy` é o health check do `initRedis`.
*Recusado:* cuidar de `ready` sem a guarda. A corrida ressuscitava a saúde
depois de uma queda real (o health check do handler perdia e reescrevia um
`true` válido por `false`, e vice-versa) e imprimia "Redis reconectou, mas o
health check falhou" num arranque normal.

### D13 — Falha de driver no rate limiter não é limite estourado
O middleware distingue a recusa do `rate-limiter-flexible` (tem `msBeforeNext`)
do `Error` do driver de Redis, refaz o consumo em memória e desce o backend.
*Recusado:* tratar `Error` como recusa de limite. Uma queda do Redis virava
`429` com `Retry-After` para todo mundo e "violação de rate limit" na auditoria
— o serviço acusando ataque quando o que caiu foi a dependência. E o limite por
conta existe justamente para o atacante distribuído: deixar o backend em memória
depois que o Redis voltou daria a cada worker seu próprio orçamento. Por isso a
promoção de volta também é automática, e `reset()` faz SCAN em vez de
`KEYS` (que bloqueia o servidor inteiro).

### D14 — Login recusado por infraestrutura é `unavailable`, não `failure`
Quando a revogação está indisponível (fail-closed), o login responde `503
REVOCATION_UNAVAILABLE`, e a auditoria conta em `unavailableLogins`.
*Recusado:* o `401 "Credenciais inválidas"` de antigamente. Com a senha certa e
o Redis fora, `401` fazia o cliente desistir de uma conta boa e colocava a
indisponibilidade no contador de força bruta — o alerta que treina o time a
ignorar o alerta que importa. O corpo público continua genérico; só o **status**
carrega o diagnóstico.

### D15 — JWT assimétrico (ES256/ECDSA P-256) com `kid`, e `jose` como biblioteca
A assinatura saiu de HS256 para **ES256**. A chave privada só existe em quem
emite; a pública (não-secreta) verifica. O header carrega `kid` e o verificador
recusa token sem `kid` ou com `kid` desconhecido. Produção recusa HS256 no
arranque. HS256 permanece apenas em dev/test, implementado por `jsonwebtoken`,
para os testes que fabricam token legado.
*Recusado:* manter HS256. HS256 é simétrico: todo processo que verifica um
token — o próprio serviço em outra réplica, um gateway, o dashboard — precisa do
segredo que assina, o que transforma cada verificador em um emissor. Um dump de
memória de qualquer um deles vira forja de token. A rotação, sem `kid`, obrigaria
o verificador a "testar todas as chaves" ou a aceitar apenas a mais recente —
derrubando todo mundo logado a cada troca.
*Recusado:* escolher a chave pela ordem de preferência em vez do `kid`. Seria
reabrir, na verificação, a ambiguidade que o `kid` fecha.

**Custo pago, registrado:** ES256 compartilha o par entre access e refresh, então
a única separação entre os dois passa a ser a claim `token_type`. Um refresh
aceito como access seria escalada de privilégio (7 dias no lugar de 15 minutos).
Por isso o `JWTTokenService` confere a claim no caminho ES256, e `verify` decide
pelo tipo — coberto em teste.

**Incidente de provisionamento (por que D15 tem este parágrafo):** a primeira
versão de `scripts/generate-jwt-keys.sh` gerava a privada com
`openssl ecparam -genkey` (**SEC1**, `BEGIN EC PRIVATE KEY`), enquanto o
`jose/importPKCS8` só importa **PKCS#8** (`BEGIN PRIVATE KEY`). O par estava
correto — a pública derivava da privada e o script se autoconferia —, o
container subia, o health check respondia, e o **primeiro login devolvia `401`
de credencial inválida** porque a assinatura é que falhava; o erro real saía
como "Erro na autenticação" sem stack (o logger espalhava o `Error` com
spread, e `message`/`stack` não são enumeráveis — D15 também corrige isso).
A suíte unitária passava porque gerava chaves com `jose.generateKeyPairSync`
(PKCS#8): provisionamento e consumo nunca se encontravam em um teste. A correção
tem três partes: o script passou a emitir PKCS#8 e a conferir o formato; o
emissor aceita SEC1 também (é o mesmo par em outra embalagem, e convertê-lo via
`node:crypto` não afrouxa nada); e um teste novo executa o script de verdade e
assina com a chave que ele produziu — a costura que faltava.

### D16 — argon2id (m=64MiB, t=1, p=1), único algoritmo do projeto
O hash de senha é **argon2id** com 64 MiB de memória e 1 passada. A escolha saiu
de medição, não de costume: na mesma máquina, no mesmo orçamento de produção
(2.0 CPU, 1 GiB), o bcrypt cost 12 que rodava custava **365.7 ms por hash
contra 27.8 ms de argon2id 19MiB** — 13x mais caro e menos resistente, por não
ser memory-hard. No `/login` real o p95 caiu de **491 ms para 45.4 ms** em c=1 e
de **1868 ms para 191 ms** em c=8. Medições completas em
[`metricas.md`](metricas.md).

**O critério não é "mais parâmetro é melhor" — é em qual recurso escasso cada
lado gasta.** O atacante com GPU tem FLOPS em abundância e VRAM escassa; o atacante
com ASIC tem custo linear em `t` e custo alto em `m`. CPU é o recurso que os dois têm de sobra. Portanto o esforço vai para `m`, e `t` fica no mínimo: subir
`t` dobra o custo dos dois lados, mas o atacante engole esse dobro no que já
abunda, enquanto o servidor paga em latência de login. É a assimetria que justifica `t=1`.

Com esse critério, a escada medida no server01 (2.0 CPU, 1 GiB) fecha assim:

| candidato | mem/tentativa vs 19MiB | CPU/tentativa vs 19MiB | p95 c=1 | 8 conc. | veredito |
| --- | --- | --- | --- | --- | --- |
| m=19MiB, t=2, p=1 | 1.0x | 1.0x | 84.2 ms | 152 MiB | mínimo da OWASP |
| m=32MiB, t=2, p=1 | 1.7x | 1.7x | 131.0 ms | 256 MiB | latência demais |
| **m=64MiB, t=1, p=1** | **3.4x** | **1.7x** | **81.1 ms** | **512 MiB** | **escolhido** |
| m=64MiB, t=2, p=1 | 3.4x | 3.4x | 173.4 ms | 512 MiB | latência demais |
| m=64MiB, t=3, p=1 | 3.4x | 5.1x | 359.5 ms | 512 MiB | latência demais |
| m=96MiB, t=1, p=1 | 5.1x | 2.5x | 310.3 ms | 768 MiB | fecha a conta sem folga |
| m=96MiB, t=2, p=1 | 5.1x | 5.1x | 364.0 ms | 768 MiB | latência demais |

**`m=64MiB, t=1` é o ponto de melhor troca da curva**, e o dado que decide é a
coluna de latência: 3.4x a memória por tentativa do atacante com p95 de login de
**81.1 ms contra 84.2 ms** do mínimo da OWASP. Não há regressão perceptível
para ganhar 3.4x o custo de memória do atacante. Subir para `t=2` dobra o custo
de CPU dos dois lados e empurra o p95 para 173 ms — o dobro de latência por um
ganho que o atacante absorve no recurso que ele tem de sobra.

*Recusado:* `m=96MiB`. Fecha a conta de memória exatamente (96 × 8 = 768 MiB, o
orçamento inteiro) e passa na validação porque o guard compara com `>`. É
preciso dizer por que não é o padrão: **o maior valor que cabe não é o melhor
valor**. Sem folga para o runtime, qualquer coisa que o Node retenha além do
argon2 (heap, buffer de request, conexão) competindo com o hash. Com 64 MiB
sobram ~33% de folga, e é por isso que o guard tem teste para os dois lados do
boundary.

*Recusado:* `p>1`. E o ponto onde a medição desmentiu o argumento que eu tinha.
A justificativa costumeira ("4 threads por requisição faz 2 logins ocuparem o
container") é inválida como explicação: o paralelismo do Argon2 não é CPU extra,
é **o mesmo CPU compartilhado**, e medir no servidor com 4 vCPU deu 20 logins/s
para `p=4` contra 29 para `p=1` no mesmo `m=64MiB`. Pior com mais CPU, não
melhor. O argumento que sobra é o dos autores do Argon2: `p>1` entrega poder
computacional ao atacante sem devolver defesa proporcional, e em servidor esse
poder sai do orçamento de latência em vez de entrar.

*Recusado:* o `m=64MiB, t=3, p=4` que o roadmap propunha original. Medido aqui: 359.5 ms de p95 e 5.1x o custo de CPU dos dois lados, com o mesmo 3.4x de
memória do `t=1`. É estritamente pior que a escolha feita.

**O bcrypt saiu do projeto.** A primeira versão desta decisão o mantinha como
verificador do material legado e como rollback. Em ambiente de laboratório, sem
usuários antigos para preservar, esse caminho não pagava o que cobrava: uma
dependência nativa a mais, um segundo algoritmo no `compare`, e um rollback que
pode dar a impressão de reversibilidade onde não há reversibilidade real — se
alguém rodar com um hash bcrypt no banco, o serviço não tem como conferir a
senha e o usuário fica preso. Removido `BcryptAdapter`, a dependência `bcrypt`,
`PASSWORD_HASH_ALGORITHM` e `BCRYPT_SALT_ROUNDS`. O `compare` entende apenas
argon2id, e qualquer outro valor é tratado como credencial ilegível (resposta
`false`, com aviso no log) em vez de ser aceito.

**O que continua de pé.** O reescritor (`needsRehash` → `rehashPassword`) não
dependia do bcrypt: ele cobre o caso real daqui em diante, que é **subir os
parâmetros** — e foi exatamente o que esta mudança fez. Um hash gravado com
m=19MiB continua verificável depois de a configuração ir para 64MiB, e cada login
bem-sucedido reescreve o hash nos parâmetros em vigor, na mesma requisição. Sem
tabela de migração, sem campo novo, sem pedir troca de senha. O E2E cobre
exatamente esse caminho gravando um hash fraco direto no Mongo.

**Reescrever não é trocar senha.** `rehashPassword` grava só o hash: não toca em
`passwordHistory` nem em `passwordChangedAt`. Se o hash anterior fosse para o
histórico, a senha antiga voltaria a ser aceita logo depois; se
`passwordChangedAt` mudasse, o sistema afirmaria que o usuário trocou a senha
quando não trocou. Há teste para os dois.

**A reescrita não pode custar um login válido.** Ela é best-effort: se a escrita
falhar, o login é entregue, o aviso vai para o log e a reescrita volta no
próximo login. O usuário provou a senha; transformar falha de escrita em erro de
autenticação seria devolver 500 para quem fez tudo certo.

**O orçamento de memória é medido, não suposto.** O `mem_limit` subiu de 512 MB
para **1 GiB** depois que o hardware foi identificado (server01: i5-7200U, 4 vCPU,
12 GB). A primeira versão desta decisão tinha validado o argon2id contra um
`mem_limit` que ninguém tinha medido contra a máquina — era um número escolhido no
compose, e tratar um número arbitrário como "orçamento real de produção" é o
erro de método que a medição existia para evitar. Duas conclusões que a medição
no teto novo deu, e que contrariam o que eu tinha escrito antes:

**Mais memória não comprou throughput.** Com 4 GB em vez de 512 MB, o `m=64MiB`
continuou pedindo 325 MB de pico e continuou entregando ~1/6 dos logins/s do
mínimo da OWASP. O teto medido bate com `núcleos ÷ tempo_por_hash`, que é a
assinatura de limite de **CPU**, não de RAM. Isso é o que justifica `t=1`: com o
servidor limitado por CPU, tempo é o recurso que não há.

**Subir a memória piorou o `/login`.** p95 foi de 45.4 para 61.8 ms em c=1 sem
que o hash tivesse ficado mais lento — os parâmetros eram os mesmos e o
benchmark isolado mediu 22.9 ms de p50 no teto novo contra 27.8 ms no antigo. É
a CPU da máquina, agora dividida com Mongo, Redis, Portainer e outro projeto. Em
servidor compartilhado, **quem decide é o número do endpoint, não o do benchmark
isolado** — e ele dizia que o teto de memória nunca foi o limite do login.

**Os parâmetros não sobem porque a máquina ficou maior.** A extrapolação para
hardware grande está em [`ARQUITETURA.md`](ARQUITETURA.md#11-projeção-em-hardware-grande-120-núcleos--120-gb):
120 núcleos e 120 GB não mudam o `m=64MiB, t=1`, porque o atacante paga a mesma
tabela de custo que o servidor e RAM ociosa não vira CPU. O que a RAM extra
permite é `m` maior, e isso é política de segurança, não throughput — precisa de
medição própria no hardware alvo, não de extrapolação.

**Alerta de memória passou a ser proporção.** O `/health` marcava `warning` acima
de 200 MB fixos. Com o container em 1 GiB esse número dispararia durante o pico
normal de logins e deixaria de significar alguma coisa. Agora o limite é lido do
cgroup (`memory.max` v2 / `memory.limit_in_bytes` v1) e o alerta é **65% do
teto** — ~680 MB num container de 1 GiB, bem acima dos ~512 MB que 8 logins
concorrentes com `m=64MiB` podem pedir. Um número absoluto erra nas duas
direções: alerta cedo demais num container grande, e nunca num pequeno.
### D17 — Pepper: mecanismo pronto, desligado por padrão
O pepper (HMAC-SHA256 antes do hash) foi **medido** e **implementado**, mas
**não vem ligado**. A decisão está no código, e as quatro variáveis que a
expressam são `PASSWORD_PEPPER`, `PASSWORD_PEPPER_VERSION`,
`PASSWORD_PEPPER_PREVIOUS` e `PASSWORD_PEPPER_PREVIOUS_VERSION` — as duas
primeiras ligam o mecanismo, as duas últimas só existem durante a rotação. O
padrão é desligado. O procedimento está em
[`ROTACAO.md`](ROTACAO.md), seção 2.

*Por que desligar, se não custa nada:* a medição confirma que o pepper não tem
custo mensurável (26.2 ms contra 27.8 ms, diferença menor que a variação entre
execuções). A discussão nunca foi de desempenho. É que o pepper
só protege quando **hash e pepper não saem juntos** — e num serviço que guarda
`passwordHistory`, pepper por hash, envelope versionado e rotação, ele amplia a
superfície de operação (segredo a provisionar no KMS, versão a gravar, rotação a
orquestrar) para uma defesa em profundidade que a OWASP descreve como
"nenhuma característica de segurança adicional" quando usada sozinha. Ativar isso
sem um KMS real e sem operação que sustente a rotação seria teatro de segurança.

*O que fica pronto de verdade:* o envelope `p1:$argon2id$...` carrega a versão do
pepper dentro do hash. Sem isso, "hash antigo" e "hash de outra versão" seriam a
mesma coisa, e ativar ou rotacionar o pepper bloquearia todo mundo — o mesmo
tipo de erro do incidente de provisionamento em D15. Com o envelope, ligar o
pepper hoje é correto: hashes sem envelope continuam verificáveis (o `compare`
tenta o pepper atual, o anterior e a senha em claro, nessa ordem) e são migrados
no próximo login. **Versão de pepper cujo segredo não está configurado falha
alto**, em vez de responder "senha incorreta" — mandar um usuário com senha certa
para um reset que não resolve é pior que um erro.

---

### D18 — Dependências autenticadas, credencial em arquivo, e transporte por rede dedicada ou TLS

Antes desta decisão, Mongo e Redis subiam abertos: sem `requirepass`, sem ACL e
sem usuário de aplicação no Mongo. Qualquer processo que alcançasse a rede dos
containers — outro container, um processo no host, um bind acidental de porta —
lia o banco inteiro. O que está lá não é dado público: `passwordHistory` e
`passwordHash` (material de quebra offline), a blacklist de `jti` (o fail-closed
de D1 depende de ela existir) e os contadores de rate limit (o limite por conta
de D13 depende de eles serem confiáveis). Banco aberto anula decisões que já
estavam tomadas em outros lugares.

*Credencial por arquivo, não por variável de ambiente.* `URI_MONGODB` é logada,
e o driver inclui a credencial na mensagem de erro de autenticação; variável de
ambiente também aparece em `docker inspect` e em dump de crash. As senhas nascem
em `scripts/generate-dependency-secrets.sh`, com modo 600 (ou 640 nas duas que o
app e a dependência leem juntas), dono ajustado por `--for-container` para os
uids reais das imagens (o app roda como uid 1001, Mongo e Redis como 999). Sem
o ajuste de dono, o modo 600 vira arquivo ilegível dentro do container e o
serviço recusa arrancar dizendo que falta senha — quando o que falta é
permissão. O app lê `MONGODB_PASSWORD_PATH` e `REDIS_PASSWORD_PATH`; o caminho
do root do Mongo e o arquivo de ACL (dono 999, 600) **não** são legíveis pelo
uid 1001, que é a diferença entre o serviço acessar os dados e acessar a
administração deles. A prova disso está no teste de infraestrutura: ele confirma
que o container do app lê as próprias senhas e falha ao ler a do root.

*Usuário de menor privilégio no Mongo.* `docker/mongo/10-app-user.sh` roda uma
vez, na criação do volume, e cria o usuário da aplicação em `authSource=admin`
com papel `readWrite` apenas sobre o banco do serviço. A senha do `root` existe
só para criar esse usuário; o app nunca a vê. Um dump do processo do
auth-service entrega o acesso aos dados de um banco, não `root` do cluster.

*ACL no Redis, não `requirepass`.* `requirepass` liga a senha no usuário
`default`, que não é atribuível a ninguém e não gira sem derrubar quem está
conectado. A ACL usa `user default off` — a conexão anônima é recusada — mais um
usuário nomeado com `+@all -@admin -@dangerous`. O corte tira `CONFIG`, `ACL`,
`FLUSHALL`, `KEYS`, `MONITOR` e `SHUTDOWN` sem tirar o que o serviço usa:
`GET`/`SET`/`EXPIRE`/`INCR`/`SCAN` e os `EVAL`/`EVALSHA` do rate-limiter, que
estão em `@scripting` e não em `@dangerous` (medido com `ACL CAT dangerous`, não
suposto). O hash vai no formato `#<sha256>`, medido com `ACL LIST`: `>#<sha256>`
é aceito sem erro e significa "senha em texto claro igual a `#<sha256>`" — o
serviço sobe, o health check responde e a primeira operação que precisa de dado
falha com `WRONGPASS`. O script recusa esse marcador, e o teste de unidade
recalcula o SHA-256 por fora para não depender da autoconferência do próprio
script.

*Transporte: rede dedicada ou TLS, nunca nenhum dos dois.* Em produção o app
recusa o arranque sem credencial e sem um dos dois. No compose padrão, as
dependências ficam numa rede `internal` (sem gateway e sem rota para fora do
host) e sem porta publicada — o dado não sai da pilha, e por isso o TLS não é
exigido: ele seria o mesmo dado em texto claro atravessando o loopback do host.
Ao apontar para Atlas, ElastiCache ou outro serviço gerenciado, a rede dedicada
deixa de valer e a outra metade da decisão entra: `MONGODB_TLS=true` /
`REDIS_TLS=true` (ou `mongodb+srv://`, que já implica TLS). `DEPENDENCY_NETWORK_ISOLATED`
existe para declarar a primeira metade; as duas ao mesmo tempo não são erro, mas
nenhuma das duas não arranca.

*Ambiguidade é recusada, não resolvida.* Credencial na URI **e** nas variáveis
separadas ao mesmo tempo não é redundância: é a chance de o operador rotacionar
uma e o app continuar autenticando com a outra. O mesmo vale para
`X` e `X_PATH` definidos juntos. Nos dois casos a validação recusa, e a mensagem
diz qual das duas ignorar. Credencial pela metade (usuário sem senha ou senha
sem usuário) também é recusada: ela não autentica ninguém, e o sintoma só
apareceria no primeiro acesso que falhasse.

*A prova.* `scripts/infra-resilience-test.sh` sobe o stack de produção e conecta
anônimo e com senha errada em cada serviço real: Redis responde `NOAUTH` e
`WRONGPASS`, o Mongo recusa leitura anônima, e o container do app não abre a
senha do root. Um health check verde não provaria nada disso — o app estaria
saudável com o banco aberto.

### D19 — A verificação de segredo é um comando só, e ela precisa falhar

O gitleaks já rodava no CI desde a primeira entrega. Rodando de verdade, ele
encontrou **9 achados** — todos falsos: um literal de teste
(`test-secret-key-with-at-least-32-chars-123`), um identificador
(`privateKeyPem: jwt.es256.privateKey`), nomes de arquivo de chave e o
placeholder truncado (`MIIE...`) da documentação. A causa não era o gitleaks: a
allowlist do repositório citava um valor de teste que não existe no código, e
por isso não cobria nenhum dos dois literais de teste que existem. Ou seja, o
pipeline estava vermelho, e vermelho por ruído é o caminho mais curto para
alguém desligar o scanner.

*Um scanner que grita lobo é desligado; um que nunca grita não é usado.* Então a
regra é: a allowlist existe, é estreita e justifica cada entrada no comentário
— placeholder truncado, literal de teste, nome de arquivo, identificador. Nenhum
caminho de arquivo e nenhum diretório inteiro é autorizado, porque aí qualquer
segredo colado ali vira invisível. O que sobra é o `--config` explícito em toda
execução, inclusive na local: o gitleaks procura a configuração no diretório de
trabalho, e sem isso a varredura de mesa de trabalho acusa o que o CI não acusa
(o inverso também é verdade, e foi o que aconteceu aqui).

*`npm run test:secrets` é a verificação.* Um único comando, o mesmo no CI e na
máquina, com três checagens que falham de jeitos diferentes:

1. **gitleaks** no conteúdo e no histórico — é o que acha segredo pelo
   *formato*, inclusive dentro de arquivo que ninguém achou que fosse material,
   e inclusive no que já foi apagado (apagar o arquivo não apaga o blob).
2. **arquivos de material no índice** (`git ls-files`, não o disco) — chave,
   certificado, ACL ou diretório de segredo versionado. Aqui não há formato a
   reconhecer: o `.gitignore` não protege contra `git add -f`, e o diretório de
   chaves precisa existir localmente para o app rodar sem ser um problema.
3. **conteúdo dos `.env*` versionados** — só as variáveis cujo *nome* é de
   credencial podem ter valor, e esse valor tem que ser vazio, um caminho de
   arquivo (`*_PATH`) ou um placeholder. É a folha que cobre a folga da
   allowlist: um exemplo que virou segredo de verdade é barrado aqui, porque o
   nome dele continua legítimo.

A terceira checagem nasceu de um defeito da própria checagem: ela usava
`grep -nE '^[A-Z...]'`, e o `-n` prefixa `148:` na linha, o que quebra a âncora
`^`. O resultado era um portão que não achava nada e portanto nunca falhava —
inclusive quando plantamos um segredo de verdade no `.env.example` para testá-lo.
A versão que está no repositório passa com o arquivo atual e falha com o
segredo plantado; os dois caminhos foram verificados, porque a diferença entre
eles é a única coisa que faz o portão valer alguma coisa.

---

### D20 — Revogação em nó único: o limite aceito e o que fecha a lacuna

**Status: aceito como limite desta topologia** (decidido na P11, registrado em
`docs/ARQUITETURA.md` ao lado do SPOF do Mongo). Fica aqui para que a lacuna seja
encontrável, e para que aceitar um risco seja o mesmo que registrá-lo.

O serviço de revogação (blacklist de tokens e carimbo de sessão) roda em **um
único nó de Redis**. A D22 resolveu a outra metade do problema — o que o Redis
perde em restart agora sobrevive a restart, por AOF — mas o que o Redis perde em
**perda do volume** continua perdido: se o `docker volume` for destruído (falha
de disco, `docker volume rm`, restauração de VM a partir de snapshot antigo), o
serviço volta sem histórico de revogação e opera em **fail-open de fato** — não
por escolha de projeto, e sim por ausência do dado.

O ponto que importa é o alcance do dano. Não é "o login parou de funcionar" nem
"o banco sumiu": é que **um token que já foi revogado volta a valer até o seu
próprio expirar**, e nada no sistema consegue provar que o logout aconteceu. Um
atacante que guardou o token tem a janela inteira da validade dele. Como o
serviço é fail-closed quando o Redis está *indisponível* (D21 e o 503), o
fail-open aqui é um buraco silencioso num sistema que parece fechado: o operador
não tem nenhum sinal.

**Por que as duas saídas não foram implementadas agora.** Ambas mudam o
modelo de operação, não o código:

1. **Segundo Redis com réplica e `promote` manual.** Tira a revogação do caminho
   de nó único. Custa um segundo nó para operar, um procedimento de promote que
   alguém tem de saber executar, e uma janela de divergência no momento do
   promote — que precisa ser declarada, não descoberta.
2. **Persistir o carimbo de revogação também no Mongo**, que já é fonte de
   verdade e já tem backup (§D21). Elimina a dependência do dado estar no Redis,
   ao custo de escrever no Mongo a cada logout e de decidir o que acontece quando
   os dois divergem.

Escolher entre as duas é decisão de quem opera, porque a resposta depende de
quanto o ambiente tolera de indisponibilidade e quanta competência de promote
existe. Nenhuma das duas entra como "melhoria" escondida em refatoração.

**O custo, medido.** Aceitar sem medir é trocar uma afirmação vaga por outra. O
modo `--volume-loss` do drill (`npm run test:redis:volume-loss`) destrói o volume
do Redis contra um Mongo **intacto** — e é o banco de pé que torna o resultado
inequívoco: o usuário existe, o registro é que não — medindo o que sobra:

| o que foi revogado | o que acontece depois da perda do volume |
|---|---|
| access token | volta a valer até o próprio expirar: **~15 min** (`JWT_EXPIRES=15m`) |
| refresh token já consumido | **volta a valer**, e renova access tokens a cada 15 min até expirar: **7 dias** (`JWT_REFRESH_EXPIRES=7d`) |
| detecção de reuso de refresh | não dispara: o marcador também morre com o volume |
| sinal para o operador | **nenhum** — 0 erros no log do app, resposta 200 idêntica à de antes |

A segunda linha é a que importa, e é pior do que a primeira sugere. O dano não é
"um token de 15 minutos": quem guardou o par não precisa estar com o access
token, ele **renova** o access token a cada 15 minutos durante 7 dias, e a
proteção contra reuso de refresh — o que tornaria o par inútil depois do logout —
morre no mesmo volume. A janela aceita é, portanto, da ordem do TTL do refresh,
não do TTL do access.

**O que a operação tem até lá.** O fail-closed no Redis indisponível (503, nunca
401), o drill `npm run test:redis` (prova que a revogação sobrevive ao **restart**
— AOF `everysec`, D22) e o drill `npm run test:redis:volume-loss` (prova que a
perda de volume **expõe**, e mede a janela). Rodar os dois depois de qualquer
mudança no compose do Redis é o mais barato que existe para descobrir que alguém
desligou a persistência — e para confirmar que o limite aceito continua sendo o
limite aceito. Se um dia o segundo drill reprovar porque a revogação passou a
sobreviver à perda de volume, é sinal bom: a D20 foi fechada e este registro, o
`docs/REDIS.md` e o `docs/ARQUITETURA.md` precisam acompanhar.

Referência cruzada: `docs/REDIS.md` traz a discussão completa da falha de
volume e do fail-open acidental.

---

### D21 — Backup do Mongo é gpg AES-256 simétrico sobre archive único, RPO 24h

O roadmap da fase 2.1 citava "age/gpg simétrico" e "tar". O que foi entregue:
**gpg** (não age) e **`mongodump --archive`** único (não `mongodump --dir` +
tar). Motivos documentados em `docs/BACKUP.md`: age não existe na base do host
nem nas imagens do projeto (baixar binário novo só para o backup é uma
dependência que o runbook não deve criar), e o archive é um fluxo único e
atômico, sem o segundo ponto de falha de empacotar um diretório.

O texto claro nunca toca o disco do host: `docker exec <mongo> mongodump
--archive --gzip` é entregue por pipe direto ao `gpg --symmetric`, e o que
sobra é `sha-data-<data>.archive.gpg`. Cada backup é verificado antes de ser
aceito (decifra → gzip → `mongorestore --dryRun` **contra o próprio servidor,
sem escrever nada**), grava o manifest `last-backup.json` e expõe `--check`
como gancho de alerta de backup velho/falho. RPO padrão 24h; RTO medido no
drill (`scripts/test-backup.sh`), que apaga o banco de verdade e exige que o
mesmo usuário volte a autenticar — ~1s no banco de autenticação desta aplicação.

A passphrase do backup entra por `--passphrase-file` — nunca em argv, para não
vazar em `ps` do host nem no interpretador de log — e o arquivo é material
operacional fora do repositório, no mesmo regime dos outros segredos.

### D22 — Revogação persiste; o que o Redis perde é regenerável, o que ele esquece não é

A 2.2 fecha um buraco que a 1.4 tinha deixado aberto e que ninguém tinha
percebido, porque não produz erro nenhum. O Redis de produção rodava com
`--save "" --appendonly no`, com um comentário no compose justificando que
"cache e blacklist são reconstruíveis". A segunda metade da frase é falsa: a
blacklist é o registro do que não pode mais entrar, e esse registro não se
reconstrói — o logout aconteceu, o cliente foi avisado, e nada no sistema
consegue provar que aconteceu de novo. Um restart de container devolvia tokens
revogados à validade, em silêncio.

Medido no stack de teste, com o mesmo caminho do drill: token revogado ia de
401 (pós-logout) para **200** (pós-restart) sem nenhuma requisição mal
intencionada no meio. Com AOF `everysec` e `/data` em volume nomeado, o mesmo
caminho continua 401.

O detalhe que quase fez essa fase ser resolvida por engano é a diferença entre
duas coisas que o nome "fail-closed" sugeria serem a mesma:

- **Redis fora do ar** — coberto desde antes: sem armazenamento de revogação não
  há como garantir que um token não foi revogado, então o serviço nega (503, e
  não 401, porque "senha errada" seria mentira). Decisão mantida.
- **Redis de pé com o histórico perdido** — *não* era coberto por nada: o
  servidor responde `PONG`, o middleware autentica, e a blacklist que deveria
  estar lá não está. Aqui o serviço opera em fail-open de fato, por ausência do
  dado e não por escolha. A persistência é o que fecha esse caso.

A segunda coisa que a fase decide é **não** fazer backup do Redis, e isso é
decisão, não omissão. Um restore de dump devolveria o passado errado: as
blacklists do dump podem ser anteriores a revogações mais novas, e o contador de
versão de sessão antigo faria tokens revogados depois do dump parecerem válidos.
O que salva o caso é a propriedade de projeto — o Redis é regenerável por design
(quem precisa voltar faz login novo) — e o que a persistência protege é o
intervalo entre o logout e o próximo login, onde o cliente já foi avisado de que
saiu. O Mongo é o que tem backup, porque é o que não se regenera. Snapshots de
Redis ficam registrados para diagnóstico forense, nunca para restore de serviço.

Resta por decidir (e fica registrado como pendência, não implementado): se o
**volume** do Redis for destruído — falha de disco, `docker volume rm`,
reposição de VM a partir de snapshot antigo —, o serviço volta sem histórico de
revogação e falha aberto de verdade. Fechar isso exige tirar a revogação de um
único nó: segundo Redis com réplica e promote manual, ou gravar o carimbo de
revogação também no Mongo, que já é a fonte de verdade e já tem backup. As duas
mudam o modelo de operação, e é por isso que são decisão de fase, não
detalhe de implementação. Até lá, `npm run test:redis` prova no ambiente de
teste que a revogação sobrevive ao restart, e é o teste mais barato que existe
contra alguém desligar a persistência sem querer.

Uma nota de método, porque ela mudou o desenho do teste: a ACL da aplicação é
`+@all -@admin -@dangerous`, e tanto `CONFIG GET` quanto `INFO` estão em
`@admin`. A primeira versão do drill perguntava a configuração ao servidor e
recebia `NOPERM` — vazio. A conferência passou a ser feita no sistema de arquivos
do volume e no comportamento observável, que é o que não depende de permissão
nenhuma.

### D23 — A fonte da verdade do backup de configuração é o container em execução, não o arquivo em disco

A 2.3 fecha um buraco silencioso e específico do rollback: o deploy guarda a
imagem anterior e, na volta, sobe essa imagem com o `.env.prod` que está em
disco no momento — o da versão nova. Configurar é mais do que "ter o arquivo":
é ter o arquivo QUE RODAVA, com as chaves que a imagem usava. Um backup
ingênuo que copie o `.env.prod` do disco captura uma configuração que nunca
foi ao ar.

A decisão, em duas partes:

1. **O backup lê o container, não o host.** `backup-config.sh` resolve o
   container pelos labels do compose e tira de `docker inspect` o ambiente
   interpolado em execução (`env` + limites do compose com `${X}` e
   `${X:-...}`), os arquivos que o compose monta, o env file original e as
   referências da imagem (`image_ref`, `image_id`). O material de segredo é
   coletado por `docker cp` do container — em produção os arquivos são
   `600` do uid 1001/999 e o operador do backup pode não ter leitura deles no
   host; o daemon, não. A assinatura disso é o controle negativo do drill:
   editar o env file sem redeployar deixa disco e container divergidos, e o
   restore tem de devolver o valor EM EXECUÇÃO, não o do disco editado.
2. **Restaurar bytes é só metade; restaurar o dono é a outra.** O `docker cp`
   descarta uid/gid (extrai como o usuário corrente). O backup registra no
   manifest o dono/modo reais de cada segredo — a mesma primitiva de container
   descartável que `generate-*-secrets.sh --for-container` usa — e o restore
   os reaplica. Sem isso, "restaurar" devolveria arquivos que o app (uid 1001)
   e as dependências (uid 999) não conseguem abrir, e o deploy seguinte cairia.

Consequências que são decisão, não detalhe:

- **O archive é autônomo e verificável.** Cifrado gpg AES-256 (passphrase em
  arquivo, nunca argv, mesmo regime da D21), manifest interno com sha256 de
  cada arquivo (`--match-tag`/`--match-image` usam só o `.meta.json`, sem
  segredos), `--check` para alertar backup velho, retenção por poda e RPO
  padrão 24h. O rollback restaura pelo tag ou pela imagem: o archive sabe de
  qual imagem a configuração era.
- **Os deploys trancam o ciclo.** `deploy.sh` taggeia a config com o mesmo tag
  do backup de imagem; `remote-deploy.sh` taggeia pelo digest da versão
  (`deployed-<digest>`) e, após o sucesso, snapshota a config da versão que
  subiu. No rollback, a config É restaurada ANTES do `docker compose up -d`
  se passphrase estiver configurada; em `remote-deploy.sh` a passphrase é
  obrigatória — sem ela, o deploy não captura a config em execução e o
  rollback voltaria só a imagem, o buraco desta fase.
- **O drill usa um stack com os MESMOS alvos de mount de produção**
  (`/run/secrets` e `/run/secrets-deps`, binds read-only, envs `*_PATH`). Um
  gate de CI (`tests/unit/config-backup-policy.test.ts`) trava essa
  semelhança e o acoplamento dos deploys: se o drill passar a provar um layout
  que ninguém roda, o portão fica vermelho antes do próximo deploy.

O que a fase **não** faz: não substitui o backup do Mongo (D21), não vira
hosting de chave gerenciada (KMS/etc.), e não resolve a D20 — se o volume do
Redis for perdido, a revogação volta sem histórico, que continua pendência
declarada.



## 7. O que este serviço não é

- Não é MFA, recuperação de conta, verificação de e-mail nem federação.
- Não é auditoria de conformidade: o histórico é por processo e em memória.
- Não é WAF: a detecção de padrão sinaliza, não bloqueia.
- Não é controle de acesso: há um único papel implícito (usuário) e um segredo
  administrativo compartilhado.

Cada item acima é um limite de escopo declarado, não um defeito escondido.

---

### D24 — A sonda Redis de liveness precisa de chave única por chamada, não uma chave fixa

Medindo a capacidade da Fase 3.1, `/health` devolveu 503 para **173 de 300
requisições simultâneas**, com o Redis reportando "conectado" e a degradação
dizendo que ele não respondia a leitura/escrita. Não era o Redis: era a
própria sonda. `src/infrastructure/cache/connection.ts` usava a chave fixa
`__health_check__`, e como a verificação é "escreve e lê de volta comparando",
N chamadas concorrentes se sobrescreviam. Cada uma lia o valor da outra e
concluía, falsamente, que o Redis perdera a escrita. O efeito era duplo e ruim:
o `/health` mentia sobre a dependência, e o alarme disparava em vazão — que é
exatamente a hora em que alguém não confia no alerta.

A decisão: **chave e valor únicos por chamada.** A chave carrega
`${process.pid}` e um contador de sequência da própria instância, e o valor
carrega `${Date.now()}` mais a sequência — o timestamp sozinho não bastava,
porque duas sondas podem cair no mesmo milissegundo, o que é o caso comum
quando o processador é rápido. Três propriedades, cada uma com um motivo:

1. **Concorrência segura.** Duas sondas nunca dividem chave, então uma não
   pode "envenenar" a leitura da outra. Regressão em
   `tests/unit/redis-cache.test.ts`: 50 sondas concorrentes no mesmo processo
   — que falha contra a versão anterior — mais unicidade de chave e de valor.
2. **Isolamento entre processos.** O `pid` no nome impede que dois workers do
   cluster, cada um com seu contador começando em zero, se confundam. Sem o
   `pid`, `__health_check__:<pid>:0` colidiria entre réplicas.
3. **Chave descartável, sem prefixo de ambiente.** O nome continua sendo
   distinguível de chave de aplicação (prefixo `__`) e a sonda continua
   escrevendo em Tempo *efêmero* com TTL próprio, então não há estado a
   limpar e uma escrita perdida numa falha de escrita só custa uma iteração do
   liveness, não inconsistência.

A consequência de não ter feito isso antes é a lição registrada: **a verificação
de saúde é código que roda em produção e precisa dos mesmos testes de
concorrência do resto do serviço.** Ela foi a última parte do sistema a ser
exercitada sob carga real, e a única que não aguentou.

### D25 — Reuso de refresh revoga a sessão inteira, inclusive em corrida

O refresh é de consumo único (`SET NX`), mas rejeitar apenas a segunda
requisição deixa uma ambiguidade perigosa: o servidor sabe que o mesmo segredo
foi apresentado por dois clientes e não consegue distinguir qual deles é o
legítimo. A política padrão é encerrar todas as sessões do usuário quando o
marcador já contém `rotated`. A resposta ao refresh reutilizado continua sendo
401 (`REFRESH_TOKEN_REUSED`); se o Redis não confirmar a revogação, a resposta é
503 (`REVOCATION_UNAVAILABLE`), sem fingir que a sessão foi encerrada.

O adaptador associa o `userId` verificado ao erro interno, e o caso de uso
incrementa `user_session_version:<userId>`. O par vencedor de uma disputa
concorrente conserva o `sv` do refresh original ao ser emitido: reler a versão
depois da revogação poderia criar um token já com a nova versão e fazê-lo
sobreviver à detecção. O sink publica `kind=security`,
`auth_code=TOKEN_REUSE_DETECTED`, `auth_outcome=reused` e `severity=high`, além do
evento normal `token_refresh`. O manifesto `/observability` agrega o sinal em
`security.auth_events.credential_compromise` (`likely_compromised`, gravidade,
contagem e horário da última detecção). A contagem é local ao processo; ela não
representa uma soma global entre workers ou réplicas.

O comportamento agressivo pode ser desativado explicitamente com
`AUTO_REVOKE_ON_REUSE=false` para clientes que fazem retry automático; nesse
modo o refresh repetido ainda recebe 401 e o evento continua sendo publicado.
O padrão é revogar (`true`). A cobertura inclui unidade para revogação,
opt-out, indisponibilidade e evento, além do E2E concorrente que exige que o
access token do vencedor também seja recusado.

### D26 — Limites HTTP do Node complementam a contenção da borda

Mesmo atrás do proxy reverso, o próprio Node limita quanto tempo um socket pode
consumir esperando headers ou corpo. Os dois listeners (HTTP e HTTPS) aplicam
a mesma política: `HTTP_HEADERS_TIMEOUT=15000`,
`HTTP_REQUEST_TIMEOUT=30000`, `SERVER_TIMEOUT=30000`,
`HTTP_KEEP_ALIVE_TIMEOUT=5000`, `HTTP_CONNECTIONS_CHECKING_INTERVAL=1000`,
`HTTP_MAX_REQUESTS_PER_SOCKET=1000` e `HTTP_MAX_HEADERS_COUNT=100`. O timeout de
headers nunca excede o timeout do request; valores de ambiente inválidos ou
não positivos voltam ao default.

O body JSON já tem limite de 100kb e o disjuntor de requests em andamento roda
antes do parser. A regressão `tests/unit/http-server-limits.test.ts` verifica a
configuração do servidor e envia headers parciais por TCP, esperando 408 sem
Docker. Isto reduz sockets lentos no app, mas não substitui os limites de
conexão/body e a terminação TLS na borda; a integração do proxy ainda aguarda
validação de Docker.

### D27 — Nginx é a única entrada pública e sobrescreve o IP encaminhado

No Compose de produção, só `auth-proxy` publica portas. O serviço da API expõe
3000 apenas na `auth-network`; Mongo e Redis continuam isolados em
`deps-network`. O nginx termina TLS com `fullchain.pem` e `privkey.pem` montados
de diretório externo ao repositório, redireciona HTTP para HTTPS e aplica
20 req/s por IP com burst 40, 40 conexões por IP, body máximo de 100kb e
timeouts de 10s para headers/body. O keep-alive de borda é 10s.

O nginx substitui `X-Forwarded-For` por `$remote_addr`; o app confia em um salto
(`TRUST_PROXY=1`). Assim, um cliente não escolhe o IP usado pelo rate limit. O
upstream resolve dinamicamente `auth-service` no DNS do Docker e usa falha
passiva (`max_fails=2`, `fail_timeout=5s`). Nginx OSS não verifica
`/readiness` ativamente nem consulta o estado `unhealthy` do Compose; não
prometemos remoção por readiness até haver um mecanismo ativo ou uma prova real.
O Compose configura `net.core.somaxconn=4096`, backlog Node 1024 e `nofile` 8192
para a API/4096 para nginx. `nginx -t`, TLS, limites do host e `--scale` foram exercitados em Docker por
`npm run test:ddos` (nginx sobe, TLS vale, o upstream resolver alcança as três
réplicas) e por `npm run test:replica-session`, que prova que uma revogação
feita pela borda é obedecida por cada réplica. **Failover ativo continua sem
prova**: nginx OSS não remove upstream por `/readiness` e não lê o estado
`unhealthy` do Compose, e nenhuma execução mediu a troca de um container por
outro durante tráfego. `/liveness` e `/readiness` não recebem `limit_req` nem
`limit_conn`; o disjuntor do app também já os exclui, evitando que sobrecarga
converta a própria sonda em motivo para reinício.

O runner `scripts/ddos-survival-test.mjs` usa o perfil efêmero do Compose de
resiliência, destrói volumes no fim e só aceita loopback. Ele gera credenciais e
certificado temporários, mede os contêineres envolvidos e nunca aponta para o
Compose de produção por padrão.

### Cobertura do modelo de ataque

| Ameaça | Controle/prova | Estado |
| --- | --- | --- |
| A1/A2 roubo e reuso de token | `sv`, consumo único, revogação automática e T1–T6 | passou em memória **e** contra o Redis do compose em ES256, com revogação por identidade atravessando réplicas |
| A3 credential stuffing | login genérico e T5; hashes salgados não permitem correlação barata entre contas | limite aceito e documentado |
| A4 força bruta distribuída | rate limit por IP/conta e cenário XFF no k6 através do proxy | medido: 4124 respostas 429 com XFF forjado, limite que cede em vez do serviço |
| A5 flood HTTP | limites nginx/app, thresholds k6, liveness e recuperação | medido: zero 5xx e zero reinício, p95 de liveness 3,2 → 4,5 ms |
| A6 Slowloris | timeout de headers Node/nginx e socket parcial | medido na borda: 20/20 conexões encerradas no prazo |
| A7 oversized/malformados/XFF forjado | parser e body limits, proxy sobrescreve XFF, probes 400/413 | medido: 400 e 413 no app real, com o XFF sobrescrito pelo proxy |

---

## Referências

- Fluxo de requisição e arquitetura: [`ARQUITETURA.md`](ARQUITETURA.md)
- Política de revogação, sessão e senha: [`../README.md`](../README.md)
- Dashboard de segurança: [`DASHBOARD_SEGURANCA_GUIA.md`](DASHBOARD_SEGURANCA_GUIA.md)
- Custo medido de hash e latência de `/login`: [`metricas.md`](metricas.md)

### D28 — Mongo single-node com backup é o limite explícito desta topologia

O Compose mantém um único MongoDB. Escalar a API atrás do nginx não transforma
o banco em HA; o nó Mongo continua sendo SPOF. Para o perfil atual, de uma
coleção `users` e com backup cifrado/restore exercitado, a decisão é aceitar
esse limite com RPO 24h em vez de adicionar três membros que exigiriam operação
de eleição, monitoramento e drills próprios. Perda do nó significa restaurar o
backup; não há failover automático. Se HA virar requisito, replica set de três
membros e teste de eleição/reconexão serão uma mudança explícita.

### D29 — O rate limit por IP é o primeiro limite a ceder; SYN e amplificação ficam na borda

Medido em `npm run test:ddos` com três réplicas atrás do nginx (números em
[`metricas.md`](metricas.md#6-contenção-na-borda-sob-flood-fase-62)): 4124
respostas 429, zero falha de liveness, zero 5xx, zero reinício, Slowloris
20/20 encerrado no prazo, JSON malformado 400 e payload de 10 MB 413.

O que cede primeiro é o **orçamento de requisições por IP** — e cede de
propósito. A decisão é explicitar a ordem, porque a ordem é o contrato: se a
contenção de aplicação não bastar, o próximo a ceder é o orçamento de login por
conta, e depois a disponibilidade. Nunca o contrário. Um limite que nunca cede é
um limite que não existe, e um serviço que continua respondendo 5xx sob flood
trocou contenção por indisponibilidade.

A mesma medição fixa o que **não** está provado. O k6 fala HTTP de aplicação,
com conexão estabelecida e handshake TLS completo: ele não produz SYN sem
handshake nem pedidos amplificados de terceiros. "O flood foi absorvido" é
verdadeiro para A5 (HTTP) e A6 (Slowloris) e **falso** se generalizado. SYN
flood e amplificação são contidos no kernel, no backlog e na rede do provedor —
antes de existir requisição para o rate limit agir. Por isso eles não constam do
modelo A1–A7, e o que o serviço oferece é só configuração defensiva já declarada
no Compose (`somaxconn=4096`, backlog 1024, `nofile` 8192/4096,
`max_fails=2`/`fail_timeout=5s`).

Também fica registrado que medir por `process.pid` produz prova falsa: as três
réplicas responderam `pid: 8` e a contagem de réplicas colapsou. A identidade de
réplica vem de `service.instance_id` do `/observability`, e o parser do
`--summary-export` do k6 lê `metrics.X.count`, não `metrics.X.values.count`.
Ambas as correções estão em `scripts/ddos-survival-test.mjs` com guarda de
mutação em `tests/unit/ddos-survival-driver.test.ts`.

### D30 — O teto de concorrência de argon2 é um semáforo aplicado, não uma conta

O serviço sempre teve um número para "quantos hashes de senha simultâneos cabem":
`m × 8` = 512 MiB contra 768 MiB de teto do container. Esse número entrava na
validação de arranque e **não em mais nada**. Nenhum código o aplicava em tempo
de execução — o orçamento dizia 8 e a máquina fazia o que a fila de requisições
deixasse, que no pior caso eram 48 operações observadas com o teto declarado em 4.

A divergência não era decorativa. A §5 de [`metricas.md`](metricas.md#5-calibrando-o-limite-de-requisições-em-andamento)
mediu exatamente isso e concluiu que **requisição em andamento não é memória em
andamento**: o disjuntor de 1024 conta requisições abertas, uma requisição
esperando vaga custa quase nada, e um burst de 200 logins atravessa 1024 sem
encontrar o limite enquanto cada hash aloca 64 MiB fora do heap do JS.

A decisão é um semáforo próprio de operações argon2id
(`src/shared/utils/argon2Limiter.ts`), aplicado em `PasswordHasher.hash()` **e**
`.compare()`, com configuração `securityConfig.passwordHash.concurrency = { limit,
maxQueue }` (`ARGON2_MAX_CONCURRENCY` default 8, `ARGON2_MAX_QUEUE` default 64),
validada no arranque e publicada em `getConfigSummary()`.

*Recusado:* usar o `inFlight` como se cobrisse o caso. Ele é proteção de HTTP e
precisa continuar sendo: `/profile` ocupa uma vaga dele e zero do semáforo. Trocar
uma proteção pela outra deixaria as duas faltando.

*Recusado:* o limite como recusa imediata. Um hash argon2 é trabalho legítimo de
um usuário legítimo; recusá-lo porque chegou atrás de outros oito só troca memória
por erro. A política é **fila FIFO com profundidade limitada** — FIFO porque
LIFO faria um burst empurrar as operações mais antigas, que é o pior caso de
latência e o mais fácil de não perceber. Só fila cheia recusa, e a recusa é
`503 ARGON2_OVERLOADED` com `Retry-After: 1`.

*Recusado:* `401` ou `400` na saturação. Erro de capacidade não é erro de
credencial, e dizer 401 ao cliente affirmaria que a senha dele está errada. O
código é classificado como `unavailable` em `AUTH_OUTCOMES`, ao lado de
`REVOCATION_UNAVAILABLE`, pelo mesmo motivo.

O ponto que fecha a conta: a validação de memória do arranque passou a usar **o
mesmo número que o semáforo impõe**. Antes ela era verde com a máquina estourando
o container; agora ela descreve o que pode acontecer de fato.

### D31 — Revogar é anterior a persistir, e o fracasso não é do usuário

Duas operações gravam ou apagam a identidade do usuário depois de dependerem da
revogação, e as duas faziam o inverso: persistiam primeiro e revogavam depois.
`revokeUserTokens()` devolvia `boolean` e ninguém checava.

O estado que isso permite não tem volta:

```text
senha nova gravada  ->  sucesso
revogação de sessão ->  falha silenciosa
```

O usuário acredita que trocou a senha, todas as sessões antigas seguem válidas
até expirarem, e nada no sistema registra que houve problema. Na exclusão de
usuário a consequência é pior: o token sobrevive à conta que o emitiu.

A ordem é invertida nos dois casos, e o valor de `revokeUserTokens` é conferido
explicitamente:

| operação | ordem | revogação não confirmada | revogação ok, escrita falha |
| --- | --- | --- | --- |
| `changePassword` | hash novo → revoga → grava | `REVOCATION_UNAVAILABLE` / `503`, **senha intacta** | `PASSWORD_CHANGE_NOT_PERSISTED` / `503`, sessões encerradas e senha antiga ainda valendo |
| `deleteUser` | revoga → apaga | `REVOCATION_UNAVAILABLE` / `503`, **usuário permanece** | `USER_DELETE_NOT_PERSISTED` / `503`, sessões encerradas e conta de pé |

O estado da coluna da direita é seguro e é registrado em log: as sessões já foram
encerradas, o que resta é a senha antiga valendo — o estado normal de uma troca
que não chegou a acontecer, com o contorno de refazer a operação. O estado
inverso não tem contorno nenhum. O caminho opcional de histórico de senha que
falha (`PASSWORD_HISTORY_UNAVAILABLE`) segue o mesmo padrão: pergunta de
segurança sem resposta é fail-open, e fail-open aí significa histórico de senha
que deixa de valer.

*Recusado:* tratar falha de revogação como erro de credencial (401/400). A senha
não é o problema e a infraestrutura é; devolver 400 faria o cliente culpar o
usuário por uma queda de Redis.

`refreshUserTokens` fecha o mesmo conjunto pela outra ponta: a existência do
usuário é conferida **antes** de rotacionar, não depois. Um refresh token
assinado não é prova de que a conta existe, e girar o token de um usuário apagado
gastaria a única credencial de renovação que ele tinha para então recusar a
emissão. O token órfão é revogado e a resposta é `USER_NOT_FOUND`. "Ativo" não é
verificável — `models/User.ts` não tem conceito de conta desativada, e
introduzi-lo seria funcionalidade nova, não correção de segurança.

### D32 — `uncaughtException` derruba o processo, sem exceção por palavra

O handler de `uncaughtException` carregava uma isenção: erros cuja mensagem
contivesse `forEach` eram registrados e o processo seguia no ar. A justificativa
era "não derrubar o serviço por uma exceção de biblioteca de métricas".

A isenção nunca teve o efeito pretendido, e a descoberta vale mais que a remoção:
`forEach` aparece na mensagem de **qualquer** `TypeError` de domínio. A mesma
falha com uma palavra a mais ou a menos decidia se o processo sobrevivia — o que
significa que a regra nunca foi sobre métricas, e sim sobre coincidência de
texto.

*Recusado:* manter a isenção "só para biblioteca de métricas". Não há como
distinguir a origem pela mensagem, e um `uncaughtException` significa que uma
exceção escapou do fluxo normal: o processo pode estar em estado inconsistente, e
seguir answering requisições é o pior desfecho possível.

Hoje `uncaughtException` e `unhandledRejection` registram o erro e entram em
graceful shutdown, e o supervisor reinicia. `gracefulShutdown` tem trava de
idempotência: sem ela, um SIGTERM seguido de um `uncaughtException` abria duas
rotinas — dois `server.close()`, dois `mongoose.close()`, dois timers de
force-close — e o segundo `close()` numa conexão já fechada lançava, caía no
`catch` e chamava `exit(1)` no meio do encerramento limpo.

O código de saída distingue crash de encerramento pedido: `SIGTERM`/`SIGINT` saem
com **0**, `uncaughtException`/`unhandledRejection` saem com **1**. A
justificativa não é "garantir o reinício" — Docker `restart: unless-stopped` e
PM2 com `autorestart` no default reiniciam em qualquer código de saída, então o
`1` não é o que mantém o processo no ar aqui. Ele evita que uma queda por estado
inconsistente seja reportada como parada bem-sucedida por alertas baseados no
código de saída, e é o que impediria a sobrevivência em supervisors que
distinguem sucesso de falha (systemd `Restart=on-failure`, Kubernetes).

### D33 — `token_type` é a separação entre access e refresh, em qualquer algoritmo

A separação entre access e refresh descansava **inteiramente** no fato de os
segredos HS256 serem diferentes. Isso não é propriedade do token: é consequência
de como o HS256 funciona — e o construtor cai para `JWT_SECRET` quando
`JWT_REFRESH_SECRET` não vem, com warning e não com erro.

Nesse estado os dois signers assinavam com o mesmo material e a verificação de
tipo era ignorada, porque o `early return` que existia só conferia a claim em
ES256. Reproduzido antes da correção, com `JWT_REFRESH_SECRET` ausente:

```text
refresh entregue como access  ->  ACEITOU. id=u1 token_type=refresh exp=+7d
access entregue como refresh  ->  ACEITOU. token_type=access
```

Um refresh de 7 dias servindo como Bearer em rota de access, e um access de 15
minutos servindo onde refresh é exigido — sem comprometimento de chave, só com o
token que o próprio dono recebeu.

A claim `token_type` passou a ser conferida **sempre**, em `verifyAccessToken` e
`verifyRefreshToken`, nos dois algoritmos. A propriedade `reliesOnTokenType` foi
removida de `TokenSigner`: ela descrevia o comportamento antigo e, deixada no
lugar, seria armadilha para quem a lidasse.

*Recusado:* aceitar token sem a claim por compatibilidade com "tokens legados".
O comentário antigo dizia que tokens legados sem a claim continuavam válidos, o
que é aceitar exatamente o estado que a separação por segredo deixou passar. Não
há token legado a preservar na 1.0.0.

O que a separação por segredo continua sendo é uma **defesa em profundidade**: com
segredos distintos a recusa vem da assinatura, e a claim nem chega a ser
consultada. A diferença importa porque os testes não podem afirmar a mesma coisa
nos dois HS256 — com segredo compartilhado a assinatura passa (os dois tokens têm
a mesma assinatura válida sob o mesmo segredo) e a claim é a única barreira.

### D34 — Login e registro pagam o mesmo custo nos dois caminhos

O `/login` já respondia `Credenciais inválidas` tanto para usuário inexistente
quanto para senha errada: a mensagem não distinguia. O **tempo** distinguia, e era
o único canal que sobrava. `authenticateUser` retornava logo depois de
`findByUsername` responder `null`, sem argon2id para rodar — uma senha errada
custava um `verify` de ~27 ms medidos e username inexistente voltava em
microssegundos. Uma requisição por username, sem errar senha nenhuma, bastava
para mapear a base inteira.

O `/register` tinha o mesmo furo na forma espelhada: `exists()` verdadeiro
retornava antes de `hash()`. E ali a mitigação **não é decorativa**, porque o
controller já responde 400 genérico tanto para conta nova quanto para username
repetido: o tempo era o único oráculo restante, e estava aberto.

A porta `CryptoService` ganhou `compareDummy(plainText): Promise<false>` —
obrigatório, não `?`, para que o compilador obrigue qualquer implementação a
ter. `PasswordHasher` mantém um hash descartável gerado **uma vez por instância**
e com os parâmetros que ele próprio usa.

*Recusado:* constante fixa de hash no domínio. Passaria a divergir no dia em que
alguém mudasse `m`, `t` ou `p`, e a mitigação viraria decorativa.

*Recusado:* descarte regenerado a cada requisição. O caminho "não existe" ficaria
**mais** lento que o de usuário real — o mesmo oráculo com o sinal invertido — e
viraria amplificador de carga para quem não tem conta. O descarte é rejeitado
explicitamente e a promessa guardada é descartada: cache permanente de falha
tornaria definitiva a devolução rápida do caminho "não existe" sem nada apontar
para o motivo.

Medição com `m=16384,t=2,p=1`, n=15, duas amostras descartadas:

```text
login  / usuário inexistente   p50 23.52ms  p95 25.88ms  p99 25.88ms
login  / senha errada          p50 23.23ms  p95 24.22ms  p99 24.22ms
razão p50 inexistente/errada = 1.012

registro / username repetido   p50 23.68ms  p95 26.36ms  p99 26.36ms
registro / conta nova          p50 24.30ms  p95 25.58ms  p99 25.58ms
razão p50 repetido/novo = 0.974
```

O objetivo declarado nunca foi "timing idêntico", e sim reduzir a diferença
explorável. O número que sustenta o uso de um `verify` como equalizador no
registro — cujo caminho real é um `hash()` — é a razão entre `verify` e `hash` nos
mesmos parâmetros: 1.013 em 8192/t=1, 0.974 em 16384/t=2 e 0.978 em 19456/t=2.

**Pendência declarada:** `AuthService.updateUserProfile` tem a mesma forma
(`exists()` → retorno imediato, sem argon2) e **não** foi corrigido. O endpoint
exige sessão válida — quem enumera já tem conta — e a decisão de projeto é que a
atualização de perfil reporte conflito de username explicitamente. Corrigir o
tempo sem mudar a resposta HTTP seria trabalho invisível; mudar a resposta é
decisão de API. Registrado como pendência, não esquecido.

### D35 — O gate de dependências é o `audit-ci`, e a allowlist tem duas exceções

O CI rodava `npm audit --audit-level=moderate` **e** `audit-ci` no mesmo job. O
`npm audit` cru não tem mecanismo de exceção: ele reprova por qualquer advisory
`moderate+`, inclusive as que o projeto já decidiu aceitar. Com `braces` na
allowlist, o job ficava vermelho por uma decisão já tomada — sinal virou ruído. O
step cru foi removido; o `audit-ci` é o gate único, porque é ele que aplica a
política.

Cada exceção é por **advisory** (nunca por pacote), no formato `NSPRecord` que o
`audit-ci` de fato honra (`{ active, expiry, notes }`), com validade datada. São
duas:

- `GHSA-vfj7-8cjw-p6xm` (`braces <=3.0.3`): sem versão corrigida publicada.
- `GHSA-hp3w-g68c-fv3c` (`sprintf-js`): sem versão corrigida publicada, e o único
  caminho é de `devDependencies` (`jest` → `babel-plugin-istanbul` →
  `@istanbuljs/load-nyc-config` → `js-yaml@3` → `argparse@1` → `sprintf-js`), fora
  da árvore de runtime e da imagem final.

*Recusado:* allowlistar a advisory `critical` `GHSA-jqcg-44mw-7w3h`
(`proxy-addr@2.0.7`, IP spoofing via IPv6 mapeado), transitiva do `express`.
Havia correção (`2.0.8`) e o código é de **runtime**: aceitar seria escolher uma
falha com conserto pronto. Foi corrigida por bump pontual do `proxy-addr`,
mantendo `express@5.1.0` e sem o churn de um `npm audit fix` completo.
Critical com correção não é exceção, é trabalho.

`tests/unit/audit-ci-gate.test.ts` compara o conjunto `moderate+` da árvore com o
conjunto allowlisted — **nem mais, nem menos** — então advisory nova reprova e
exceção que o tempo resolveu aparece como sobra a remover.
