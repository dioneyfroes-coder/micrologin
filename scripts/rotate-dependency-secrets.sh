#!/usr/bin/env bash
# ===================================================================
# Rotaciona os segredos das dependencias (MongoDB e Redis) - Fase 1.4
# ===================================================================
# A provisionacao (generate-dependency-secrets.sh) recusa sobrescrever material
# existente: rotacionar e um ato deliberado, nao um acidente. Este script e o
# ato deliberado. Ele troca a senha do Redis e a do usuario da aplicacao no
# Mongo, e mantem a senha ANTIGA do Redis na janela para nao derrubar conexoes
# que ainda estao usando a credencial anterior.
#
# Uso:
#   scripts/rotate-dependency-secrets.sh <diretorio> [--user=U] [--mongo] [--mongo-only] [--for-container] [--skip-verify]
#   scripts/rotate-dependency-secrets.sh <diretorio> --close-window [--for-container] [--skip-verify]
#
#   --user=U        nome do usuario de ACL (padrao: o que ja esta na ACL)
#   --mongo         rotaciona tambem a senha do usuario da aplicacao no Mongo
#   --mongo-only    rotaciona so o Mongo (a senha do Redis fica como esta)
#   --close-window  encerra a janela: a ACL passa a aceitar so a senha nova
#   --for-container ajusta o dono do material para os uids das imagens
#   --skip-verify   pula a prova ao vivo em um Redis descartavel
#
# Janela de rotacao, na ordem em que os passos valem:
#
#   1. `rotate-dependency-secrets.sh <dir>` grava a senha nova em redis-password,
#      move a antiga para redis-previous-password e escreve a ACL com OS DOIS
#      hashes (nova e anterior). O Redis recarrega a ACL e aceita as duas.
#   2. o app e reiniciado e passa a usar a senha nova; conexoes antigas, que
#      ainda estao com a senha anterior, continuam autenticando.
#   3. `... --close-window` reescreve a ACL so com o hash atual e apaga
#      redis-previous-password. A senha antiga deixa de valer.
#
# Por que a janela existe: sem ela, trocar a senha do Redis e um restart do
# Redis + um restart do app, na ordem exata, e qualquer passo fora de ordem
# causa uma janela de 503. Com dois hashes, o Redis aceita as duas credenciais
# durante a transicao e nao existe o instante em que nenhuma vale.
#
# Por que o Mongo fica de fora por padrao: ele nao tem duas senhas por usuario.
# `changeUserPassword` invalida a anterior no mesmo instante, entao trocar a
# senha do app no Mongo exige uma janela de manutencao e uma ordem exata
# (servidor primeiro, arquivo depois, app por ultimo). Misturar isso na
# rotacao "sem downtime" do Redis daria a ilusao de um procedimento unico: se o
# operador rodar isto e reiniciar o app, ele passa a ler uma senha que o Mongo
# ainda nao aceitou. Por isso `--mongo` e explicito, e o passo a passo esta em
# docs/ROTACAO.md.
#
# Por que senha por arquivo: ver generate-dependency-secrets.sh. Em resumo, a
# senha nao vira texto de config, nao aparece em `docker inspect` e nao e
# herdada pelo `ps` do host.
# ===================================================================
set -euo pipefail

OUT_DIR="${1:-}"
CLOSE_WINDOW=0
FOR_CONTAINER=0
VERIFY=1
APP_USER_OPT=""

if [ -z "$OUT_DIR" ]; then
    echo "uso: $0 <diretorio> [--user=U] [--mongo] [--mongo-only] [--close-window] [--for-container] [--skip-verify]" >&2
    exit 2
fi
shift || true

ROTATE_MONGO=0
ROTATE_REDIS=1
for arg in "$@"; do
    case "$arg" in
        --close-window)  CLOSE_WINDOW=1 ;;
        --mongo)         ROTATE_MONGO=1 ;;
        --mongo-only)    ROTATE_MONGO=1; ROTATE_REDIS=0 ;;
        --for-container) FOR_CONTAINER=1 ;;
        --skip-verify)   VERIFY=0 ;;
        --user)          echo "ERRO: use --user=<nome>, nao --user <nome>." >&2; exit 2 ;;
        --user=*)        APP_USER_OPT="${arg#--user=}" ;;
        -*) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

if [ "$ROTATE_REDIS" -eq 0 ] && [ "$ROTATE_MONGO" -eq 0 ]; then
    echo "ERRO: nada a rotacionar. Escolha o alvo (padrao: Redis; --mongo-only: Mongo)." >&2
    exit 2
fi

APP_UID="${DEPS_APP_UID:-1001}"
DEP_UID="${DEPS_DEP_UID:-999}"
CHOWN_IMAGE="${DEPS_CHOWN_IMAGE:-node:22-alpine}"
REDIS_IMAGE="${DEPS_REDIS_IMAGE:-redis:7-alpine}"

if [ ! -d "$OUT_DIR" ]; then
    echo "ERRO: $OUT_DIR nao existe. Rode generate-dependency-secrets.sh primeiro." >&2
    exit 1
fi
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

MONGO_APP_PASSWORD_FILE="$OUT_DIR/mongo-app-password"
REDIS_PASSWORD_FILE="$OUT_DIR/redis-password"
REDIS_PREVIOUS_PASSWORD_FILE="$OUT_DIR/redis-previous-password"
REDIS_ACL_FILE="$OUT_DIR/redis-app.acl"

# Onde o mesmo material aparece DENTRO do container do Mongo. E o alvo do mount
# nos dois composes; o comando de rotacao precisa dele, e hardcode-lo aqui e
# assumir o mesmo padrao que os composes (ajustavel por env, como os uids).
MONGO_APP_PASSWORD_IN_CONTAINER="${DEPS_MONGO_APP_PASSWORD_IN_CONTAINER:-/run/secrets/deps/mongo-app-password}"
MONGO_ROOT_PASSWORD_IN_CONTAINER="${DEPS_MONGO_ROOT_PASSWORD_IN_CONTAINER:-/run/secrets/deps/mongo-root-password}"

REQUIRED_FILES=""
if [ "$ROTATE_REDIS" -eq 1 ]; then
    REQUIRED_FILES="$REDIS_PASSWORD_FILE $REDIS_ACL_FILE"
fi
if [ "$ROTATE_MONGO" -eq 1 ]; then
    REQUIRED_FILES="$REQUIRED_FILES $MONGO_APP_PASSWORD_FILE"
fi

for file in $REQUIRED_FILES; do
    if [ ! -e "$file" ]; then
        echo "ERRO: $file nao existe. Rotacionar e trocar um segredo existente;" >&2
        echo "sem material previo nao ha o que rotacionar. Provisione primeiro com" >&2
        echo "generate-dependency-secrets.sh." >&2
        exit 1
    fi
done

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERRO: openssl nao encontrado. Instale openssl para gerar os segredos." >&2
    exit 1
fi

# --- Acesso ao material que o host nao pode mais tocar --------------------
#
# Depois de `--for-container`, os arquivos passam a ser do uid 1001 (app) e 999
# (Mongo/Redis), em modo 600/640. Isso e de proposito: quem provisionou nao
# precisa continuar lendo a senha. Mas a rotacao precisa mexer exatamente
# nesses arquivos. Exigir `sudo` tornaria um passo opcional em obrigatorio, e
# quem provisiona num CI nao tem sudo — entao o acesso acontece por um container
# descartavel como root. O segredo entra por stdin: em `argv` ele apareceria no
# `ps` do host, que e exatamente o que a Fase 1.3 veio eliminar.
deps_as_root() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERRO: $1 precisa de docker: o material pertence ao container (uid 1001/999)" >&2
        echo "e o usuario do host nao tem permissao. Rode com acesso root, ou" >&2
        echo "provisione com um usuario que ainda leia o arquivo." >&2
        exit 2
    fi
    docker run --rm -i --user 0:0 -v "${OUT_DIR}:/deps" "$CHOWN_IMAGE" sh -c "$1"
}

# Conteudo exato, com as quebras preservadas: a ACL tem varias linhas e o
# `tr -d '\n'` de sempre as colaria num paragrafo so, onde o grep do usuario
# nao encontraria nada.
read_secret_file() {
    local file="$1" name
    name="$(basename "$file")"
    if [ -r "$file" ]; then
        cat "$file"
    else
        deps_as_root "cat /deps/$name"
    fi
}

# A senha e uma unica linha: a quebra final do gerador nao faz parte dela.
read_password_file() {
    read_secret_file "$1" | tr -d '\n'
}

# A escrita e no MESMO inode, nunca com `.tmp` + `mv`. Os secrets sao montados
# como ARQUIVO nos containers (deps/redis-app.acl:/etc/redis/users.acl), e o
# bind mount de arquivo aponta para o inode existente no momento em que o
# container foi criado: um `mv` trocaria o inode e o container leria o arquivo
# antigo para sempre. Truncar e reescrever e o que faz o Redis reler a ACL no
# restart sem recriar o container.
write_secret_file() {
    local file="$1" content="$2" name is_new=0
    name="$(basename "$file")"
    if [ ! -e "$file" ]; then
        is_new=1
    fi

    # Um arquivo que ainda nao existe e gravavel pelo host se o diretorio e dele:
    # o `redis-previous-password` nasce assim, e precisa nascer do usuario que
    # depois vai provisionar e le-lo, nao do root efemero do container.
    if [ -w "$file" ] || { [ "$is_new" -eq 1 ] && [ -w "$(dirname "$file")" ]; }; then
        printf '%s' "$content" > "$file"
        if [ "$is_new" -eq 1 ]; then
            chmod 600 "$file"
        fi
        return 0
    fi

    # `cat >` trunca: o inode, o dono e o modo do arquivo que ja existe ficam
    # como estavam. O `chmod` so entra no arquivo novo, porque os existentes ja
    # vem com o modo certo (600 no material do container, 640 nos do app) e
    # afrouxar 640 para 600 deixaria o container sem permissao de leitura.
    printf '%s' "$content" | deps_as_root \
        "cat > /deps/$name; if [ $is_new -eq 1 ]; then chmod 600 /deps/$name; fi"
}

# O usuario de ACL e lido do proprio arquivo quando nao vem em --user: os dois
# lados precisam concordar, e um nome digitado errado na rotacao criaria um
# usuario novo (que o app nao usa) em vez de trocar a senha do usuario real.
# Nao e erro nao encontrar o nome quando o alvo e so o Mongo.
if [ -n "$APP_USER_OPT" ]; then
    APP_USER="$APP_USER_OPT"
elif [ -e "$REDIS_ACL_FILE" ]; then
    APP_USER="$(read_secret_file "$REDIS_ACL_FILE" | grep -oE '^user [^ ]+ on' | head -1 | cut -d' ' -f2)"
else
    APP_USER=""
fi
if [ "$ROTATE_REDIS" -eq 1 ] && [ -z "$APP_USER" ]; then
    echo "ERRO: nao foi possivel determinar o usuario na ACL em $REDIS_ACL_FILE." >&2
    echo "Informe explicitamente com --user=<nome>." >&2
    exit 1
fi

# `#<sha256>`: o marcador do hash, sem `>`. Ver generate-dependency-secrets.sh.
sha256_of() {
    printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1
}

# 48 caracteres de base64url: ~288 bits. Ver generate-dependency-secrets.sh.
gen_password() {
    openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}

# Escreve a ACL: usuario default desligado + o usuario da aplicacao, sempre com
# pelo menos a senha atual, opcionalmente com a anterior na janela.
acl_content() {
    local current_sha="$1"
    local previous_sha="${2:-}"

    {
        echo "user default off"
        if [ -n "$previous_sha" ]; then
            echo "user $APP_USER on #$current_sha #$previous_sha ~* +@all -@admin -@dangerous"
        else
            echo "user $APP_USER on #$current_sha ~* +@all -@admin -@dangerous"
        fi
    }
}

write_acl() {
    local content
    # A quebra final vai explicita: `$(...)` descarta a ultima, e um arquivo de
    # ACL sem a linha final terminada e um arquivo que so parece correto.
    content="$(acl_content "$1" "${2:-}")$(printf '\n')"
    write_secret_file "$REDIS_ACL_FILE" "$content"
}

# Prova ao vivo: sobe um Redis descartavel com a ACL e responde a pergunta que
# importa na rotacao - as duas senhas autenticam durante a janela, e so a nova
# depois que ela fecha? Confiar no texto do arquivo repetiria o erro do marcador
# `>#hash`: arquivo plausivel, senha que o Redis nunca aceitaria.
#
# Recebe a senha nova e, opcionalmente, a anterior (para provar que ainda vale).
verify_with_redis() {
    local current_password="$1"
    local previous_password="${2:-}"

    if ! command -v docker >/dev/null 2>&1; then
        echo "AVISO: docker ausente, conferindo a ACL so por texto." >&2
        return 0
    fi

    local container="deps-rotate-verify-$$"
    docker rm -f "$container" >/dev/null 2>&1 || true

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    # A ACL vem por leitura, não por `cp`: depois de `--for-container` o
    # usuário do host não tem permissão de leitura nela, e é justamente esse
    # arquivo que a prova precisa montar.
    read_secret_file "$REDIS_ACL_FILE" > "$tmp_dir/users.acl"
    chmod 600 "$tmp_dir/users.acl"
    docker run --rm -v "${tmp_dir}:/deps" "$CHOWN_IMAGE" sh -c \
        "chown ${DEP_UID}:${DEP_UID} /deps/users.acl && chmod 600 /deps/users.acl"

    docker run -d --rm --name "$container" \
        -v "${tmp_dir}/users.acl:/etc/redis/users.acl:ro" \
        "${REDIS_IMAGE}" redis-server --aclfile /etc/redis/users.acl >/dev/null

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

    local new_auth old_auth wrong_auth
    new_auth="$(printf 'AUTH %s %s\nPING\n' "$APP_USER" "$current_password" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    wrong_auth="$(printf 'AUTH %s senha-errada\nPING\n' "$APP_USER" \
        | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    if [ -n "$previous_password" ]; then
        old_auth="$(printf 'AUTH %s %s\nPING\n' "$APP_USER" "$previous_password" \
            | docker exec -i "$container" redis-cli --no-auth-warning 2>&1 || true)"
    fi

    docker rm -f "$container" >/dev/null 2>&1 || true
    rm -rf "$tmp_dir"

    local failed=0
    case "$new_auth" in
        *PONG*) ;;
        *) echo "ERRO: a senha nova nao autenticou (resposta: $new_auth)." >&2
           failed=1 ;;
    esac
    case "$wrong_auth" in
        *WRONGPASS*) ;;
        *) echo "ERRO: a senha errada nao foi recusada (resposta: $wrong_auth)." >&2
           failed=1 ;;
    esac
    if [ -n "$previous_password" ]; then
        case "$old_auth" in
            *PONG*) ;;
            *) echo "ERRO: a senha anterior deveria continuar valendo na janela" >&2
               echo "(resposta: $old_auth). Rotacionar assim derruba quem esta no ar." >&2
               failed=1 ;;
        esac
    fi

    if [ "$failed" -ne 0 ]; then
        exit 1
    fi

    if [ -n "$previous_password" ]; then
        echo "  ACL provada: senha nova E anterior autenticam (janela aberta), senha errada recusada"
    else
        echo "  ACL provada: so a senha atual autentica (janela fechada), senha errada recusada"
    fi
}

# Aplica a matriz de dono depois de escrever (mesma de
# generate-dependency-secrets.sh). O chown roda num container descartavel para
# nao exigir root no host: quem provisiona num CI nao tem sudo.
apply_ownership() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERRO: --for-container precisa de docker para ajustar o dono do material." >&2
        exit 2
    fi

    docker run --rm -v "${OUT_DIR}:/deps" "$CHOWN_IMAGE" sh -c \
        "chown ${DEP_UID}:${DEP_UID} /deps/redis-app.acl \
         && chmod 600 /deps/redis-app.acl \
         && chown ${APP_UID}:${DEP_UID} /deps/mongo-app-password /deps/redis-password \
         && chmod 640 /deps/mongo-app-password /deps/redis-password \
         && if [ -e /deps/redis-previous-password ]; then \
              chown ${APP_UID}:${APP_UID} /deps/redis-previous-password \
              && chmod 600 /deps/redis-previous-password; fi"

    if [ "$(stat -c '%u' "$REDIS_ACL_FILE")" != "$DEP_UID" ]; then
        echo "ERRO: o dono de $REDIS_ACL_FILE continua sendo $(stat -c '%u' "$REDIS_ACL_FILE")." >&2
        exit 1
    fi
    for file in "$MONGO_APP_PASSWORD_FILE" "$REDIS_PASSWORD_FILE"; do
        if [ "$(stat -c '%u' "$file")" != "$APP_UID" ] \
            || [ "$(stat -c '%g' "$file")" != "$DEP_UID" ]; then
            echo "ERRO: $file precisa ser ${APP_UID}:${DEP_UID}, dono atual $(stat -c '%u:%g' "$file")." >&2
            exit 1
        fi
    done
    echo "  dono ajustado: app=uid ${APP_UID}, Redis=uid ${DEP_UID}"
}

if [ "$CLOSE_WINDOW" -eq 1 ]; then
    # Fechar janela nao gera senha e nao tem nada a ver com o Mongo. Aceitar as
    # duas flags e rodar so uma delas seria o pior resultado possivel: o
    # operador acredita que girou as duas, e a do Mongo segue como estava.
    if [ "$ROTATE_MONGO" -eq 1 ]; then
        echo "ERRO: --close-window nao rotaciona nada e nao se combina com --mongo/--mongo-only." >&2
        echo "Gire o Mongo com --mongo-only e feche a janela do Redis em outro comando." >&2
        exit 2
    fi

    # Encerrar a janela nao gera senha: a senha atual continua a mesma, o que
    # sai e o hash da anterior. Assim nao existe o caso de fechar a janela e
    # deixar o app com uma credencial diferente da que a ACL aceita.
    CURRENT_REDIS_PASSWORD="$(read_password_file "$REDIS_PASSWORD_FILE")"
    CURRENT_SHA="$(sha256_of "$CURRENT_REDIS_PASSWORD")"

    PREVIOUS_PASSWORD=""
    if [ -e "$REDIS_PREVIOUS_PASSWORD_FILE" ]; then
        PREVIOUS_PASSWORD="$(read_password_file "$REDIS_PREVIOUS_PASSWORD_FILE")"
    fi

    write_acl "$CURRENT_SHA"

    if [ "$VERIFY" -eq 1 ]; then
        verify_with_redis "$CURRENT_REDIS_PASSWORD" ""
    fi

    rm -f "$REDIS_PREVIOUS_PASSWORD_FILE"

    if [ "$FOR_CONTAINER" -eq 1 ]; then
        apply_ownership
    fi

    echo "Janela de rotacao do Redis encerrada."
    echo "  a ACL agora aceita so o hash de $REDIS_PASSWORD_FILE"
    if [ -n "$PREVIOUS_PASSWORD" ]; then
        echo "  a senha anterior foi removida de redis-previous-password"
    fi
    exit 0
fi

# --- Rotacao: gera senhas novas e abre a janela ---------------------------

umask 077

NEW_MONGO_APP_PASSWORD=""
if [ "$ROTATE_MONGO" -eq 1 ]; then
    NEW_MONGO_APP_PASSWORD="$(gen_password)"
    if [ "${#NEW_MONGO_APP_PASSWORD}" -lt 32 ]; then
        echo "ERRO: senha do Mongo gerada com menos de 32 caracteres." >&2
        exit 1
    fi
    write_secret_file "$MONGO_APP_PASSWORD_FILE" "$NEW_MONGO_APP_PASSWORD"
fi

if [ "$ROTATE_REDIS" -eq 1 ]; then
    OLD_REDIS_PASSWORD="$(read_password_file "$REDIS_PASSWORD_FILE")"
    OLD_SHA="$(sha256_of "$OLD_REDIS_PASSWORD")"

    NEW_REDIS_PASSWORD="$(gen_password)"
    if [ "$NEW_REDIS_PASSWORD" = "$OLD_REDIS_PASSWORD" ]; then
        echo "ERRO: a senha nova saiu igual a anterior. Nao rotacione sem trocar." >&2
        exit 1
    fi
    if [ "${#NEW_REDIS_PASSWORD}" -lt 32 ]; then
        echo "ERRO: senha gerada com menos de 32 caracteres." >&2
        exit 1
    fi
    NEW_SHA="$(sha256_of "$NEW_REDIS_PASSWORD")"

    # Grava em cima do arquivo, sem `.tmp` + `mv`, de proposito. Os secrets das
    # dependencias sao montados como ARQUIVO nos containers (ex.:
    # `deps/redis-app.acl:/etc/redis/users.acl`). O bind mount de arquivo aponta
    # para o inode no momento da criacao do container: um `mv` (que troca o
    # inode) deixaria o container lendo o arquivo antigo para sempre. Escrever no
    # mesmo inode e o que faz o Redis reler a ACL no restart sem recriar o
    # container. A janela de escrita parcial e irrelevante aqui: ninguem poe a
    # ACL em polling, e o app le a senha uma vez, no arranque.
    write_secret_file "$REDIS_PASSWORD_FILE" "$NEW_REDIS_PASSWORD"
    write_secret_file "$REDIS_PREVIOUS_PASSWORD_FILE" "$OLD_REDIS_PASSWORD"

    write_acl "$NEW_SHA" "$OLD_SHA"

    # Autoconferencia por texto: o aviso que o servico daria so no primeiro
    # acesso. A ACL e lida pela mesma via da escrita, porque depois de
    # `--for-container` o usuario do host nao tem permissao de leitura nela.
    WRITTEN_ACL="$(read_secret_file "$REDIS_ACL_FILE")"
    case "$WRITTEN_ACL" in
        *"user $APP_USER on #$NEW_SHA #$OLD_SHA"*) ;;
        *) echo "ERRO: a ACL nao registra as duas senhas na janela." >&2
           exit 1 ;;
    esac
    case "$WRITTEN_ACL" in
        *"$NEW_REDIS_PASSWORD"*|*"$OLD_REDIS_PASSWORD"*)
            echo "ERRO: a ACL contem senha em texto claro. Ela guarda so o SHA-256." >&2
            exit 1 ;;
    esac

    if [ "$VERIFY" -eq 1 ]; then
        verify_with_redis "$NEW_REDIS_PASSWORD" "$OLD_REDIS_PASSWORD"
    fi
fi

if [ "$FOR_CONTAINER" -eq 1 ]; then
    apply_ownership
fi

echo "Segredos rotacionados."
if [ "$ROTATE_REDIS" -eq 1 ]; then
    echo "  senha nova do Redis:      $REDIS_PASSWORD_FILE (janela aberta)"
    echo "  senha anterior do Redis:  $REDIS_PREVIOUS_PASSWORD_FILE (some no --close-window)"
    echo
    echo "A ACL aceita a senha nova e a anterior. Recarregue a ACL no Redis (restart"
    echo "do processo) e reinicie o app para ele pegar a senha nova:"
    echo "  docker compose -p <projeto> -f docker-compose.prod.yml restart redis"
    echo "  docker compose -p <projeto> -f docker-compose.prod.yml up -d auth-service"
fi

if [ "$ROTATE_MONGO" -eq 1 ]; then
    echo
    echo "  senha nova do app no Mongo: $MONGO_APP_PASSWORD_FILE"
    echo
    echo "ORDEM IMPORTANTE: o Mongo nao tem duas senhas por usuario, e a troca"
    echo "invalida a anterior na hora. Troque a senha no servidor ANTES de"
    echo "reiniciar o app - se o app subir antes, ele le esta senha nova e o Mongo"
    echo "ainda nao a aceita. O passo a passo completo esta em docs/ROTACAO.md."
    echo
    echo "O comando abaixo roda DENTRO do container do Mongo e le as duas senhas de"
    echo "la dentro, por dois motivos: no host o material pertence ao container e o"
    echo "usuario nao tem permissao de leitura, e em argv a senha apareceria no ps"
    echo "de qualquer usuario da maquina. O caminho assumido e o do compose"
    echo "(\$MONGO_APP_PASSWORD_PATH); ajuste se o seu montar em outro lugar."
    echo "Ajuste <container-mongo> se o nome do seu nao for esse. O usuario e o root:"
    echo
    echo "  docker exec <container-mongo> sh -c 'mongosh --quiet --host 127.0.0.1 \\"
    echo "      --username root --password \"\$(cat $MONGO_ROOT_PASSWORD_IN_CONTAINER)\" \\"
    echo "      --authenticationDatabase admin \\"
    echo "      --eval \"db.getSiblingDB(\\\"admin\\\").changeUserPassword(\\\"$APP_USER\\\", \\\"\$(cat $MONGO_APP_PASSWORD_IN_CONTAINER)\\\")\"'"
fi

if [ "$ROTATE_REDIS" -eq 1 ]; then
    echo
    echo "Depois que as conexoes com a credencial antiga sairem, feche a janela:"
    echo "  scripts/rotate-dependency-secrets.sh $OUT_DIR --close-window"
fi
