#!/usr/bin/env bash

# ====================================
# DRILL DE BACKUP/RESTAURAÇÃO DA CONFIGURAÇÃO EM VIGOR (Fase 2.3)
# Authentication Microservice
# ====================================
#
# A falha que esta fase fecha é silenciosa e específica: o deploy guarda a
# imagem anterior, mas o rollback volta a imagem usando o `.env.prod` que está
# em disco — o da versão nova. Configurar é mais do que "ter o arquivo": é ter
# o arquivo QUE RODAVA, com as chaves que a imagem usava.
#
# O drill provoca exatamente o erro que um backup ingênuo cometeria: capturar o
# arquivo em disco em vez do que estava no ar. O passo mais importante é o
# controle negativo no meio:
#
#   1. sobe o stack com uma versão/configuração DISTINTIVA e prova que o app a
#      exibe (via /observability, que ecoa service.version);
#   2. faz o backup (fonte da verdade = container em execução);
#   3. EDITA o env file em disco para valores novos, sem redeployar — e prova
#      que o container em execução continua com os valores antigos. Disco e
#      container divergiram, e o container é quem estava no ar;
#   4. destroi o env file e as chaves (disaster turnaround);
#   5. restaura do backup e RECARREGA o compose com o que foi restaurado;
#   6. prova em runtime que o app voltou com a configuração capturada (a
#      antiga), NÃO a do arquivo editado — se o backup tivesse lido o disco,
#      este passo traria a config errada e o drill falharia.
#
# O passo 3 é o que dá sentido ao 6: sem ele, "restaurou e o app voltou a
# exibir X" poderia simplesmente estar relendo o arquivo editado.
#
# Também exercita o caminho de rollback dos deploys: o restore é feito por
# `--match-image` (o metadata liga a config à imagem), que é o que
# deploy.sh/remote-deploy.sh usam.
#
# Uso:
#   scripts/test-config-backup.sh [--keep] [--skip-build]
#
# Códigos de saída:
#   0  a configuração restaurada reproduziu a que estava no ar
#   1  alguma asserção falhou
#   2  pré-requisito ausente (docker parado, curl/python3/gpg faltando)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

PROJECT="micrologin-config"
COMPOSE_FILE="docker-compose.config-test.yml"
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

KEEP_STACK=0
SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --keep)       KEEP_STACK=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

WAIT_READY_TIMEOUT="${WAIT_READY_TIMEOUT:-180}"
RUN_ID="$(date +%s)-$$"

CFG_TEST_PORT="${CFG_TEST_PORT:-3302}"
BASE_URL="http://localhost:${CFG_TEST_PORT}"
CFG_TEST_KEYS_DIR="${CFG_TEST_KEYS_DIR:-${ROOT_DIR}/.cfg-secrets}"
CFG_TEST_DEPS_DIR="${CFG_TEST_DEPS_DIR:-${CFG_TEST_KEYS_DIR}/deps}"
CFG_TEST_KID="${CFG_TEST_KID:-cfg-v1-${RUN_ID}}"
ENV_FILE="${ROOT_DIR}/.cfg-test.env"
PASSPHRASE_FILE="${ROOT_DIR}/.cfg-passphrase"
BACKUPS_DIR="${ROOT_DIR}/.cfg-backups"

VERSION_V1="cfg-v1-${RUN_ID}"
VERSION_V2="cfg-v2-editado-${RUN_ID}"

export CFG_TEST_PORT CFG_TEST_KEYS_DIR CFG_TEST_DEPS_DIR CFG_TEST_KID

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}"; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

cleanup() {
    if [ "$KEEP_STACK" -eq 1 ]; then
        log_warn "Stack mantido (--keep). Remova com:"
        echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down -v"
        echo "  rm -rf ${CFG_TEST_KEYS_DIR} ${CFG_TEST_DEPS_DIR} ${ENV_FILE} ${PASSPHRASE_FILE} ${BACKUPS_DIR}"
        return
    fi
    log_info "Destruindo o stack de teste e o material efêmero..."
    "${COMPOSE[@]}" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$CFG_TEST_KEYS_DIR" "$CFG_TEST_DEPS_DIR" "$ENV_FILE" "$PASSPHRASE_FILE" "$BACKUPS_DIR"
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || fail_usage "Docker não está rodando."
command -v curl >/dev/null 2>&1 || fail_usage "curl não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail_usage "python3 não encontrado no host."
command -v gpg >/dev/null 2>&1 || fail_usage "gpg não encontrado no host."

STATUS=""
BODY_FILE="$(mktemp)"
BODY=""
request() {
    local method="$1" path="$2" header="${3:-}"
    local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}")
    [ -n "$header" ] && args+=(-H "$header")
    STATUS=$(curl --max-time 15 "${args[@]}" 2>/dev/null || echo "000")
    BODY=$(cat "$BODY_FILE" 2>/dev/null || true)
}
json_field() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
value = data
for key in sys.argv[1].split("."):
    if not isinstance(value, dict) or key not in value:
        sys.exit(0)
    value = value[key]
print(value if value is not None else "")
' "$2" 2>/dev/null || true
}
wait_for() {
    local timeout="$1" what="$2"
    shift 2
    local deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    fail "esperou ${timeout}s por: ${what}"
}
observability_version() {
    request GET "/observability"
    [ "$STATUS" = "200" ] || return 1
    [ "$(json_field "$BODY" service.version)" != "" ]
    printf '%s' "$(json_field "$BODY" service.version)"
}
running_kid() {
    local cid
    cid="$(docker ps -q -f "label=com.docker.compose.project=${PROJECT}" -f "label=com.docker.compose.service=auth-service" | head -n1)"
    [ -n "$cid" ] || return 1
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null | grep '^JWT_ES256_KID=' | cut -d= -f2
}
app_cid() {
    docker ps -q -f "label=com.docker.compose.project=${PROJECT}" -f "label=com.docker.compose.service=auth-service" | head -n1
}
# sha de um segredo pelo container que o lê: o host não consegue ler arquivos
# 600 do uid 1001 (o nodeuser), e o que importa é o que está montado no app.
secret_sha() {
    local cid
    cid="$(app_cid)" || return 1
    docker exec "$cid" sh -c "sha256sum '/run/secrets/$1' 2>/dev/null" | cut -d' ' -f1
}

echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE} Drill de backup/restauração da configuração em vigor${NC}"
echo -e "${BLUE} Stack: ${PROJECT} @ ${BASE_URL}${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

# ============================================================
# 1. Stack de pé, com configuração distinta
# ============================================================
log_info "Subindo o stack de teste (build da imagem de produção inclusa)"
"${COMPOSE[@]}" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "$CFG_TEST_KEYS_DIR" "$CFG_TEST_DEPS_DIR" "$ENV_FILE" "$PASSPHRASE_FILE" "$BACKUPS_DIR"
mkdir -p "$BACKUPS_DIR"

bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$CFG_TEST_KEYS_DIR" "$CFG_TEST_KID" --for-container >/dev/null
bash "${SCRIPT_DIR}/generate-dependency-secrets.sh" "$CFG_TEST_DEPS_DIR" --for-container --skip-verify >/dev/null

cat > "$ENV_FILE" <<EOF
CFG_TEST_PORT=${CFG_TEST_PORT}
CFG_TEST_KEYS_DIR=${CFG_TEST_KEYS_DIR}
CFG_TEST_KID=${CFG_TEST_KID}
CFG_TEST_VERSION=${VERSION_V1}
EOF
printf 'drill-passphrase-2-3' > "$PASSPHRASE_FILE"; chmod 600 "$PASSPHRASE_FILE"

if [ "$SKIP_BUILD" -eq 1 ]; then
    mkdir -p "$CFG_TEST_KEYS_DIR" "$CFG_TEST_DEPS_DIR"
    "${COMPOSE[@]}" --env-file "$ENV_FILE" up -d --no-build >/dev/null 2>&1 || true
else
    "${COMPOSE[@]}" --env-file "$ENV_FILE" build >/dev/null 2>&1 || true
    "${COMPOSE[@]}" --env-file "$ENV_FILE" up -d >/dev/null
fi

wait_for "$WAIT_READY_TIMEOUT" "readiness 200" bash -c \
    "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${BASE_URL}/readiness)\" = '200' ]"
log_pass "stack no ar e pronto para tráfego"

V0="$(observability_version)"
[ "$V0" = "$VERSION_V1" ] || fail "app deveria exibir VERSION=${VERSION_V1}, mas exibe '${V0}'"
KID0="$(running_kid)"
[ "$KID0" = "$CFG_TEST_KID" ] || fail "container deveria rodar com KID=${CFG_TEST_KID}, mas tem '${KID0}'"
log_pass "app exibindo a configuração distinta (VERSION=${V0}, KID=${KID0})"

# sha das chaves e da senha ANTES do backup — a referência para provar que o
# restore devolveu EXATAMENTE o material que estava montado.
KEY_PRIVATE_SHA="$(secret_sha jwt-es256-private.pem)"
DEPS_REDIS_PWD_SHA="$(secret_sha deps/redis-password)"

# ============================================================
# 2. Backup da configuração em vigor
# ============================================================
log_info "Capturando a configuração EM EXECUÇÃO..."
ARCHIVE="$(bash "${SCRIPT_DIR}/backup-config.sh" \
    --project "$PROJECT" \
    --service auth-service \
    --env-file "$ENV_FILE" \
    --backups-dir "$BACKUPS_DIR" \
    --tag "cfgtest-${RUN_ID}" \
    --passphrase-file "$PASSPHRASE_FILE" 2>&1 | grep -oE 'cfg-[^ ]+\.tar\.gz\.gpg' | tail -n1)"
[ -n "$ARCHIVE" ] || fail "backup não produziu archive"
ARCHIVE_PATH="$BACKUPS_DIR/$ARCHIVE"
[ -f "$ARCHIVE_PATH" ] || fail "archive não encontrado em $BACKUPS_DIR"
log_pass "archive: ${ARCHIVE}"

# --check: o agendador de produção usa isto para alertar backup velho
bash "${SCRIPT_DIR}/backup-config.sh" --check --backups-dir "$BACKUPS_DIR" --max-age 24 \
    >/dev/null 2>&1 || fail "--check deveria confirmar um backup recém-criado"

# ============================================================
# 3. O controle negativo: disco e container divergidos
# ============================================================
log_warn "Editando o env file para ${VERSION_V2} SEM redeployar..."
cat > "$ENV_FILE" <<EOF
CFG_TEST_PORT=${CFG_TEST_PORT}
CFG_TEST_KEYS_DIR=${CFG_TEST_KEYS_DIR}
CFG_TEST_KID=cfg-v2-editado
CFG_TEST_VERSION=${VERSION_V2}
EOF

DISK_VERSION="$(grep '^CFG_TEST_VERSION=' "$ENV_FILE" | cut -d= -f2)"
[ "$DISK_VERSION" = "$VERSION_V2" ] || fail "precisamos que o disco esteja em ${VERSION_V2} (está em ${DISK_VERSION})"
KID_RUNNING_AFTER_EDIT="$(running_kid)"
[ "$KID_RUNNING_AFTER_EDIT" = "$CFG_TEST_KID" ] || fail "o container deveria continuar com o KID antigo; mudou para '${KID_RUNNING_AFTER_EDIT}'"
log_pass "disco=${VERSION_V2} vs container KID=${KID_RUNNING_AFTER_EDIT} (fonte da verdade = container)"

# ============================================================
# 4. Disaster: perde-se env file e material de segredo
# ============================================================
log_warn "Simulando perda: apagando env file e segredos do disco..."
rm -f "$ENV_FILE"
rm -rf "$CFG_TEST_KEYS_DIR" "$CFG_TEST_DEPS_DIR"
[ ! -e "$ENV_FILE" ] && [ ! -e "$CFG_TEST_KEYS_DIR" ] && [ ! -e "$CFG_TEST_DEPS_DIR" ] \
    || fail "material não foi destruído; o drill avançaria sobre ubiquidade errada"
log_pass "nada resta em disco"
docker ps -q -f "label=com.docker.compose.project=${PROJECT}" >/dev/null 2>&1 \
    && log_info "o container antigo segue no ar — com a configuração v1"

# ============================================================
# 5. Restauração (pelo caminho de rollback: --match-image)
# ============================================================
log_info "Restaurando pelo metadata da imagem (caminho do rollback)..."
# --match-image: é o que deploy.sh/remote-deploy.sh usam no rollback: acham o
# archive cuja config corresponde à imagem anterior, sem decifrar todo mundo.
bash "${SCRIPT_DIR}/restore-config.sh" \
    --match-image "micrologin-config:local" \
    --passphrase-file "$PASSPHRASE_FILE" \
    --backups-dir "$BACKUPS_DIR" \
    --target-dir "$ROOT_DIR" \
    --env-file-out "$(basename "$ENV_FILE")" \
    --yes >/dev/null

[ -f "$ENV_FILE" ] || fail "env file não foi restaurado"
[ -f "$CFG_TEST_KEYS_DIR/jwt-es256-private.pem" ] || fail "chave privada não foi restaurada"
[ -f "$CFG_TEST_DEPS_DIR/redis-password" ] || fail "senha do Redis não foi restaurada"

RESTORED_VERSION="$(grep '^CFG_TEST_VERSION=' "$ENV_FILE" | cut -d= -f2)"
[ "$RESTORED_VERSION" = "$VERSION_V1" ] \
    || fail "restore trouxe ${RESTORED_VERSION} — deveria vir o valor EM EXECUÇÃO (${VERSION_V1}), não o do disco editado (${VERSION_V2}). O backup capturou a fonte errada."
log_pass "env file e chaves restaurados com os valores que ESTAVAM RODANDO"

# ============================================================
# 6. Prova em runtime: redeploy com o que foi restaurado
# ============================================================
log_info "Recarregando o compose com a configuração restaurada (imagem + config)..."
"${COMPOSE[@]}" --env-file "$ENV_FILE" up -d --force-recreate >/dev/null

wait_for "$WAIT_READY_TIMEOUT" "readiness 200 após redeploy" bash -c \
    "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${BASE_URL}/readiness)\" = '200' ]"

V_FINAL="$(observability_version)"
[ "$V_FINAL" = "$VERSION_V1" ] \
    || fail "após o restore/redeploy o app exibe VERSION=${V_FINAL}, esperado ${VERSION_V1} (a config capturada em execução)"
KID_FINAL="$(running_kid)"
[ "$KID_FINAL" = "$CFG_TEST_KID" ] \
    || fail "após o restore/redeploy o KID é '${KID_FINAL}', esperado '${CFG_TEST_KID}'"
FINAL_KEY_SHA="$(secret_sha jwt-es256-private.pem)"
[ "$FINAL_KEY_SHA" = "$KEY_PRIVATE_SHA" ] \
    || fail "chave privada após o redeploy difere da capturada (${FINAL_KEY_SHA} vs ${KEY_PRIVATE_SHA})"
FINAL_REDIS_PWD_SHA="$(secret_sha deps/redis-password)"
[ "$FINAL_REDIS_PWD_SHA" = "$DEPS_REDIS_PWD_SHA" ] \
    || fail "senha do Redis após o redeploy difere da capturada (${FINAL_REDIS_PWD_SHA} vs ${DEPS_REDIS_PWD_SHA})"
request GET "/health"
[ "$STATUS" = "200" ] || fail "/health respondeu ${STATUS} após o redeploy"

echo ""
echo -e "${GREEN}🎉 Backup/restauração de configuração verificada: o app voltou a rodar${NC}"
echo -e "${GREEN}   com a MESMA configuração capturada (VERSION=${V_FINAL}), e não com a do disco editado.${NC}"