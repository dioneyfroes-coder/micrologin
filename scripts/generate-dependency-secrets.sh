#!/usr/bin/env bash
# ===================================================================
# Gera os segredos das dependencias (MongoDB e Redis) - Fase 1.3
# ===================================================================
# Por que um script e nao "escreva a senha no .env": senha de banco e cache
# nao e configuracao, e material. Um .env versionado distribui a senha para
# quem le o repositorio, um dump de container a expoe em `docker inspect`, e a
# rotacao deixa de ser um ato para virar um acidente. Aqui cada segredo nasce
# em arquivo, com modo 600, e a senha nunca e impressa nem carregada em
# variavel de ambiente do container da aplicacao.
#
# Uso:
#   scripts/generate-dependency-secrets.sh <diretorio-de-saida> [--for-container]
#                                          [--skip-verify]
#
# Exemplo:
#   scripts/generate-dependency-secrets.sh ./secrets/deps --for-container
#
# --skip-verify pula a prova da ACL em um Redis de verdade (util onde nao ha
# docker, por exemplo num CI de unidade). Sem ele, a prova roda.
#
# Gera:
#   <saida>/mongo-root-password   senha do root, usada so na criacao do volume
#   <saida>/mongo-app-password    senha do usuario da aplicacao (D18)
#   <saida>/redis-password        senha do usuario de ACL da aplicacao (D18)
#   <saida>/redis-app.acl         arquivo de ACL do Redis, so com hash da senha
# e imprime na saida padrao as variaveis de ambiente que apontam para elas.
#
# Por que tres senhas e nao uma: o root do Mongo existe para criar os usuarios e
# nao e usado pelo servico; o usuario da aplicacao e o unico que o app deve
# conhecer. Um dump do processo do auth-service entrega o segundo, nunca o
# primeiro.
#
# Por que ACL e nao so `requirepass`: `requirepass` liga a senha no usuario
# `default`, e ai nao existe um login atribuivel a ninguem nem uma rotacao sem
# derrubar quem esta usando. Com `user default off` + um usuario nomeado, a
# conexao anonima e recusada e o acesso e identificavel.
#
# --for-container ajusta o dono do material para os uids que leem os arquivos
# dentro das imagens (uid 1001 do nodeuser no app, uid 999 no mongo e no redis).
# Sem isso, o modo 600 do usuario que provisionou vira arquivo ilegivel dentro do
# container: o servico recusa arrancar dizendo que a senha "nao esta
# configurada", quando ela esta ali e ele nao tem permissao de le-la.
# ===================================================================
set -euo pipefail

OUT_DIR="${1:-./secrets/deps}"

FOR_CONTAINER=0
VERIFY=1
for arg in "$@"; do
    case "$arg" in
        --for-container) FOR_CONTAINER=1 ;;
        --skip-verify) VERIFY=0 ;;
        -*) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

# uid do `nodeuser` no Dockerfile; 999 e o `mongodb`/`redis` das imagens oficiais.
APP_UID="${DEPS_APP_UID:-1001}"
DEP_UID="${DEPS_DEP_UID:-999}"
CHOWN_IMAGE="${DEPS_CHOWN_IMAGE:-node:22-alpine}"
REDIS_IMAGE="${DEPS_REDIS_IMAGE:-redis:7-alpine}"

# Nome do usuario da aplicacao nos dois lados. Nao e "root", "admin" nem
# "default": e o nome que aparece no log de auditoria do Mongo e no ACL LOG do
# Redis quando alguem mexer no banco.
APP_USER="${DEPS_APP_USER:-auth-service}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERRO: openssl nao encontrado. Instale openssl para gerar os segredos." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

MONGO_ROOT_PASSWORD_FILE="$OUT_DIR/mongo-root-password"
MONGO_APP_PASSWORD_FILE="$OUT_DIR/mongo-app-password"
REDIS_PASSWORD_FILE="$OUT_DIR/redis-password"
REDIS_ACL_FILE="$OUT_DIR/redis-app.acl"

for file in "$MONGO_ROOT_PASSWORD_FILE" "$MONGO_APP_PASSWORD_FILE" "$REDIS_PASSWORD_FILE" "$REDIS_ACL_FILE"; do
    if [ -e "$file" ]; then
        echo "ERRO: $file ja existe." >&2
        echo "Rotacionar uma senha e um ato deliberado: o usuario do Mongo so e recriado" >&2
        echo "em volume novo, e trocar a senha do Redis derruba o cache (aceitavel) e" >&2
        echo "as conexoes abertas (por isso a ACL mantem o usuario anterior na janela)." >&2
        echo "Apague o arquivo antigo depois de confirmar que o novo esta em uso." >&2
        exit 1
    fi
done

# 48 caracteres de base64url: ~288 bits de entropia. O comprimento nao e
# decoracao - e o que impede que a senha do banco caia na mesma lista de senhas
# mais testadas que as do usuario, que tem 12-72 caracteres e baixa entropia.
gen_password() {
    openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}

MONGO_ROOT_PASSWORD="$(gen_password)"
MONGO_APP_PASSWORD="$(gen_password)"
REDIS_PASSWORD="$(gen_password)"

# O Redis guarda a senha como SHA-256, nunca em texto claro. O arquivo de ACL
# fica no disco do host e no bind mount, entao o que vaza se vaza e o hash -
# que ainda assim resiste a dicionario, e pode ser lido por quem ja tem o
# arquivo para tentar brute force offline.
#
# O marcador do hash e `#<sha256>`, sem `>`. `>#<sha256>` e aceito sem erro e
# NAO e o que parece: o Redis trata o token inteiro como senha em texto claro,
# guarda o sha256 de "#4241..." e o usuario `auth-service` passa a exigir a
# senha literalmente "#4241...". O servico sobe, o healthcheck responde, e a
# primeira operacao que precisa de dado falha com WRONGPASS - um bug de
# provisionamento que so aparece em producao. O formato certo foi medido com
# `ACL LIST` (que e como o proprio Redis grava o arquivo), nao de memoria.
REDIS_SHA256="$(printf '%s' "$REDIS_PASSWORD" | openssl dgst -sha256 -r | cut -d' ' -f1)"

umask 077
printf '%s' "$MONGO_ROOT_PASSWORD" > "$MONGO_ROOT_PASSWORD_FILE"
printf '%s' "$MONGO_APP_PASSWORD" > "$MONGO_APP_PASSWORD_FILE"
printf '%s' "$REDIS_PASSWORD" > "$REDIS_PASSWORD_FILE"

{
    # `default off` e o que faz a conexao anonima ser recusada (D18).
    echo "user default off"
    # `-@admin -@dangerous` tira CONFIG/DEBUG/ACL/FLUSHALL/KEYS/MONITOR/SHUTDOWN
    # e o resto da superficie administrativa. O que sobra serve ao servico:
    # GET/SET/EXPIRE/INCR/SCAN e os EVAL/EVALSHA do rate-limiter-flexible, que
    # estao em @scripting e nao em @dangerous. Medido em Redis 7.4 com
    # `ACL CAT dangerous` - nao na lista de suposicao.
    echo "user $APP_USER on #$REDIS_SHA256 ~* +@all -@admin -@dangerous"
} > "$REDIS_ACL_FILE"

chmod 600 "$MONGO_ROOT_PASSWORD_FILE" "$MONGO_APP_PASSWORD_FILE" "$REDIS_PASSWORD_FILE" "$REDIS_ACL_FILE"

# --- Autoconferencia ------------------------------------------------------
# Um segredo gerado que nao autentica e um segredo inutil: o servico sobe e
# falha no primeiro acesso, longe de quem provisionou. Estas linhas exercitam
# os arquivos recem-escritos, nao uma copia em memoria.
if [ "$(tr -d '\n' < "$MONGO_APP_PASSWORD_FILE")" != "$MONGO_APP_PASSWORD" ]; then
    echo "ERRO: a senha da aplicacao no Mongo nao confere com o arquivo gravado." >&2
    exit 1
fi

if ! grep -q "user default off" "$REDIS_ACL_FILE"; then
    echo "ERRO: o arquivo de ACL nao desliga o usuario default." >&2
    echo "Sem isso a conexao anonima entra, e a Fase 1.3 nao entregou o que promete." >&2
    exit 1
fi

if ! grep -q "user $APP_USER on #$REDIS_SHA256" "$REDIS_ACL_FILE"; then
    echo "ERRO: a ACL nao registra o usuario $APP_USER com o hash da senha gerada." >&2
    exit 1
fi

# Confere que o hash da ACL e mesmo o da senha entregue. Um `cut` errado aqui
# produz uma ACL que nao autentica ninguem - e o sintoma aparece no primeiro
# login, nao no provisionamento.
ACL_SHA256="$(grep -o '#[a-f0-9]\{64\}' "$REDIS_ACL_FILE" | head -1 | tr -d '#')"
if [ "$ACL_SHA256" != "$REDIS_SHA256" ]; then
    echo "ERRO: o hash na ACL nao confere com a senha gerada." >&2
    exit 1
fi

# O marcador de hash e `#<sha256>`. `>#<sha256>` e aceito sem erro pelo Redis e
# significa "senha em texto claro igual a #4241...", o que faz a ACL silenciosamente
# inutil: o app sobe, o healthcheck passa, e a primeira operacao que precisa de
# dado morre com WRONGPASS. Recusar o marcador errado aqui e mais barato que
# descobrir isso em producao.
if grep -q '>#[a-f0-9]' "$REDIS_ACL_FILE"; then
    echo "ERRO: a ACL usa >#hash. O Redis espera #hash: o '>' faz a senha ser lida" >&2
    echo "como texto claro e o usuario deixa de autenticar." >&2
    exit 1
fi

if [ "${#MONGO_APP_PASSWORD}" -lt 32 ] || [ "${#REDIS_PASSWORD}" -lt 32 ]; then
    echo "ERRO: senha gerada com menos de 32 caracteres." >&2
    exit 1
fi

# --- Prova ao vivo ---------------------------------------------------------
# As conferencias acima sao sobre texto: provam que o arquivo diz o que precisa
# dizer, nao que o Redis entende. Foi exatamente assim que o marcador errado do
# hash passou: arquivo valido, senha que o servico nunca conseguiria usar. Com
# um Redis de verdade a duvida e respondida em segundos, e a resposta e a mesma
# em qualquer maquina.
#
# A senha vai por stdin, e nao em `-e REDISCLI_AUTH=`: variavel de ambiente de
# `docker exec` aparece na lista de processos do host. Aqui o custo e o mesmo
# (o container e descartavel, a senha e recem-gerada e nunca sai da maquina) e
# ainda assim nao se escreve o segredo onde outro processo o le.
verify_with_redis() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "AVISO: docker ausente, conferindo a ACL so por texto. O formato do hash" >&2
        echo "so fica provado com um Redis de verdade: rode de novo onde houver docker." >&2
        return 0
    fi

    local container="deps-acl-verify-$$"
    docker rm -f "$container" >/dev/null 2>&1 || true

    # A prova roda com a ACL em modo 600 e dono 999, que e como ela vai estar em
    # producao. Montar o arquivo do host direto no container nao serviria: ele
    # pertence a quem provisionou, e o redis-server troca para o usuario `redis`
    # (uid 999) antes de ler a ACL. A recusa "Permission denied" seria do
    # container de teste, e nao da configuracao que queremos provar.
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    cp "$REDIS_ACL_FILE" "$tmp_dir/users.acl"
    chmod 600 "$tmp_dir/users.acl"
    docker run --rm -v "${tmp_dir}:/deps" "$CHOWN_IMAGE" sh -c \
        "chown ${DEP_UID}:${DEP_UID} /deps/users.acl && chmod 600 /deps/users.acl"

    docker run -d --rm --name "$container" \
        -v "${tmp_dir}/users.acl:/etc/redis/users.acl:ro" \
        "${REDIS_IMAGE}" redis-server --aclfile /etc/redis/users.acl >/dev/null

    # O servidor com `user default off` sobe recusando o cliente anonimo: o
    # primeiro estado observavel de "pronto" e o NOAUTH, nao o PONG. A checagem
    # passa por captura de saida em vez de pipe com `grep` porque `pipefail`
    # inverteria o sentido do teste (redis-cli sai com erro, grep acha "NOAUTH",
    # e o pipeline inteiro conta como falha).
    local tries=0
    local ping_out
    while :; do
        ping_out="$(docker exec "$container" redis-cli --no-auth-warning ping 2>&1 || true)"
        case "$ping_out" in
            *NOAUTH*) break ;;
        esac
        tries=$((tries + 1))
        if [ "$tries" -ge 30 ]; then
            echo "ERRO: o Redis de verificacao nao subiu." >&2
            docker logs "$container" >&2 || true
            docker rm -f "$container" >/dev/null 2>&1 || true
            rm -rf "$tmp_dir"
            exit 1
        fi
        sleep 0.2
    done

    local anonymous auth_wrong auth_ok admin_blocked scripting
    anonymous="$(docker exec "$container" redis-cli --no-auth-warning ping 2>&1 || true)"
    auth_wrong="$(printf 'AUTH %s senha-errada\nPING\n' "$APP_USER" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    auth_ok="$(printf 'AUTH %s %s\nSET verify:chave verify\nGET verify:chave\nPING\n' \
        "$APP_USER" "$REDIS_PASSWORD" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    # O rate limit roda em EVAL (rate-limiter-flexible). Se `EVAL` estivesse fora
    # da ACL, o app passaria no healthcheck e perderia o rate limit em
    # producao - que e o oposto de protecao.
    scripting="$(printf 'AUTH %s %s\nEVAL "return redis.call(\x27incr\x27, KEYS[1])" 1 verify:ctr\n' \
        "$APP_USER" "$REDIS_PASSWORD" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    admin_blocked="$(printf 'AUTH %s %s\nCONFIG GET maxmemory\n' "$APP_USER" "$REDIS_PASSWORD" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"

    docker rm -f "$container" >/dev/null 2>&1 || true

    local failed=0
    case "$anonymous" in
        *"NOAUTH"*) ;;
        *) echo "ERRO: a conexao anonima nao foi recusada (resposta: $anonymous)." >&2
           failed=1 ;;
    esac
    case "$auth_wrong" in
        *WRONGPASS*) ;;
        *) echo "ERRO: a senha errada nao foi recusada (resposta: $auth_wrong)." >&2
           failed=1 ;;
    esac
    case "$auth_ok" in
        *"verify"$'\n'*PONG*|verify*OK*PONG*) ;;
        *) echo "ERRO: o usuario $APP_USER nao autenticou com a senha gerada." >&2
           echo "resposta: $auth_ok" >&2
           failed=1 ;;
    esac
    case "$scripting" in
        *OK*) ;;
        *) echo "ERRO: o usuario da aplicacao nao pode rodar EVAL; o rate limit" >&2
           echo "que roda em Lua deixaria de existir." >&2
           echo "resposta: $scripting" >&2
           failed=1 ;;
    esac
    # O INCR precisa ter rodado de verdade: o `OK` sozinho prova que o EVAL foi
    # aceito, nao que o script foi executado.
    if ! printf '%s' "$scripting" | tail -1 | grep -qE '^[0-9]+$'; then
        echo "ERRO: o EVAL rodou mas o INCR nao foi aplicado (resposta: $scripting)." >&2
        failed=1
    fi
    case "$admin_blocked" in
        *NOPERM*) ;;
        *) echo "ERRO: CONFIG nao foi bloqueado para o usuario da aplicacao." >&2
           echo "resposta: $admin_blocked" >&2
           failed=1 ;;
    esac

    if [ "$failed" -ne 0 ]; then
        exit 1
    fi

    echo "  ACL provada em um Redis real: anonima recusada (NOAUTH), senha errada recusada"
    echo "  (WRONGPASS), $APP_USER autenticando, EVAL liberado, CONFIG bloqueado"
}

if [ "$VERIFY" -eq 1 ]; then
    verify_with_redis
fi

if [ "$FOR_CONTAINER" -eq 1 ]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERRO: --for-container precisa de docker para ajustar o dono do material." >&2
        exit 2
    fi

    # Matriz de dono - medida, nao presumida:
    #
    #   mongo-root-password  999:999  600  lido pelo entrypoint (uid 999)
    #   redis-app.acl        999:999  600  lido pelo redis-server (uid 999)
    #   mongo-app-password  1001:999  640  lido pelo app (dono) E pelo init
    #                                            script do Mongo (grupo 999)
    #   redis-password      1001:999  640  lido pelo app (dono) E pelo health
    #                                            check do Redis (grupo 999)
    #
    # As duas senhas da aplicacao sao as unicas com dois leitores, e por isso as
    # unicas com grupo em vez de dono unico: o mesmo arquivo precisa chegar no
    # app (que roda como nodeuser, uid 1001) e dentro do container da dependencia
    # (que roda como mongodb/redis, uid 999). Duplicar o arquivo evitaria o grupo
    # compartilhado, mas criaria dois segredos que precisam girar juntos - dois
    # segredos que podem sair de sincronia sao pior que um grupo de leitura a mais.
    #
    # Quem le por grupo e o proprio container, e dentro dele so roda o processo
    # dono: no app nao ha outro uid, no Mongo/Redis nao ha outro usuario. O modo
    # 640 nao abre o arquivo para mais ninguem no host alem do usuario que o
    # provisionou.
    #
    # O chown acontece por um container descartavel, e nao por `sudo chown` no
    # host: exigir root para provisionar senha tornaria o passo obrigatorio na
    # pratica, e quem roda em CI nao tem sudo. O modo e preservado - o que
    # muda e o dono, nao a exposicao.
    docker run --rm -v "${OUT_DIR}:/deps" "$CHOWN_IMAGE" sh -c \
        "chown ${DEP_UID}:${DEP_UID} /deps/mongo-root-password /deps/redis-app.acl \
         && chmod 600 /deps/mongo-root-password /deps/redis-app.acl \
         && chown ${APP_UID}:${DEP_UID} /deps/mongo-app-password /deps/redis-password \
         && chmod 640 /deps/mongo-app-password /deps/redis-password"

    # Confere o dono de verdade. Um chown que nao surtiu efeito (imagem sem
    # Permissions, bind mount de outra origem) so falharia no primeiro acesso
    # dentro do container, em producao.
    for file in "$MONGO_ROOT_PASSWORD_FILE" "$REDIS_ACL_FILE"; do
        if [ "$(stat -c '%u' "$file")" != "$DEP_UID" ]; then
            echo "ERRO: o dono de $file continua sendo $(stat -c '%u' "$file"), esperado ${DEP_UID}." >&2
            echo "O container do Mongo/Redis nao vai conseguir ler. Verifique o bind mount." >&2
            exit 1
        fi
    done

    for file in "$MONGO_APP_PASSWORD_FILE" "$REDIS_PASSWORD_FILE"; do
        if [ "$(stat -c '%u' "$file")" != "$APP_UID" ] \
            || [ "$(stat -c '%g' "$file")" != "$DEP_UID" ]; then
            echo "ERRO: $file precisa ser ${APP_UID}:${DEP_UID} (app por dono, dependencia por grupo)." >&2
            echo "dono atual: $(stat -c '%u:%g' "$file")" >&2
            exit 1
        fi
    done

    echo "  dono ajustado: app=uid ${APP_UID}, Mongo/Redis=uid ${DEP_UID} (senhas do app com grupo de leitura ${DEP_UID})"
fi

echo "Segredos das dependencias verificados."
echo "  usuario da aplicacao: $APP_USER (Mongo e Redis)"
echo "  senha do root do Mongo:  $MONGO_ROOT_PASSWORD_FILE (modo 600, fora do repositorio)"
echo "  senha do app no Mongo:   $MONGO_APP_PASSWORD_FILE (modo 600, fora do repositorio)"
echo "  senha do app no Redis:   $REDIS_PASSWORD_FILE (modo 600, fora do repositorio)"
echo "  ACL do Redis:            $REDIS_ACL_FILE (guarda hash SHA-256, nao a senha)"
echo
echo "Configure o container da aplicacao com os caminhos (a senha nao vira texto de config):"
echo "  MONGODB_USER=$APP_USER"
echo "  MONGODB_PASSWORD_PATH=/run/secrets/deps/mongo-app-password"
echo "  MONGODB_AUTH_SOURCE=admin"
echo "  REDIS_USERNAME=$APP_USER"
echo "  REDIS_PASSWORD_PATH=/run/secrets/deps/redis-password"
echo "  REDIS_URL=redis://redis:6379/0"
echo
echo "O usuario do Redis NAO entra na URL: se REDIS_URL ja trouxer usuario ou senha,"
echo "o app recusa a configuracao em vez de escolher um dos dois em silencio. Ponha"
echo "so o host na URL e deixe usuario e senha nos campos acima."
echo
echo "O usuario do Mongo entra em authSource=admin, que e onde o Mongo guarda a"
echo "credencial, e recebe papel readWrite apenas sobre o banco da aplicacao. O"
echo "root acima e usado so para criar esse usuario na primeira inicializacao do"
echo "volume - em volume ja inicializado o arquivo nao e lido."
