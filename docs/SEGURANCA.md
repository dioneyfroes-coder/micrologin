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
`trust proxy` configurado; sem isso, um cliente forja o IP e evade do rate limit
por IP. O `liveness` foi feito para não depender disso (ver README).

---

## 4. Ameaças e mitigação

| # | Ameaça | Mitigação | Onde |
| --- | --- | --- | --- |
| T1 | Credential stuffing / força bruta | rate limit por IP **e** por conta; login responde genérico | `advancedRateLimit.ts` |
| T2 | Enumeração de contas | `/login` não distingue usuário inexistente de senha errada; username normalizado | `AuthService`, `usernamePolicy.ts` |
| T3 | Roubo de refresh token | rotação de consumo único com `SET NX` antes de emitir; reuso é sempre 401 | `jwtTokenService.ts:refreshTokens` |
| T4 | Token revogado ainda aceito | blacklist por `jti` + `sv` de sessão; logout revoga o par inteiro | `AuthService.endSession` |
| T5 | Redis fora do ar | `SESSION_FAIL_OPEN=false` (padrão em produção) → `503`, nunca aceitar sem revogação | `isRevocationStoreReady` |
| T6 | SQL/NoSQL injection | sem SQL no projeto; Mongo comongoose sanitiza o objeto; input validado por tipo | `validation.ts` |
| T7 | XSS | API responde JSON, sem HTML; CSP restritiva; sem escaping na entrada | `helmet.ts` |
| T8 | Senha fraca ou reutilizada | mínimo 12, classe de caractere exigida, 5 hashes anteriores, troca exige a senha atual | `passwordPolicy.ts` |
| T9 | Timing attack na comparação de senha | a verificação do argon2id é de tempo constante por construção, e o `compare` não tem caminho de igualdade antecipada | `PasswordHasher` |
| T10 | Payload grande / DoS de parsing | limite de 100kb no `express.json`; rate limit antes do trabalho caro | `app.ts` |
| T11 | Clique em log de auditoria | usuário mascarado no console; refresh token nunca vai para o log de evento | `logToConsole` |
| T12 | Cliente forja identidade via proxy | `X-Request-Id` externo é recusado se não for UUID; IP confiável exige `trust proxy` | `requestLogger.ts` |

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

### D16 — argon2id (m=19MiB, t=2, p=1), único algoritmo do projeto
O hash de senha é **argon2id** nos mínimos da
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
A escolha saiu de medição, não de costume: na mesma máquina, no mesmo orçamento
de produção (2.0 CPU, 512 MB), o bcrypt cost 12 que rodava custava **365.7 ms
por hash contra 27.8 ms de argon2id 19MiB** — 13x mais caro e menos resistente,
por não ser memory-hard. No `/login` real o p95 caiu de **491 ms para 45.4 ms**
em c=1 e de **1868 ms para 191 ms** em c=8. Medições completas em
[`metricas.md`](metricas.md).

*Recusado:* a configuração que o roadmap propunha (`m=64MiB, t=3, p=4`). Era
**2.7x mais barata que o bcrypt 12 de hoje** (133.4 ms), então não era "mais
forte que o que já rodava" em CPU — e 4 logins simultâneos pedem **326 MB de
pico**, 64% do container e acima do limiar de 200 MB que o próprio `/health` usa
para marcar `warning`. Trocaria latência de login por risco de OOM.
*Recusado:* `p=4`. Dentro de 2.0 CPU derruba a latência de um hash (75 ms contra
133 ms), mas consome 4 threads por requisição: dois logins simultâneos já
ocupam o container. Os autores do Argon2 pedem `p=1` em servidor — `p>1` entrega
CPU ao atacante sem ganhar defesa proporcional. `m=46MiB, t=1, p=1` (a segunda
recomendação da OWASP) foi medida e fica em 208 MB com 4 logins: cabe, mas passa
do limiar de alerta sem comprar defesa equivalente à de 19MiB/t=2.

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
parâmetros**. Um hash gravado com m=19MiB continua verificável depois de a
configuração ir para 46MiB, e cada login bem-sucedido reescreve o hash nos
parâmetros em vigor, na mesma requisição. Sem tabela de migração, sem campo novo,
sem pedir troca de senha. O E2E cobre exatamente esse caminho gravando um hash
fraco direto no Mongo.

**Reescrever não é trocar senha.** `rehashPassword` grava só o hash: não toca em
`passwordHistory` nem em `passwordChangedAt`. Se o hash anterior fosse para o
histórico, a senha antiga voltaria a ser aceita logo depois; se
`passwordChangedAt` mudasse, o sistema afirmaria que o usuário trocou a senha
quando não trocou. Há teste para os dois.

**A reescrita não pode custar um login válido.** Ela é best-effort: se a escrita
falhar, o login é entregue, o aviso vai para o log e a reescrita volta no
próximo login. O usuário provou a senha; transformar falha de escrita em erro de
autenticação seria devolver 500 para quem fez tudo certo.

**Um bug que a troca expôs:** o schema do Mongo validava o campo `password` com
a política de senha em texto claro (12 a 72 caracteres). O hash argon2id tem
~100 e era **recusado na gravação** — registro devolvia 400. A política de senha
vale para o que o usuário digita (domínio, `passwordPolicy.ts`); o campo do banco
guarda hash e valida como hash. O teto de 72 bytes deixou de ser herança do
bcrypt: o argon2id não trunca, então ele virou escolha do serviço, mantido para
não deixar a entrada desnecessariamente grande.

### D17 — Pepper: mecanismo pronto, desligado por padrão
O pepper (HMAC-SHA256 antes do hash) foi **medido** e **implementado**, mas
**não vem ligado**. A decisão está no código — `PASSWORD_PEPPER` e
`PASSWORD_PEPPER_PREVIOUS_VERSION` — e o padrão é desligado.

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

## 7. O que este serviço não é

- Não é MFA, recuperação de conta, verificação de e-mail nem federação.
- Não é auditoria de conformidade: o histórico é por processo e em memória.
- Não é WAF: a detecção de padrão sinaliza, não bloqueia.
- Não é controle de acesso: há um único papel implícito (usuário) e um segredo
  administrativo compartilhado.

Cada item acima é um limite de escopo declarado, não um defeito escondido.

---

## Referências

- Fluxo de requisição e arquitetura: [`ARQUITETURA.md`](ARQUITETURA.md)
- Política de revogação, sessão e senha: [`../README.md`](../README.md)
- Dashboard de segurança: [`DASHBOARD_SEGURANCA_GUIA.md`](DASHBOARD_SEGURANCA_GUIA.md)
- Custo medido de hash e latência de `/login`: [`metricas.md`](metricas.md)
