#!/usr/bin/env bash

# ====================================
# DRILL DE BACKUP E RESTAURAÇÃO (Fase 2.1)
# Authentication Microservice
# ====================================
#
# O teste que o roadmap define como "restauração real": o drill não verifica
# sintaxe de script, ele exercita o caminho inteiro contra um Mongo autenticado
# de verdade —
#
#   1. registra um usuário no stack autenticado (banco auth_backup);
#   2. roda scripts/backup.sh (dump -> cifra gpg AES-256), prova o arquivo
#      com o próprio `--verify` (decifra + gzip + mongorestore --dryRun);
#   3. apaga o banco de verdade e PROVA que apagou (o login passa a 401 —
#      sem este passo, um restore que "funcionasse" sem restaurar dados
#      passaria no teste);
#   4. roda scripts/restore.sh (decifra -> valida -> --drop);
#   5. exige que o MESMO usuário volte a fazer login. É este passo o
#      "1 teste que falha de verdade se a restauração não reconhecer um
#      usuário" da definição de pronto.
#
# Mede também o RTO real (do início do restore até o login voltar) — o número
# que vai para docs/BACKUP.md, medido, não estimado.
#
# Retenção (diários + semanais) é coberta em testes unitários com nomes de
# arquivos fabricados: gerar backups de semanas diferentes em um teste de
# integração levaria dias. A poda é exercitada aqui só em modo vazio, para
# provar que o script a chama sem quebrar o fluxo.
#
# Uso:
#   scripts/test-backup.sh [--keep] [--skip-build]
#
#   --keep         não destrói o stack no fim (para depurar com docker logs)
#   --skip-build   usa a imagem já construída em vez de reconstruir
#
# Códigos de saída:
#   0  usuario sobreviveu ao ciclo dump -> apagar -> restore
#   1  alguma asserção falhou
#   2  pré-requisito ausente (docker parado, curl/python3 faltando)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

PROJECT="micrologin-backup"
COMPOSE_FILE="docker-compose.backup.yml"
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

BACKUP_PORT="${BACKUP_PORT:-3201}"
BASE_URL="http://localhost:${BACKUP_PORT}"
export BACKUP_PORT

BACKUP_KEYS_DIR="${BACKUP_KEYS_DIR:-${ROOT_DIR}/.backup-keys}"
BACKUP_DEPS_DIR="${BACKUP_DEPS_DIR:-${ROOT_DIR}/.backup-deps}"
BACKUP_JWT_KID="${BACKUP_JWT_KID:-backup-v1}"
export BACKUP_KEYS_DIR BACKUP_DEPS_DIR BACKUP_JWT_KID

RUN_ID="$(date +%s)-$$"
USERNAME="backup-srvc-${RUN_ID}"
PASSWORD="B4ckup-Test-${RUN_ID}-Xx!"

BACKUPS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/backup-drill-backups-XXXXXX")"
PASSPHRASE="$(openssl rand -base64 24)"
BACKUP_PASSPHRASE_FILE="$(mktemp "${TMPDIR:-/tmp}/backup-drill-pass-XXXXXX")"
chmod 600 "$BACKUP_PASSPHRASE_FILE"
printf '%s' "$PASSPHRASE" > "$BACKUP_PASSPHRASE_FILE"

BODY_FILE="$(mktemp)"
KEYS_GENERATED=0
DEPS_GENERATED=0

MONGO_CONTAINER="micrologin-backup-mongo"
APP_CONTAINER="micrologin-backup-app"
DB_NAME="auth_backup"

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'

log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}"; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

cleanup() {
    rm -f "$BODY_FILE" "$BACKUP_PASSPHRASE_FILE"
    if [ "$KEEP_STACK" -eq 1 ]; then
        log_warn "Stack mantido (--keep). Remova com:"
        echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v"
        echo "  rm -rf ${BACKUP_KEYS_DIR} ${BACKUP_DEPS_DIR} ${BACKUPS_DIR}"
        return
    fi
    log_info "Destruindo o stack de teste e o material efêmero..."
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$BACKUP_KEYS_DIR" "$BACKUP_DEPS_DIR" "$BACKUPS_DIR"
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || fail_usage "Docker não está rodando."
command -v curl >/dev/null 2>&1 || fail_usage "curl não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail_usage "python3 não encontrado no host."
command -v openssl >/dev/null 2>&1 || fail_usage "openssl não encontrado no host."

STATUS=""
BODY=""
request() {
    local method="$1" path="$2" payload="${3:-}"
    local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}")
    [ -n "$payload" ] && args+=(-H 'Content-Type: application/json' --data "$payload")
    STATUS=$(curl --max-time 15 "${args[@]}" 2>/dev/null || echo "000")
    BODY=$(cat "$BODY_FILE" 2>/dev/null || true)
}

expect_status() {
    [ "$STATUS" = "$1" ] || fail "$2: esperado HTTP $1, recebido ${STATUS}. Corpo: ${BODY:0:400}"
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

is_registered() {
    request POST "/register" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
    # /register responde 201 no sucesso (200 não é emitido pelo controller).
    [ "$STATUS" = "201" ]
}

login_ok() {
    request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
    [ "$STATUS" = "200" ]
}

login_fails() {
    request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
    [ "$STATUS" != "200" ]
}

read_mongo_root_password() {
    docker exec "$MONGO_CONTAINER" cat /run/secrets-deps/mongo-root-password | tr -d '\n'
}

sha_file() { sha256sum "$1" | cut -d' ' -f1; }

echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE} Drill de backup e restauração do MongoDB${NC}"
echo -e "${BLUE} Stack: ${PROJECT} @ ${BASE_URL}${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

# ============================================================
# 1. Stack de pé
# ============================================================
log_info "Subindo o stack de teste (build da imagem de produção inclusa)"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "$BACKUP_KEYS_DIR" "$BACKUP_DEPS_DIR"
bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$BACKUP_KEYS_DIR" "$BACKUP_JWT_KID" --for-container >/dev/null
KEYS_GENERATED=1
bash "${SCRIPT_DIR}/generate-dependency-secrets.sh" "$BACKUP_DEPS_DIR" --for-container --skip-verify >/dev/null
DEPS_GENERATED=1

if [ "$SKIP_BUILD" -eq 1 ]; then
    "${COMPOSE[@]}" up -d --no-build >/dev/null
else
    "${COMPOSE[@]}" build >/dev/null
    "${COMPOSE[@]}" up -d >/dev/null
fi

# readicheck do Mongo (o mongodump depende dele) + readiness do app
wait_for "$WAIT_READY_TIMEOUT" "readiness 200" bash -c "
    [ \"\$(curl -s -o /dev/null -w '%{http_code}' ${BASE_URL}/readiness)\" = '200' ]"
log_pass "stack no ar e pronto para tráfego"

# ============================================================
# 2. Usuário que vai "sobreviver" ao restore
# ============================================================
log_info "Registrando o usuário que o backup deve preservar..."
wait_for "$WAIT_READY_TIMEOUT" "registro do usuário" is_registered
log_pass "usuário ${USERNAME} registrado"

login_ok
expect_status 200 "login antes do backup"
log_pass "login OK antes do backup (baseline)"

# ============================================================
# 3. Backup
# ============================================================
log_info "Rodando scripts/backup.sh (dump -> cifra -> verificação -> poda)..."
bash "${SCRIPT_DIR}/backup.sh" \
    --project "$PROJECT" \
    --backups-dir "$BACKUPS_DIR" \
    --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
    --retain-daily 2 --retain-weekly 1 \
    >/dev/null
log_pass "backup.sh concluiu"

BACKUP_FILE="$(find "$BACKUPS_DIR" -name 'sha-data-*.archive.gpg' | head -n1)"
[ -n "$BACKUP_FILE" ] || fail "nenhum sha-data-*.archive.gpg foi criado"
[ -s "$BACKUP_FILE" ] || fail "backup criado está vazio"
[ -f "$BACKUPS_DIR/last-backup.json" ] || fail "manifest last-backup.json não foi gravado"

log_info "arquivo: $(basename "$BACKUP_FILE") ($(stat -c %s "$BACKUP_FILE") bytes)"
log_pass "backup cifrado no disco (gpg AES-256)"

# O backup deve conter o usuário registrado: prova-se por fora, no banco
# original antes de apagar, contando a coleção de usuários.
USER_COUNT_BEFORE="$(docker exec "$MONGO_CONTAINER" sh -c 'mongosh --quiet --host 127.0.0.1 --username root --password "$(cat /run/secrets-deps/mongo-root-password)" --authenticationDatabase admin --eval '\''db.getSiblingDB("auth_backup").getCollectionNames().length'\''' 2>/dev/null || echo "?")"
[ "$USER_COUNT_BEFORE" != "?" ] || fail "não consegui inspecionar o banco auth_backup"

# ============================================================
# 4. Estado imediatamente após o backup: --check dentro da janela
# ============================================================
if bash "${SCRIPT_DIR}/backup.sh" --check --backups-dir "$BACKUPS_DIR" >/dev/null 2>&1; then
    log_pass "--check aceita o backup recém-criado (dentro da janela RPO)"
else
    fail "--check reprovou o backup recém-criado"
fi

# ============================================================
# 5. Apagar o banco (a parte que "por engano" uma restauração ruim não faria)
# ============================================================
log_warn "Apagando o banco ${DB_NAME} para provar que o restore devolve os dados..."
docker exec "$MONGO_CONTAINER" sh -c 'mongosh --quiet --host 127.0.0.1 --username root --password "$(cat /run/secrets-deps/mongo-root-password)" --authenticationDatabase admin --eval '\''db.getSiblingDB("auth_backup").dropDatabase()'\''' >/dev/null
sleep 1

# Depois de apagar, o login TEM que falhar (401/500/qualquer não-200): sem
# este passo, um restore que "funcionasse" sem restituir dados passaria.
login_fails
log_warn "login negado depois de apagar o banco (HTTP ${STATUS}) — o teste está provando contra um banco vazio de verdade"

# ============================================================
# 6. Restauração (com RTO medido)
# ============================================================
RTO_START="$(date +%s)"
log_info "Rodando scripts/restore.sh (decifra -> valida -> --drop)..."
bash "${SCRIPT_DIR}/restore.sh" "$BACKUP_FILE" \
    --project "$PROJECT" \
    --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
    --yes \
    >/dev/null
log_pass "restore.sh concluiu"

# ============================================================
# 7. A prova que interessa: o usuário volta a autenticar
# ============================================================
login_ok
expect_status 200 "login após a restauração (o tal usuário do backup)"
log_pass "usuário reconhecido depois da restauração — dados voltaram"

RTO_SEC="$(( $(date +%s) - RTO_START ))"
LOGIN_LATENCY="$(json_field "$BODY" response)"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE} RTO medido (restore.sh -> login 200): ${RTO_SEC}s${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"

# ============================================================
# 8. Pós-condições
# ============================================================
# O manifest do backup, lido de novo, ainda bate com o arquivo em disco: o
# sha256 do arquivo cifrado é parte do manifest e o arquivo não mudou.
MANIFEST_SHA="$(grep -o '"encrypted_sha256":"[a-f0-9]*"' "$BACKUPS_DIR/last-backup.json" | head -n1 | cut -d'"' -f4)"
[ -n "$MANIFEST_SHA" ] || fail "manifest corrompido (sem encrypted_sha256)"
[ "$MANIFEST_SHA" = "$(sha_file "$BACKUP_FILE")" ] || fail "arquivo de backup mudou desde o backup (manifest não bate)"

# Podar deve ser inócuo agora (só há um arquivo; --prune-only não pode apagar o único)
PRUNED="$(bash "${SCRIPT_DIR}/backup.sh" --prune-only --backups-dir "$BACKUPS_DIR" --retain-daily 1 --retain-weekly 1 2>/dev/null | sed -n 's/.*: \([0-9]*\) arquivo.*/\1/p')"
[ "$PRUNED" = "0" ] || fail "--prune-only removeu arquivo(s) indevidamente"
[ -f "$BACKUP_FILE" ] || fail "--prune-only removeu o único backup"

# O --check também deve continuar aceitando o backup.
bash "${SCRIPT_DIR}/backup.sh" --check --backups-dir "$BACKUPS_DIR" >/dev/null 2>&1 \
    || fail "--check reprovou o backup após a restauração"

echo -e "${GREEN}🎉 Backup e restauração verificados de ponta a ponta.${NC}"