#!/usr/bin/env bash

# ====================================
# DRILL DE DEPLOY — backup, readiness, smoke e ROLLBACK (Fase 2.4)
# Authentication Microservice
# ====================================
#
# O que este drill fecha: `scripts/deploy.sh` orquestra backup da versão em
# execução, build, `up`, health check, smoke e — quando o novo deploy falha —
# rollback. Essa orquestração nunca tinha sido executada por nenhum teste.
# `test-config-backup.sh` prova o caminho do restore por dentro (backup-config +
# restore-config + reload) e `test:infra` prova resiliência de container;
# nenhum dos dois chama `deploy.sh`. Logo, o `rollback()` do deploy é código não
# exercitado: o `restore-config.sh` pode estar correto e o `deploy.sh` continuar
# chamando com argumentos errados, na ordem errada, ou não chamando. A Fase 2.3
# fechou o buraco do "imagem antiga com config nova" DENTRO do restore; o buraco
# de o *deploy* não chamar o restore continua aberto sem isto.
#
# O roteiro é o de um incidente real:
#
#   1. deploy da v1  -> app no ar, KID v1
#   2. deploy da v2  -> env file e material de segredo reescritos em disco SEM
#                       redeploy; o container continua na v1. O backup da v2 foi
#                       tirado do container em execução, não do arquivo: é este
#                       o controle que diz que o drill mede configuração em uso.
#   3. deploy da v3 com MongoDB na porta errada -> health check reprova e o
#                       deploy aborta.
#   4. O rollback tem de voltar para a v2: MESMA imagem em execução e MESMO KID
#                      (configuração) em runtime. Se voltasse só a imagem, o
#                      serviço subiria com o material de segredo da v3 e o
#                      /observability diria v3 — que é exatamente o estrago que a
#                      Fase 2.3 descreveu.
#   5. Controle negativo: a v3 estava no ar antes do rollback. Sem ele, um
#      rollback que não fizesse nada também "volta para a v2" e o drill passaria.
#
# A falha do passo 3 é injetada por configuração de verdade (a versão nova
# aponta para a porta errada do banco), não por stub: é a classe de erro mais
# comum em deploy — versão no ar, destino errado — e a que o health check existe
# para pegar.
#
# Uso:
#   scripts/test-deploy.sh [--keep] [--skip-build]
#
# Códigos de saída:
#   0  o rollback devolveu a versão anterior, com a configuração correta
#   1  alguma asserção falhou
#   2  pré-requisito ausente (docker parado, bash/openssl/curl/python3)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

PROJECT="micrologin-deploy-drill"
COMPOSE_FILE="docker-compose.config-test.yml"
ENV_FILE_NAME="deploy-drill.env"
ENV_FILE="${ROOT_DIR}/${ENV_FILE_NAME}"
# Mesmo alvo que o `deploy.sh` recebe: projeto, compose E env file. Sem o
# `--env-file` aqui, o Compose cairia nos defaults `${CFG_TEST_*:-.cfg-secrets}`
# do próprio arquivo e montaria um diretório de chaves que não é o do drill.
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
compose() { "${COMPOSE[@]}" "$@"; }

KEEP_STACK=0
SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --keep)       KEEP_STACK=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

DRILL_PORT="${DRILL_PORT:-3312}"
BASE_URL="http://localhost:${DRILL_PORT}"
WORK_DIR="${ROOT_DIR}/.deploy-drill"
# Um diretório de chaves por versão. `generate-jwt-keys.sh` se recusa a
# sobrescrever uma chave existente de propósito (rotacionar é ato deliberado), e
# a v2 do roteiro precisa justamente de material novo em disco. Com diretórios
# separados, cada versão tem o seu, e o rollback tem o que restaurar.
KEYS_V1="${WORK_DIR}/keys-v1"
KEYS_V2="${WORK_DIR}/keys-v2"
# Credenciais de Mongo/Redis são um conjunto ÚNICO, compartilhado por todas as
# versões, e não um por versão. Dois motivos, e ambos importam:
#  (1) o volume do Mongo persiste entre deploys, então trocar a senha do usuário
#      da aplicação exigiria recriar o volume inteiro — o drill estaria medindo
#      migração de banco, não rollback de configuração;
#  (2) o que o backup de configuração precisa devolver é o material que o CONTAINER
#      em execução tem carregado. Girar senhas de banco a cada versão faria o
#      rollback depender de dois backups simultâneos.
# A rotação que o drill prova é a da CHAVE DE ASSINATURA (JWT_ES256_KID) mais a
# configuração interpolada (URI_MONGODB) — que é justamente o que o
# backup-config.sh é capaz de capturar e devolver.
DEPS_DIR="${WORK_DIR}/deps"
BACKUPS_DIR="${WORK_DIR}/cfg-backups"
PASSPHRASE_FILE="${WORK_DIR}/passphrase"
IMAGE_PREFIX="deploy-drill"
# Remove as imagens do drill.
#
# O jeito óbvio é `--filter "reference=${IMAGE_PREFIX}*"`, e ele não apaga nada.
# O glob do filtro `reference` do Docker segue o `filepath.Match` do Go, em que
# `*` NÃO atravessa `/`. Ele compara contra `repo:tag` — que tem barra — então
# `deploy-drill*` casa `deploy-drill:v1` mas nunca `deploy-drill/v1-estavel:tag`.
# Medido: `deploy-drill*` devolve 0 imagens com 10 delas existindo;
# `deploy-drill/*` devolve 7.
#
# Sem `2>/dev/null` e sem `|| true` escondendo: o filtro devolvendo vazio era
# exatamente o que fazia o vazio parecer um "já estava limpo". O `grep` no
# repositório é a verificação, e ela não depende do glob do Docker.
remove_drill_images() {
    local id
    # Ordena por ID e não por tag: uma imagem pode ter várias tags e sair uma vez
    # só. `docker rmi` sai com erro se algo a usa, e o erro é descartado de
    # propósito — o próximo `docker image prune` do operador resolve, e abortar o
    # cleanup por causa disso esconderia as imagens que dá para remover.
    docker images --format '{{.ID}} {{.Repository}}' 2>/dev/null \
        | awk -v p="${IMAGE_PREFIX}/" '$2 ~ "^"p {print $1}' \
        | sort -u \
        | while read -r id; do
            [ -n "$id" ] || continue
            docker rmi -f "$id" >/dev/null 2>&1 || true
        done
}
# Marcadores de versão. `KID_*` vai para o ENVIRONMENT do container e é a prova
# de configuração em runtime; `MARKER_*` é gravado DENTRO da imagem e é a prova
# de que a imagem em execução é a anterior.
#
# Nenhum dos dois é a tag `VERSION` do deploy: `deploy.sh` exporta a própria tag
# (sha+timestamp) depois de ler o env file, e o Compose dá precedência ao
# ambiente do shell sobre o `--env-file`. Um marcador que o deploy sobrescreve
# não distinguiria uma versão da outra, e o drill passaria sem provar nada.
MARKER_V1="v1-estavel"
MARKER_V2="v2-estavel"
MARKER_V3="v3-quebrada"
KID_V1="deploy-drill-v1"
KID_V2="deploy-drill-v2"
MONGO_OK="mongodb://mongodb:27017/auth_cfg"
MONGO_BROKEN="mongodb://mongodb:27099/auth_cfg"

# `deploy.sh` e o drill compartilham a configuração da prova.
export DEPLOY_COMPOSE_PROJECT="$PROJECT"
export DEPLOY_COMPOSE_FILE="$COMPOSE_FILE"
export DEPLOY_COMPOSE_ENV_FILE="$ENV_FILE"
export CFG_BACKUPS_DIR="$BACKUPS_DIR"
export CONFIG_BACKUP_PASSPHRASE_FILE="$PASSPHRASE_FILE"
# A suíte roda por fora (npm run test:unit antes deste drill); pagar a suíte
# inteira a cada um dos três deploys seria o custo dominante.
export DEPLOY_SKIP_TESTS=1
# O health check de produção espera 5 minutos (30 × 10s). Os deploys BONS usam
# esse default: encurtar a janela aqui reprovaria o caminho feliz por causa do
# cold start do app, que é o oposto do que o drill quer provar. Só a v3, que
# precisa reprovar, recebe a janela curta — e só na invocação dela.
HEALTH_FAST_ATTEMPTS=3
HEALTH_FAST_INTERVAL=2

FAILURES=0

log_pass() { echo -e "  \033[0;32m✅ $1\033[0m"; }
log_warn() { echo -e "  \033[1;33m⚠️  $1\033[0m"; }
log_step() { echo -e "\n\033[0;34m▸ $1\033[0m"; }
fail() { echo -e "  \033[0;31m❌ $1\033[0m" >&2; FAILURES=$((FAILURES + 1)); }

# O material restaurado fica com o dono e o modo que o CONTAINER precisa (uid
# 1001/999, modo 444/600). `rm -rf` do próprio drill não os apaga — precisa do
# mesmo container descartável que `restore-config.sh` usa para reaplicar dono.
wipe_work_dir() {
    [ -e "$WORK_DIR" ] || return 0
    docker run --rm -u 0 -v "${WORK_DIR}:/w:rw" --entrypoint sh alpine -c 'rm -rf /w/*' >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR" 2>/dev/null || true
}

cleanup() {
    if [ "$KEEP_STACK" = "1" ]; then
        log_warn "--keep: stack ${PROJECT} e ${WORK_DIR} preservados"
        return 0
    fi
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    # Os logs de deploy são preservados: um drill que reprova e apaga a única
    # evidência do motivo obriga a toda falha a ser reproduzida de novo.
    rm -f "$ENV_FILE" 2>/dev/null || true
    remove_drill_images
}


# ============================================================
# 0. Pré-requisitos
# ============================================================
for tool in docker curl openssl python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "$tool ausente" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon indisponível" >&2; exit 2; }

# Duas instâncias deste drill rodando ao mesmo tempo se sabotam de um jeito
# muito confuso de diagnosticar: cada uma provisiona chaves no mesmo diretório,
# cada uma sobe containers com o mesmo nome, e o `wipe_work_dir` de uma apaga o
# material da outra no meio do deploy. O sintoma é "os segredos acabaram na raiz
# do diretório" — que parece um bug do gerador de segredos, e não é. Lock com
# PID, e o segundo processo sai com mensagem em vez de corromper o primeiro.
LOCK_FILE="${WORK_DIR}.lock"
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
    if [ -f "${LOCK_FILE}/pid" ] && kill -0 "$(cat "${LOCK_FILE}/pid" 2>/dev/null)" 2>/dev/null; then
        echo "outro test-deploy.sh em execução (PID $(cat "${LOCK_FILE}/pid")); nada a fazer." >&2
        exit 2
    fi
    rm -rf "$LOCK_FILE"
    mkdir "$LOCK_FILE"
fi
echo $$ > "${LOCK_FILE}/pid"
# Um único handler de EXIT: dois `trap ... EXIT` não se somam, o segundo
# sobrescreve o primeiro e o lock vazaria, deixando o drill travado para sempre.
trap 'rm -rf "$LOCK_FILE"; cleanup' EXIT

wipe_work_dir
rm -f "${WORK_DIR}"/deploy-*.log
mkdir -p "$KEYS_V1" "$KEYS_V2" "$DEPS_DIR" "$BACKUPS_DIR"
chmod 755 "$WORK_DIR" "$KEYS_V1" "$KEYS_V2" "$DEPS_DIR"

echo -n "drill-passphrase-$$" > "$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"

log_step "Provisionando material efêmero (ES256 + credenciais)"
# As credenciais de dependência (Mongo/Redis) NÃO são rotacionadas entre v1 e
# v2: o que muda entre as versões é a chave de assinatura, e é ela que o backup
# precisa devolver. Girar também as senhas dos bancos tornaria o rollback
# dependente de dois backups ao mesmo tempo.
bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$KEYS_V1" "$KID_V1" --for-container >/dev/null
bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$KEYS_V2" "$KID_V2" --for-container >/dev/null
bash "${SCRIPT_DIR}/generate-dependency-secrets.sh" "$DEPS_DIR" --for-container --skip-verify >/dev/null
# Um conjunto de credenciais POR VERSÃO, cada um gerado no seu diretório. A
# alternativa seria `cp -a` de um para o outro, e ela não funciona: os arquivos
# saem com o dono e o modo que o CONTAINER precisa (uid 999/1001, modo 600), e o
# operador não tem permissão de leitura para copiá-los. O `cp` falharia em
# silêncio e os containers subiriam sem senha — o modo de falha mais perigoso
# possível num drill, porque parece funcionar.
#
# Por que duas credenciais e não uma só: a v2 precisa de material NOVO em disco
# enquanto o container segue com o VELHO. Com um único conjunto, o backup da v2
# (que lê o container) e o disco seriam idênticos, e o rollback não teria nada
# para provar.
log_pass "chaves ES256 em ${KEYS_V1} e ${KEYS_V2} (fora do repositório no uso real)"

# ============================================================
# 1. Imagens genuinamente distintas
#
# Três tags da MESMA imagem fariam a checagem de digest passar por construção:
# o rollback poderia deixar a v3 no ar e o teste veria o mesmo id. Por isso cada
# versão recebe um arquivo-marcador gravado numa camada própria — o que o
# container em execução responde é, de fato, a versão que está no ar.
# ============================================================
# Grava /app/.drill-version numa imagem já construída, produzindo uma variante
# com o marcador novo. É o que torna as três imagens do roteiro realmente
# distintas em CONTEÚDO — `docker build` três vezes com o mesmo contexto
# produziria três tags do mesmo digest, e o drill passaria a medir a própria
# capacidade do Docker de renomear tags em vez do rollback.
# O marcador é lido de dentro do container em execução, não do `Config.Labels` da
# imagem: o app já rodando é a única prova de qual versão está no ar.
stamp_variant() { # stamp_variant <tag> <marcador> [<imagem base>]
    local tag="$1" marker="$2" base="${3:-${IMAGE_PREFIX}/${MARKER_V1}}"
    local cid marker_file base_entry base_cmd
    # Fora de $WORK_DIR: o `rm -f` do fim (e o cleanup do trap) limpariam o
    # arquivo antes da próxima versão.
    marker_file="$(mktemp)"
    printf '%s\n' "$marker" > "$marker_file"
    # O container precisa RODAR para o `docker exec` ajustar o modo do arquivo.
    # Por isso o comando é um sleep infinito, e não o CMD da imagem: iniciar o
    # app inteiro aqui só para trocar um chmod custaria um boot do Node por
    # variante.
    cid="$(docker create --entrypoint /bin/sh "$base" -c "while :; do sleep 3600; done")"
    # O `docker cp` grava o arquivo com o dono e o modo do HOST (aqui root, 600),
    # e o app roda como uid 1001: ele não consegue LER o próprio marcador e a
    # asserção recebe string vazia, parecendo "imagem errada". Corrigir o modo
    # antes do commit é o que torna o arquivo legível por quem roda a imagem.
    docker cp "$marker_file" "${cid}:/app/.drill-version" >/dev/null
    docker start "$cid" >/dev/null 2>&1 || true
    docker exec -u 0 "$cid" chmod 644 /app/.drill-version || true
    # O ENTRYPOINT/CMD gravados aqui seriam os do container de serviço (o sleep
    # infinito do chmod), não os da imagem base: `docker commit` sem(--change)
    # para ENTRYPOINT/CMD, e a variante nasceria bootando um shell em vez do
    # app — container "Up", health check reprovado, nenhum processo Node.
    # Restaurar explicitamente é o que mantém a variante executável.
    base_entry="$(docker inspect --format '{{json .Config.Entrypoint}}' "$base" 2>/dev/null || echo '[]')"
    base_cmd="$(docker inspect --format '{{json .Config.Cmd}}' "$base" 2>/dev/null || echo '[]')"
    docker commit \
        --change "LABEL drill.version=${marker}" \
        --change "ENTRYPOINT ${base_entry}" \
        --change "CMD ${base_cmd}" \
        "$cid" "${IMAGE_PREFIX}/${tag}" >/dev/null
    docker rm -f "$cid" >/dev/null
    rm -f "$marker_file"
}

build_variant() { stamp_variant "$1" "$2" "${IMAGE_PREFIX}/${MARKER_V1}"; }

write_env() { # write_env <marcador> <kid> <mongo uri> <dir de chaves>
    cat > "$ENV_FILE" <<EOF
REGISTRY=${IMAGE_PREFIX}
IMAGE_NAME=auth-service
PROD_BASE_URL=${BASE_URL}
URI_MONGODB=${3}
JWT_ES256_KID=${2}
CFG_TEST_PORT=${DRILL_PORT}
CFG_TEST_KEYS_DIR=$4
CFG_TEST_DEPS_DIR=${DEPS_DIR}
CFG_TEST_IMAGE=${IMAGE_PREFIX}/$1
EOF
}

if [ "$SKIP_BUILD" = "0" ]; then
    log_step "Construindo as imagens versionadas"
    docker build -t "target:production" -f Dockerfile -t "${IMAGE_PREFIX}/${MARKER_V1}" . >/dev/null
    # A imagem base também recebe o marcador: sem isso o v1-estavel sobe sem
    # /app/.drill-version e a asserção "imagem em execução diz v1/v2" mede um
    # arquivo ausente em vez da versão no ar.
    stamp_variant "${MARKER_V1}" "${MARKER_V1}" "${IMAGE_PREFIX}/${MARKER_V1}"
    build_variant "${MARKER_V2}" "${MARKER_V2}"
    build_variant "${MARKER_V3}" "${MARKER_V3}"
    log_pass "três imagens distintas (marcador em /app/.drill-version)"
fi

# O nome do container NÃO é "${PROJECT}-app": o Compose deriva
# "<projeto>-<serviço>-1" e o serviço se chama `auth-service`. Adivinhar o nome
# fazia o drill ler env/marker de um container inexistente e concluir "não
# subiu" quando o app estava no ar. Perguntamos ao Compose.
app_container() {
    compose ps -a -q auth-service 2>/dev/null | head -1
}

running_marker() {
    local c; c="$(app_container)"
    [ -n "$c" ] || return 0
    docker exec "$c" cat /app/.drill-version 2>/dev/null || true
}

running_kid() {
    local c; c="$(app_container)"
    [ -n "$c" ] || return 0
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null \
        | sed -n 's/^JWT_ES256_KID=//p' || true
}

running_image_id() {
    local c; c="$(app_container)"
    [ -n "$c" ] || return 0
    docker inspect --format '{{.Image}}' "$c" 2>/dev/null || true
}

image_id_of() {
    docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

wait_for_kid() { # wait_for_kid <kid> [tentativas]
    local esperado="$1" tentativas="${2:-90}" i atual
    for ((i = 1; i <= tentativas; i++)); do
        atual="$(running_kid)"
        if [ "$atual" = "$esperado" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

run_deploy() { # run_deploy <versão> <log>; ecoa o código de saída
    local version="$1" log="$2"
    bash "${SCRIPT_DIR}/deploy.sh" production "$version" >"$log" 2>&1
    echo $?
}

# ============================================================
# 2. Deploy da v1
# ============================================================
log_step "Deploy 1: ${MARKER_V1}"
write_env "${MARKER_V1}" "${KID_V1}" "${MONGO_OK}" "${KEYS_V1}"
V1_STATUS="$(run_deploy "${MARKER_V1}" "${WORK_DIR}/deploy-v1.log"; true)"
if [ "${V1_STATUS}" -eq 0 ]; then
    log_pass "deploy.sh reportou sucesso (backup, build, up, health e smoke)"
else
    fail "deploy da v1 falhou (log: ${WORK_DIR}/deploy-v1.log)"
    tail -20 "${WORK_DIR}/deploy-v1.log" >&2
fi

if wait_for_kid "${KID_V1}"; then
    log_pass "app no ar com KID=${KID_V1}"
else
    fail "app não subiu com KID=${KID_V1} (obtido: '$(running_kid)')"
fi

# ============================================================
# 3. Deploy da v2, com disco e container divergidos
# ============================================================
log_step "Deploy 2: ${MARKER_V2} (disco reescrito, container ainda na v1)"

# Rotação de chave junto: material NOVO em disco, container com o VELHO. É o
# cenário que a Fase 2.3 existe para fechar.
write_env "${MARKER_V2}" "${KID_V2}" "${MONGO_OK}" "${KEYS_V2}"

DISK_KID="$(grep '^JWT_ES256_KID=' "$ENV_FILE" | cut -d= -f2)"
RUNTIME_KID_BEFORE="$(running_kid)"
if [ "$DISK_KID" = "${KID_V2}" ] && [ "$RUNTIME_KID_BEFORE" = "${KID_V1}" ]; then
    log_pass "disco=${DISK_KID} e container=${RUNTIME_KID_BEFORE}: divergidos de propósito"
else
    fail "controle negativo não montado: disco=${DISK_KID} runtime=${RUNTIME_KID_BEFORE}"
fi

V2_STATUS="$(run_deploy "${MARKER_V2}" "${WORK_DIR}/deploy-v2.log"; true)"
if [ "${V2_STATUS}" -eq 0 ]; then
    log_pass "deploy.sh reportou sucesso"
else
    fail "deploy da v2 falhou (log: ${WORK_DIR}/deploy-v2.log)"
    tail -20 "${WORK_DIR}/deploy-v2.log" >&2
fi

if wait_for_kid "${KID_V2}"; then
    log_pass "app no ar com KID=${KID_V2}"
else
    fail "app não subiu com KID=${KID_V2} (obtido: '$(running_kid)')"
fi

ID_V2="$(image_id_of "${IMAGE_PREFIX}/${MARKER_V2}")"

# ============================================================
# 4. Deploy da v3 com configuração quebrada
# ============================================================
log_step "Deploy 3: ${MARKER_V3} com MongoDB na porta errada"

# A v3 aponta para a porta errada do Mongo. É a falha de deploy mais comum e
# mais difícil de ver: a imagem nova sobe, o health check reprova, e o único
# sintoma é o serviço fora do ar.
#
# A variável é escolhida por um critério, não por conveniência: precisa estar no
# ENVIRONMENT do container para que o backup a capture da fonte autoritativa
# (`docker inspect`) e não só do arquivo em disco. Uma falha injetada por uma
# variável que só existe na interpolação do Compose nunca seria restaurada — o
# arquivo em disco no momento do backup já é o da versão nova — e o rollback
# seria irrecoverável por construção. Nesse caso o teste mediria o limite do
# backup, não o rollback.
write_env "${MARKER_V3}" "deploy-drill-v3" "${MONGO_BROKEN}" "${KEYS_V1}"

set +e
DEPLOY_HEALTH_ATTEMPTS="$HEALTH_FAST_ATTEMPTS" \
DEPLOY_HEALTH_INTERVAL="$HEALTH_FAST_INTERVAL" \
    bash "${SCRIPT_DIR}/deploy.sh" production "${MARKER_V3}" >"${WORK_DIR}/deploy-v3.log" 2>&1
V3_STATUS=$?
set -e

if [ "$V3_STATUS" -ne 0 ]; then
    log_pass "deploy da v3 abortou como esperado (código ${V3_STATUS})"
else
    fail "deploy da v3 deveria ter reprovado no health check e passou"
fi

# O health check tem de ser o culpado, não qualquer outra coisa: um drill que
# falha por motivo errado passa verde sem provar o rollback.
if grep -q "Health check failed" "${WORK_DIR}/deploy-v3.log"; then
    log_pass "a reprovação foi no health check"
else
    fail "a v3 falhou por outro motivo; o drill não mediu o que dice medir"
    tail -30 "${WORK_DIR}/deploy-v3.log" >&2
fi

if grep -q "Restaurando imagem de backup" "${WORK_DIR}/deploy-v3.log"; then
    log_pass "rollback restaurou a imagem anterior"
else
    fail "deploy.sh não reportou restauração de imagem"
fi

if grep -q "Restaurando a configuração que rodava com" "${WORK_DIR}/deploy-v3.log"; then
    log_pass "rollback restaurou a configuração (imagem antiga não sobe com env novo)"
else
    fail "deploy.sh não restaurou a configuração no rollback — é o buraco da Fase 2.3"
fi

if grep -q "Restauração da configuração falhou" "${WORK_DIR}/deploy-v3.log"; then
    fail "a restauração de configuração reprovou; o rollback abortou antes de subir"
fi

# Controle negativo do rollback: a v3 estava no ar antes dele. Sem isto, um
# rollback que não fizesse nada também pareceria ter voltado para a v2.
ROLLED_BACK_KID="$(grep '^JWT_ES256_KID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
ROLLED_BACK_URI="$(grep '^URI_MONGODB=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ "$ROLLED_BACK_KID" = "${KID_V2}" ] && [ "$ROLLED_BACK_URI" = "${MONGO_OK}" ]; then
    log_pass "env file voltou ao par KID+URI da v2 (a v3 não sobreviveu ao rollback)"
else
    fail "env file ficou com KID='${ROLLED_BACK_KID}' URI='${ROLLED_BACK_URI}'; esperado ${KID_V2} / ${MONGO_OK}"
fi

# ============================================================
# 5. As duas metades do rollback, em runtime
# ============================================================
log_step "Rollback: imagem e configuração"

# Sem `up -d` aqui de propósito: o `rollback()` do `deploy.sh` já sobe o
# compose, e refazer isso mediria o `up -d` do drill em vez do rollback. Se o
# rollback deixar o serviço de pé, o que reprova é a espera abaixo.
if wait_for_kid "${KID_V2}" 60; then
    log_pass "runtime voltou para KID=${KID_V2} (configuração correta)"
else
    fail "runtime não voltou para a v2 (obtido: '$(running_kid)')"
fi

# O rollback recria os containers, e o app precisa de alguns segundos para
# reconectar no Mongo e no Redis. Medir o marcador e o digest logo após o
# `compose up` lê um container ainda subindo e reprova um rollback correto.
wait_for_health() {
    local i
    for i in $(seq 1 60); do
        curl -fsS --max-time 3 "${BASE_URL}/health" >/dev/null 2>&1 && return 0
        sleep 2
    done
    return 1
}

wait_for_health || log_warn "health não respondeu em 120s; as asserções vão reprovar"

MARKER_AFTER="$(running_marker)"
if [ "$MARKER_AFTER" = "${MARKER_V2}" ]; then
    log_pass "imagem em execução é a da v2 (marcador ${MARKER_AFTER})"
else
    fail "imagem em execução diz '${MARKER_AFTER}'; esperado ${MARKER_V2}"
fi

ID_AFTER="$(running_image_id)"
if [ -n "$ID_V2" ] && [ "$ID_AFTER" = "$ID_V2" ]; then
    log_pass "digest da imagem em execução é o da v2 (${ID_AFTER:0:19}…)"
else
    fail "digest em execução ${ID_AFTER:0:19}… != digest da v2 ${ID_V2:0:19}…"
fi

# O serviço tem que responder de verdade, não só exibir a configuração certa: um
# container no ar com o env certo e o app quebrado seria um rollback inútil.
if curl -fsS --max-time 5 "${BASE_URL}/health" >/dev/null 2>&1; then
    log_pass "health responde 200 depois do rollback"
else
    fail "health não responde depois do rollback"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo -e "\033[0;32m✅ deploy.sh executou backup, readiness, smoke e rollback corretamente\033[0m"
    echo -e "   ${MARKER_V1} -> ${MARKER_V2} -> ${MARKER_V3}(quebrada) -> rollback para ${MARKER_V2}"
    exit 0
fi
echo -e "\033[0;31m❌ ${FAILURES} asserção(ões) falharam\033[0m"
exit 1