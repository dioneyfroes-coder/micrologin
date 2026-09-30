# Rotação de chaves e segredos

Este runbook cobre tudo que o micro login precisa girar: a chave de assinatura
ES256, o pepper das senhas e as senhas do MongoDB e do Redis. Cada seção traz a
ordem exata dos passos, porque **a ordem errada é o que derruba o serviço** — e
não a rotação em si.

Duas regras valem para todas:

1. **Um segredo só é rotacionado quando existe um caminho de volta.** Guarde o
   material antigo até a janela fechar e a verificação passar. Rotação sem
   caminho de volta é indisponibilidade com passos extras.
2. **O material nunca passa por arquivo versionado.** Chaves e senhas vivem em
   arquivo montado, secret manager ou KMS — nunca em `.env` commitado, nunca em
   variável de ambiente de shell compartilhada, nunca em `argv` de processo.

---

## Índice

| Segredo | Janela | Script | Verificação |
| --- | --- | --- | --- |
| [Chave ES256](#1-chave-de-assinatura-es256) | sim (chave anterior) | `scripts/generate-jwt-keys.sh` | `tests/unit/jwt-signer.test.ts` (janela e rejeição de `kid` desconhecido) |
| [Pepper](#2-pepper-das-senhas) | sim (pepper anterior) | configuração | `tests/unit/password-hasher.test.ts` (envelope `pN:` e reescrita no login) |
| [Senha do Redis](#3-senha-do-redis-com-janela) | sim (ACL com 2 hashes) | `scripts/rotate-dependency-secrets.sh` | passo 4 do `test:infra`, `tests/unit/dependency-secrets-rotation.test.ts` |
| [Senha do Mongo](#4-senha-do-mongo-sem-janela) | **não** | `scripts/rotate-dependency-secrets.sh --mongo-only` | passo 5 do `test:infra`, `tests/unit/dependency-secrets-rotation.test.ts` |
| [Chave privada fora do repositório](#5-guarda-da-chave-privada) | — | — | `npm run test:secrets` |

---

## 1. Chave de assinatura ES256

O token carrega `kid` no header. O validador aceita a chave atual e, se
`JWT_ES256_PREVIOUS_*` estiver definida, também a anterior. A janela existe
porque o token já emitido continua circulando depois do deploy: revogar a chave
antiga sem esperar o TTL derruba sessões que ainda são válidas.

### Rotação

```bash
# 1. Par novo, com o kid novo. NUNCA sobrescreva o par antigo.
scripts/generate-jwt-keys.sh /run/secrets/jwt 2026-q4 --for-container

# 2. Up Publica. A pública pode ir para o repositório, a privada não.
#    JWT_ES256_PRIVATE_KEY_PATH=/run/secrets/jwt/jwt-es256-private.pem
#    JWT_ES256_PUBLIC_KEY_PATH=/run/secrets/jwt/jwt-es256-public.pem
#    JWT_ES256_KID=2026-q4
# 3. Janela: a chave anterior continua valendo.
#    JWT_ES256_PREVIOUS_KID=2026-q3
#    JWT_ES256_PREVIOUS_PUBLIC_KEY_PATH=/run/secrets/jwt/jwt-es256-public.pem
#    (a PEM anterior é PÚBLICA: só a assinatura antiga precisa ser verificada)

docker compose up -d --force-recreate auth-service
```

### Fechar a janela

Só depois de `max(TTL do token, tempo de propagação)`. Um token assinado com
`2026-q3` ainda é aceito enquanto `JWT_ES256_PREVIOUS_KID` existir; ao remover,
ele passa a ser rejeitado — e é isso que a janela estava evitando.

```bash
# Remove JWT_ES256_PREVIOUS_KID e JWT_ES256_PREVIOUS_PUBLIC_KEY, sobe de novo
# e só então apaga o par antigo:
rm /run/secrets/jwt/jwt-es256-private.pem.bak
```

Regras que o validador impõe (`src/interfaces/config/appConfig.ts`): `KID` e
`PREVIOUS_KID` precisam ser diferentes, e quem define uma das chaves anteriores
precisa definir a outra. Par sem nome não rotaciona — ele troca a chave e invalida
tudo que estava no ar.

---

## 2. Pepper das senhas

O pepper entra no hash da senha, então ele é parte da senha: quem tem o hash e o
pepper tem a credencial original. Por isso o pepper muda com janela, e cada hash
guarda a versão do pepper que o produziu no envelope `p1:<hash>`, `p2:<hash>`.

```bash
# 1. Gera o pepper novo (fora do repositório) e sobe com os dois.
#    PASSWORD_PEPPER=<novo>  PASSWORD_PEPPER_VERSION=p2
#    PASSWORD_PEPPER_PREVIOUS=<anterior>  PASSWORD_PEPPER_PREVIOUS_VERSION=p1
# 2. Cada login reescreve o hash com o pepper novo; o login de quem não entra
#    há muito tempo continua verificando pela versão antiga.
# 3. Espera o TTL de expiração das senhas + a última conta ativa passar por um
#    login, e só então remove PASSWORD_PEPPER_PREVIOUS.
```

Sem `PASSWORD_PEPPER_PREVIOUS_VERSION`, o app não sabe qual pepper abre o
envelope e recusa o hash antigo: quem não faz a rotação em duas etapas perde o
acesso às contas existentes, e a conta está certa — o hash gravado não confere.

---

## 3. Senha do Redis (com janela)

O Redis aceita **duas senhas por usuário** no arquivo de ACL. É o único segredo
do serviço que tem janela de verdade, e é por isso que a rotação do Redis não
derruba ninguém.

```bash
# 1. Gera a senha nova, mantém a antiga válida e registra a anterior.
scripts/rotate-dependency-secrets.sh /run/secrets/deps --for-container
# 2. Recarrega o Redis (o app continua no ar com a senha antiga em memória).
docker compose restart redis
# 3. Depois que o app já usa a nova, encerra a janela.
scripts/rotate-dependency-secrets.sh /run/secrets/deps --close-window --for-container
docker compose restart redis
```

`--close-window` não se combina com `--mongo`/`--mongo-only` e o script recusa a
combinação em vez de executar só uma metade: quem pede as duas duas vezes
acredita que girou as duas.

O que o script garante, e o passo 4 de `npm run test:infra` prova contra o stack
real:

- a ACL recebe `user default off` e o usuário do app com os hashes de
  **nova e anterior** (`#<sha256> #<sha256>`), nunca senha em texto claro;
- `redis-previous-password` guarda a antiga só durante a janela e é removido no
  `--close-window`;
- a escrita é no mesmo inode (nunca `.tmp` + `mv`), porque o material é montado
  como **arquivo** e um bind mount de arquivo fica preso ao inode criado;
- com `--for-container`, o material fica legível por quem precisa (uid 1001 do
  app, uid 999 do Redis) e por mais ninguém — o usuário que provisionou perde o
  acesso de propósito, e o script faz a rotação por um container descartável em
  vez de exigir `sudo`;
- a prova ao vivo sobe um Redis efêmero e pergunta a ele, não ao arquivo: as
  duas senhas autenticam na janela, só a nova depois de fechá-la, e a errada é
  recusada.

O token novo da senha nunca é impresso: a rotação informa o caminho do arquivo.

---

## 4. Senha do Mongo (sem janela)

O Mongo **não** aceita duas senhas por usuário: `changeUserPassword` invalida a
anterior no mesmo instante. A ordem é obrigatória e não tem atalho:

```bash
# 1. Gera a senha nova no arquivo. Ainda não é a senha do servidor.
scripts/rotate-dependency-secrets.sh /run/secrets/deps --mongo-only --for-container

# 2. Troca a senha NO SERVIDOR, usando a nova. A partir daqui a antiga morreu:
#    o app ainda no ar com a credencial antiga só funciona se a janela de
#    reconexão do driver absorber a troca — não conte com isso.
#    O comando roda dentro do container e lê as duas senhas de lá dentro: no
#    host o material pertence ao container, e em argv a senha apareceria no ps.
docker exec <container-mongo> sh -c 'mongosh --quiet --host 127.0.0.1 \
    --username root --password "$(cat /run/secrets/deps/mongo-root-password)" \
    --authenticationDatabase admin \
    --eval "db.getSiblingDB(\"admin\").changeUserPassword(\"auth-service\", \"$(cat /run/secrets/deps/mongo-app-password)\")"'

# 3. Só agora o app sobe com a senha nova.
docker compose up -d --force-recreate auth-service
```

Pontos que já custaram tempo em outros incidentes:

- o usuário do app vive no banco **`admin`** (é onde o `readWrite` sobre o banco
  da aplicação é concedido, ver `docker/mongo/10-app-user.sh`). Sem
  `getSiblingDB('admin')` a troca responde "user not found" — e o `--eval` sem
  banco aponta para `test`;
- a senha entra por `argv` do `mongosh` no exemplo acima porque é o formato
  aceito pela ferramenta. Num host compartilhado, prefira o stdin do container
  ou um arquivo temporário em modo 600, e apague o rastro: `argv` aparece em
  `ps` para qualquer usuário da máquina;
- girar o **root** do Mongo é ato separado, e o app **nunca** deve usar essa
  credencial: o root lê qualquer banco, cria usuário e derruba o servidor. O
  material de rotação do app é o `mongo-app-password`, e o `mongo-root-password`
  fica fora do alcance do container da aplicação (o passo 3 do `test:infra`
  mostra que o app não consegue lê-lo);
- o passo 5 do `npm run test:infra` executa exatamente esta ordem contra o stack
  no ar e exige que um login real continue funcionando ao final.

---

## 5. Guarda da chave privada

O `.gitignore` já cobre `.resilience-keys/`, `.resilience-deps/`, `*.pem`,
`*secrets*` e `.env.prod`, e `npm run test:secrets` roda o gitleaks mais uma
varredura do que está versionado. Isso é a rede de segurança, **não** o lugar
onde a chave vive.

Hierarquia aceita, do melhor para o aceitável:

1. **KMS / secret manager** (AWS Secrets Manager, GCP Secret Manager, Vault).
   A chave nunca toca o disco, e o acesso é auditado e revogável.
2. **Arquivo em volume cifrado ou em diretório restrito do host**, montado por
   bind mount com `--for-container` para o dono certo (uid 1001). É o caminho
   do `test:infra`, e ele é real: sem o ajuste de dono o app recusa arrancar
   dizendo que a chave é obrigatória, quando na verdade ela está ali e ele não
   tem permissão de lê-la.
3. **Variável de ambiente injetada pelo orquestrador** (Kubernetes Secret, ECS,
   systemd). Aceitável para a chave pública; para a privada, evite: ela aparece
   em `/proc/<pid>/environ` e em dump de memória.

Regras que não dependem da ferramenta escolhida:

- a **pública** pode ser versionada; a **privada** nunca, nem em backup de
  repositório, nem em `.env.example` preenchido "só para testar";
- quem precisa da chave em produção tem acesso **de leitura** e sob identidade
  própria, não acesso ao servidor inteiro com a chave no disco;
- rotação de chave é evento auditado: quem, quando, qual `kid` entrou e qual
  saiu.

---

## 6. Verificação

```bash
npm run typecheck          # contrato de configuração (KID, pepper, etc.)
npm run test:unit          # rotação de JWT, pepper e senhas das dependências
npm run test:secrets       # gitleaks + varredura do versionado
npm run test:infra         # 13 passos, incluindo rotação de Redis e Mongo no ar
```

O `test:infra` é a prova que importa: ele não confere se o arquivo "parece"
certo, e sim se o serviço real aceita a credencial nova, continua aceitando a
antiga durante a janela, e derruba a antiga quando a janela fecha. Um runbook
que só não foi testado contra o stack real é um palpite com numeração de
passos.
