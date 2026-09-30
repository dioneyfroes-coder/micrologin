#!/usr/bin/env bash

# ====================================
# RESTAURAÇÃO DO MONGODB (Fase 2.1)
# Authentication Microservice
# ====================================
#
# Restaura um backup `sha-data-*.archive.gpg` feito por scripts/backup.sh.
# O fluxo é o inverso do backup com a mesma propriedade: o arquivo cifrado só
# toca o disco do host, decifra no ar contra `mongorestore` no container do
# Mongo, e o `--drop` substitui as coleções atuais pelas do backup.
#
# Ordem de segurança:
#   1. decifra e valida o arquivo com `mongorestore --dryRun` (não escreve
#      nada) — um backup truncado/corrompido NÃO encosta nos dados atuais;
#   2. restaura com `--drop` apenas depois de o `--dryRun` ter passado.
#
# Quem executa o restore precisa SÓ do arquivo cifrado + passphrase: nenhuma
# credencial de servidor, nenhum shell no host da aplicação. É isto que o
# roadmap chama de "restauração pontual só com o dump criptografado".
#
# Uso:
#   scripts/restore.sh [ARQUIVO|latest] [opções]
#
# Opções:
#   ARQUIVO                 caminho do .archive.gpg (ou "latest" -> o mais
#                           novo em --backups-dir)
#   --project NOME          projeto compose com o Mongo (padrão: micrologin)
#   --backups-dir DIR       usado com "latest" (padrão: ./backups)
#   --passphrase-file ARQ   arquivo com a passphrase da cifra
#   --yes                   não pede confirmação antes do --drop
#   --dry-run               só valida (decifra + mongorestore --dryRun), não
#                           restaura nada
#
# Códigos de saída:
#   0  restaurado (ou --dry-run validado)
#   1  falha na validação/restauração
#   2  uso errado ou pré-requisito ausente
#
# Aviso: o `--drop` também substitui admin.system.users (usuários do banco)
# pela versão do backup. Depois de uma restauração, senhas de root/app devem
# corresponder ao estado do dump ou serem rotacionadas — ver docs/BACKUP.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PROJECT="micrologin"
BACKUPS_DIR="${ROOT_DIR}/backups"
PASSPHRASE_FILE=""
FORCE_YES=0
DRY_RUN=0
TARGET=""

usage() {
    echo "uso: $0 [ARQUIVO|latest] [--project NOME] [--backups-dir DIR]" >&2
    echo "        [--passphrase-file ARQ] [--yes] [--dry-run]" >&2
    exit 2
}

# O primeiro argumento posicional é o arquivo a restaurar.
[ "$#" -ge 1 ] || { echo "faltou o arquivo de backup (ou 'latest')" >&2; usage; }
TARGET="$1"
shift

while [ "$#" -gt 0 ]; do
    case "$1" in
        --project)        PROJECT="${2:?valor exigido para --project}"; shift 2 ;;
        --backups-dir)    BACKUPS_DIR="${2:?valor exigido para --backups-dir}"; shift 2 ;;
        --passphrase-file) PASSPHRASE_FILE="${2:?valor exigido para --passphrase-file}"; shift 2 ;;
        --yes)            FORCE_YES=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -h|--help)        usage ;;
        *)                echo "argumento desconhecido: $1" >&2; usage ;;
    esac
done

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

TMP_PASSPHRASE_FILE=""
TMP_ARCHIVE=""
cleanup() {
    [ -n "$TMP_PASSPHRASE_FILE" ] && rm -f "$TMP_PASSPHRASE_FILE"
    [ -n "$TMP_ARCHIVE" ] && rm -f "$TMP_ARCHIVE"
    :
}
trap cleanup EXIT

resolve_passphrase_file() {
    if [ -z "$PASSPHRASE_FILE" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]; then
        TMP_PASSPHRASE_FILE="$(mktemp "${TMPDIR:-/tmp}/restore-passphrase-XXXXXX")"
        chmod 600 "$TMP_PASSPHRASE_FILE"
        printf '%s' "$BACKUP_PASSPHRASE" > "$TMP_PASSPHRASE_FILE"
        PASSPHRASE_FILE="$TMP_PASSPHRASE_FILE"
        log_warn "passphrase vinda de BACKUP_PASSPHRASE (descartada no fim)"
    fi
    [ -n "$PASSPHRASE_FILE" ] || fail_usage "sem passphrase: use --passphrase-file ARQ ou BACKUP_PASSPHRASE"
    [ -f "$PASSPHRASE_FILE" ] || fail_usage "arquivo de passphrase não encontrado: $PASSPHRASE_FILE"
}

resolve_target() {
    if [ "$TARGET" = "latest" ]; then
        TARGET="$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name 'sha-data-*.archive.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n1 | cut -d' ' -f2-)"
        [ -n "$TARGET" ] || fail_usage "nenhum sha-data-*.archive.gpg em ${BACKUPS_DIR}"
    fi
    [ -f "$TARGET" ] || fail_usage "arquivo de backup não encontrado: $TARGET"
    case "$(basename "$TARGET")" in
        sha-data-*.archive.gpg) ;;
        *) fail_usage "o arquivo não parece um backup do projeto (sha-data-*.archive.gpg): $TARGET" ;;
    esac
}

resolve_mongo_container() {
    local ctr
    ctr="$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
        --filter "label=com.docker.compose.service=mongodb" \
        --format '{{.Names}}' 2>/dev/null | head -n1)"
    [ -n "$ctr" ] || fail_usage "container do Mongo do projeto '${PROJECT}' não está rodando"
    docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null | grep -q '^true$' \
        || fail "container $ctr não está em estado running"
    echo "$ctr"
}

MONGO_PASSWORD_PATH_IN_CONTAINER="/run/secrets/deps/mongo-root-password"

GPG() { gpg --batch --yes --no-tty "$@"; }

TMP_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/restore-$$-XXXXXX.archive")"

decrypt_to_stdout() {
    GPG --decrypt --passphrase-file "$PASSPHRASE_FILE" "$TARGET" 2>/dev/null
}

# dry_run <container> <vfile-no-container>: valida o archive sem escrever nada.
# Retorna 0 se o mongorestore aceitou o arquivo de ponta a ponta.
dry_run_in_container() {
    local ctr="$1" vfile="$2"
    docker cp "$TMP_ARCHIVE" "$ctr:/tmp/$vfile" >/dev/null
    if ! docker exec "$ctr" sh -c "mongorestore --host 127.0.0.1 --authenticationDatabase admin --username root --password \"\$(cat $MONGO_PASSWORD_PATH_IN_CONTAINER)\" --archive=/tmp/$vfile --gzip --dryRun" >/dev/null 2>&1; then
        docker exec "$ctr" rm -f "/tmp/$vfile" >/dev/null 2>&1 || true
        return 1
    fi
    docker exec "$ctr" rm -f "/tmp/$vfile" >/dev/null 2>&1 || true
    return 0
}

restore_in_container() {
    local ctr="$1" vfile="$2"
    # O dry_run removeu a cópia do container; é preciso copiar de novo.
    docker cp "$TMP_ARCHIVE" "$ctr:/tmp/$vfile" >/dev/null
    if ! docker exec "$ctr" sh -c "mongorestore --host 127.0.0.1 --authenticationDatabase admin --username root --password \"\$(cat $MONGO_PASSWORD_PATH_IN_CONTAINER)\" --archive=/tmp/$vfile --gzip --drop --stopOnError" 2>&1; then
        return 1
    fi
    docker exec "$ctr" rm -f "/tmp/$vfile" >/dev/null 2>&1 || true
    return 0
}

# ============================================================
# MAIN
# ============================================================
command -v gpg >/dev/null 2>&1 || { echo "gpg não encontrado no host." >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker não está rodando." >&2; exit 2; }

resolve_passphrase_file
resolve_target
ctr="$(resolve_mongo_container)"

log_info "arquivo: $(basename "$TARGET")"
log_info "container: ${ctr} (projeto ${PROJECT})"

# 1) Integridade: gzip válido no fluxo decifrado.
if ! decrypt_to_stdout | gzip -t; then
    fail "o arquivo decifrado não é um gzip íntegro — backup corrompido ou passphrase errada"
fi

# 2) O arquivo precisa ser um dump de verdade (parseia de ponta a ponta).
decrypt_to_stdout > "$TMP_ARCHIVE"
vfile="restore-$$.archive"
if ! dry_run_in_container "$ctr" "$vfile"; then
    rm -f "$TMP_ARCHIVE"
    fail "mongorestore rejeitou o arquivo decifrado no --dryRun — nada foi restaurado"
fi
log_pass "backup validado (decifra + gzip + --dryRun): dados atuais preservados"

if [ "$DRY_RUN" -eq 1 ]; then
    log_pass "modo --dry-run: nada foi alterado no banco"
    exit 0
fi

# 3) Confirmação explícita: restaurar é destrutivo.
if [ "$FORCE_YES" -ne 1 ]; then
    printf '%s' "Restaurar $(basename "$TARGET") em ${ctr} (--drop substitui as coleções atuais)? [s/N] "
    read -r answer
    case "$answer" in s|S|sim|SIM) ;; *) log_warn "cancelado"; exit 0 ;; esac
fi

if restore_in_container "$ctr" "$vfile"; then
    # o container eliminou o archive temporário; sobra apenas o original cifrado
    rm -f "$TMP_ARCHIVE"
    log_pass "restauração concluída: $(basename "$TARGET")"
else
    rm -f "$TMP_ARCHIVE"
    fail "mongorestore --drop falhou — o banco pode estar em estado parcial (veja os logs acima)"
fi