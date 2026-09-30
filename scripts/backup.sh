#!/usr/bin/env bash

# ====================================
# BACKUP DO MONGODB (Fase 2.1)
# Authentication Microservice
# ====================================
#
# Faz `mongodump` do MongoDB e cifra o resultado diretamente na saída, sem
# passar por disco em claro: o dump sai pelo stdout do container do Mongo
# (gzip dentro do próprio `--archive`) e entra na cifra gpg AES-256 simétrica
# no host. O que sobra no disco é só o arquivo `sha-data-<data>.archive.gpg`.
#
# Por que gpg e não age (o roadmap cita "age/gpg simétrico"): age não existe
# na base do host nem nas imagens já usadas pelo projeto, e baixar um binário
# só para o backup é uma dependência nova; gpg já está presente. A cifra é a
# mesma classe (AES-256 simétrica, segredo fora do repositório).
#
# Por que `--archive` e não `mongodump --dir` + tar (o roadmap cita tar):
# o archive é um fluxo único — atômico por construção, sem o segundo ponto de
# falha de empacotar um diretório (um tar pode completar depois de um dump
# parcial; aqui o `--dryRun` do `mongorestore` rejeita o arquivo quebrado).
#
# O que o backup NÃO é: snapshot. `mongodump` é consistente por coleção (não
# é um ponto no tempo do disco). Para uma base de autenticação pequena isso é
# o contrato que o roadmap pediu; o limite está documentado em docs/BACKUP.md.
#
# O arquivo de passphrase não entra no repositório e não vai na linha de
# comando (nada de `ps` vazando segredo no host): vai por `--passphrase-file`
# ou `BACKUP_PASSPHRASE` no ambiente.
#
# Uso:
#   scripts/backup.sh [opções]
#
# Opções:
#   --project NOME            projeto compose com o Mongo (padrão: micrologin).
#                             O container é resolvido por label, não por nome.
#   --backups-dir DIR         diretório destino (padrão: ./backups)
#   --passphrase-file ARQ     arquivo com a passphrase da cifra
#   --retain-daily N          diários mantidos (padrão: 7)
#   --retain-weekly M         semanas mantidas, arquivo mais novo por ISO week
#                             (padrão: 4)
#   --rpo-hours H             janela de perda aceitável, usada pelo --check e
#                             gravada no manifest (padrão: 24)
#   --skip-verify             não valida o backup recém-criado (dump + gzip)
#   --prune-only              só aplica retenção; não faz backup
#   --check                   verifica se o último backup existe e tem no máximo
#                             `--rpo-hours` de idade; não faz backup
#   --max-age H               idade máxima para o --check (padrão: --rpo-hours)
#
# Códigos de saída:
#   0  backup criado e verificado (ou poda/check OK)
#   1  falha (dump, cifra, verificação ou poda); emite evento estruturado
#   2  uso errado ou pré-requisito ausente
#
# O comando que agenda isto em produção (cron/systemd) deve reagir ao exit
# code e ao último evento estruturado no stderr — ver docs/BACKUP.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PROJECT="micrologin"
BACKUPS_DIR="${ROOT_DIR}/backups"
RETAIN_DAILY=7
RETAIN_WEEKLY=4
RPO_HOURS=24
PASSPHRASE_FILE=""
MAX_AGE=""
SKIP_VERIFY=0
PRUNE_ONLY=0
CHECK_ONLY=0

usage() {
    echo "uso: $0 [--project NOME] [--backups-dir DIR] [--passphrase-file ARQ]" >&2
    echo "        [--retain-daily N] [--retain-weekly M] [--rpo-hours H]" >&2
    echo "        [--skip-verify] [--prune-only] [--check] [--max-age H]" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --project)        PROJECT="${2:?valor exigido para --project}"; shift 2 ;;
        --backups-dir)    BACKUPS_DIR="${2:?valor exigido para --backups-dir}"; shift 2 ;;
        --passphrase-file) PASSPHRASE_FILE="${2:?valor exigido para --passphrase-file}"; shift 2 ;;
        --retain-daily)   RETAIN_DAILY="${2:?valor exigido para --retain-daily}"; shift 2 ;;
        --retain-weekly)  RETAIN_WEEKLY="${2:?valor exigido para --retain-weekly}"; shift 2 ;;
        --rpo-hours)      RPO_HOURS="${2:?valor exigido para --rpo-hours}"; shift 2 ;;
        --max-age)        MAX_AGE="${2:?valor exigido para --max-age}"; shift 2 ;;
        --skip-verify)    SKIP_VERIFY=1; shift ;;
        --prune-only)     PRUNE_ONLY=1; shift ;;
        --check)          CHECK_ONLY=1; shift ;;
        -h|--help)        usage ;;
        *)                echo "argumento desconhecido: $1" >&2; usage ;;
    esac
done

for v in "$RETAIN_DAILY" "$RETAIN_WEEKLY" "$RPO_HOURS"; do
    case "$v" in
        ''|*[!0-9]*) echo "retain/rpo precisam ser inteiros positivos" >&2; exit 2 ;;
    esac
done
[ "$RETAIN_DAILY" -ge 1 ] && [ "$RETAIN_WEEKLY" -ge 1 ] && [ "$RPO_HOURS" -ge 1 ] \
    || { echo "retain/rpo precisam ser >= 1" >&2; exit 2; }

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}" >&2; emit_failed "$1"; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

TMP_PASSPHRASE_FILE=""
cleanup() {
    [ -n "$TMP_PASSPHRASE_FILE" ] && rm -f "$TMP_PASSPHRASE_FILE"
    :
}
trap cleanup EXIT

# ============================================================
# SEGREDO DA CIFRA
# ============================================================
resolve_passphrase_file() {
    if [ -z "$PASSPHRASE_FILE" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]; then
        TMP_PASSPHRASE_FILE="$(mktemp "${TMPDIR:-/tmp}/backup-passphrase-XXXXXX")"
        chmod 600 "$TMP_PASSPHRASE_FILE"
        printf '%s' "$BACKUP_PASSPHRASE" > "$TMP_PASSPHRASE_FILE"
        PASSPHRASE_FILE="$TMP_PASSPHRASE_FILE"
        log_warn "passphrase vinda de BACKUP_PASSPHRASE (descartada no fim); o modo recomendado é --passphrase-file"
    fi
    [ -n "$PASSPHRASE_FILE" ] || fail_usage "sem passphrase: use --passphrase-file ARQ ou BACKUP_PASSPHRASE"
    [ -f "$PASSPHRASE_FILE" ] || fail_usage "arquivo de passphrase não encontrado: $PASSPHRASE_FILE"
    local mode
    mode="$(stat -c '%a' "$PASSPHRASE_FILE" 2>/dev/null || echo "???")"
    case "$mode" in
        ???) [ "${mode:1:2}" = "00" ] || log_warn "passphrase em $PASSPHRASE_FILE legível por grupo/outros (modo $mode) — considere chmod 600" ;;
        *) log_warn "não foi possível conferir o modo da passphrase" ;;
    esac
    [ "$(stat -c '%u' "$PASSPHRASE_FILE" 2>/dev/null || echo '?')" = "$(id -u)" ] \
        || log_warn "passphrase não é do mesmo dono do usuário atual"
}

# ============================================================
# CONTAINER DO MONGO
# ============================================================
resolve_mongo_container() {
    local ctr
    ctr="$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
        --filter "label=com.docker.compose.service=mongodb" \
        --format '{{.Names}}' 2>/dev/null | head -n1)"
    [ -n "$ctr" ] || fail_usage "container do Mongo do projeto '${PROJECT}' não está rodando"
    # Evoluções de esquema do compose mudariam o nome do serviço; o `não
    # encontrado` aqui deve apontar para o lugar certo.
    docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null | grep -q '^true$' \
        || fail "container $ctr não está em estado running"
    echo "$ctr"
}

# O argparse da ferramenta de restore leva a mesma leitura: sempre dentro do
# container, do arquivo que o deploy montou. O caminho é o que os composes
# usam (docker-compose.prod.yml, docker-compose.resilience.yml).
MONGO_PASSWORD_PATH_IN_CONTAINER="/run/secrets/deps/mongo-root-password"

# ============================================================
# EVENTOS ESTRUTURADOS
# ============================================================
# Emite um JSON de uma linha no stderr — a fonte que o monitor/agendador
# consome (alerta quando backup falha ou fica velho). Sem validação JSON:
# os valores são fixos ou gerados por `date`/`wc`/etc., nunca input do usuário.
emit() { # emit <event> <nome>=<valor>...
    local ev="$1"; shift
    local line="{\"event\":\"${ev}\""
    local kv
    for kv in "$@"; do
        line+=",\"${kv%%=*}\":\"${kv#*=}\""
    done
    line+="}"
    echo "$line" >&2
}

emit_failed() { emit backup_failed where=backup reason="$1" project="$PROJECT"; }

# ============================================================
# RÓTULO, SEMANA ISO, PODA
# ============================================================
# sha-data-20260930T120000Z.archive.gpg -> ISO week (GNU date)
stamp_to_iso_week() {
    local base stamp ymd hm
    base="$(basename "$1")"
    stamp="${base#sha-data-}"
    stamp="${stamp%.archive.gpg}"
    ymd="${stamp%T*}"
    hm="${stamp#*T}"; hm="${hm%Z}"
    date -u -d "${ymd:0:4}-${ymd:4:2}-${ymd:6:2} ${hm:0:2}:${hm:2:2}:${hm:4:2}" +%G-W%V
}

# Lista os backups em ordem cronológica (nome carrega o timestamp UTC).
list_backups() {
    find "$1" -maxdepth 1 -type f -name 'sha-data-*.archive.gpg' -printf '%f\n'  2>/dev/null | sort
}

# Retenção: mantém os N arquivos mais novos + o arquivo mais novo de cada uma
# das M últimas semanas ISO. Imprime quantos foram removidos.
prune_backups() {
    local dir="$1" daily="$2" weekly="$3"
    local -a all=()
    local f
    while IFS= read -r f; do all+=("$dir/$f"); done < <(list_backups "$dir")
    [ "${#all[@]}" -eq 0 ] && { echo 0; return; }

    local -A keep_map=()
    local -A seen_week=()
    local i a w daily_kept=0
    # Ascendente = antigo -> novo; caminhar do fim para o começo = do novo
    # para o antigo: os primeiros `daily` grupos são os mais novos, e a semana
    # de cada arquivo é preenchida pela primeira vez que aparece caminhando
    # para trás, ou seja, o arquivo mais novo daquela semana.
    for i in $(seq "${#all[@]}" -1 1); do
        f="${all[i-1]}"
        if [ "$daily_kept" -lt "$daily" ]; then
            keep_map[$f]=1
            daily_kept=$((daily_kept + 1))
        fi
        w="$(stamp_to_iso_week "$f")"
        if [ -z "${seen_week[$w]:-}" ] && [ "${#seen_week[@]}" -lt "$weekly" ]; then
            seen_week[$w]=1
            keep_map[$f]=1
        fi
    done

    local removed=0
    for f in "${all[@]}"; do
        if [ -z "${keep_map[$f]:-}" ]; then
            rm -f -- "$f"
            removed=$((removed + 1))
        fi
    done
    echo "$removed"
}

# ============================================================
# BACKUP
# ============================================================
GPG() { gpg --batch --yes --no-tty "$@"; }

encrypt_stream() { # encrypt_stream <saida>  (lê o dump no stdin)
    GPG --symmetric --cipher-algo AES256 \
        --passphrase-file "$PASSPHRASE_FILE" \
        --output "$1"
}

gpg_decrypt() { # gpg_decrypt <entrada> <saida>
    GPG --decrypt --passphrase-file "$PASSPHRASE_FILE" \
        --output "$2" "$1" 2>/dev/null
}

verify_backup() {
    local target="$1" ctr="$2"
    # 1) Integridade da cifra: o fluxo decifrado precisa ser um gzip íntegro.
    if ! gpg_decrypt "$target" - | gzip -t; then
        fail "backup $target não passa na verificação: decifrou mas não é um gzip íntegro"
    fi
    # 2) O arquivo precisa ser um dump de verdade: `mongorestore --dryRun`
    # parseia o arquivo de ponta a ponta contra o servidor, sem escrever nada.
    local tmp vfile
    tmp="$(mktemp "${TMPDIR:-/tmp}/backup-verify-$$-XXXXXX.archive")"
    vfile="backup-verify-$$.archive"
    gpg_decrypt "$target" "$tmp"
    docker cp "$tmp" "$ctr:/tmp/$vfile" >/dev/null
    if ! docker exec "$ctr" sh -c "mongorestore --host 127.0.0.1 --authenticationDatabase admin --username root --password \"\$(cat $MONGO_PASSWORD_PATH_IN_CONTAINER)\" --archive=/tmp/$vfile --gzip --dryRun" >/dev/null 2>&1; then
        docker exec "$ctr" rm -f "/tmp/$vfile" >/dev/null 2>&1 || true
        rm -f "$tmp"
        fail "backup $target não passa na verificação: mongorestore rejeitou o archive"
    fi
    docker exec "$ctr" rm -f "/tmp/$vfile" >/dev/null 2>&1 || true
    rm -f "$tmp"
}

write_manifest() { # write_manifest <arquivo> <bytes> <sha256>
    local target="$1" bytes="$2" sha="$3"
    local stamp now epoch mf_tmp mf
    stamp="$(basename "$target")"; stamp="${stamp#sha-data-}"; stamp="${stamp%.archive.gpg}"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    epoch="$(date -u +%s)"
    mf="$BACKUPS_DIR/last-backup.json"
    mf_tmp="$(mktemp "${BACKUPS_DIR}/last-backup.json.XXXXXX")"
    printf '{"event":"backup_ok","file":"%s","utc":"%s","epoch":%s,"bytes":%s,"encrypted_sha256":"%s","rpo_h":%s,"retain_daily":%s,"retain_weekly":%s}\n' \
        "$(basename "$target")" "$now" "$epoch" "$bytes" "$sha" "$RPO_HOURS" "$RETAIN_DAILY" "$RETAIN_WEEKLY" > "$mf_tmp"
    mv "$mf_tmp" "$mf"
}

run_backup() {
    local ctr="$1"
    local stamp target ok=0 attempt
    # recuo se dois disparos caírem no mesmo segundo (mesmo nome sobrescreveria)
    for attempt in 1 2 3; do
        stamp="$(date -u +%Y%m%dT%H%M%SZ)"
        target="$BACKUPS_DIR/sha-data-${stamp}.archive.gpg"
        [ ! -e "$target" ] && break
        sleep 1
    done
    [ -e "$target" ] && fail_usage "destino já existe: $target (dois backups no mesmo segundo)"

    log_info "backup de $(basename "$target") a partir do container $ctr"
    if ! docker exec "$ctr" sh -c 'mongodump --host 127.0.0.1 --authenticationDatabase admin --username root --password "$(cat '"$MONGO_PASSWORD_PATH_IN_CONTAINER"')" --archive --gzip' \
        | encrypt_stream "$target"; then
        rm -f "$target"
        fail "mongodump/cifra terminaram com erro (por segurança $target não ficou no disco)"
    fi
    [ -s "$target" ] || { rm -f "$target"; fail "backup vazio (nada no disco, antecipado antes mesmo da verificação)"; }

    if [ "$SKIP_VERIFY" -eq 0 ]; then
        log_info "verificando o backup recém-criado (decifra -> gzip -> mongorestore --dryRun)..."
        verify_backup "$target" "$ctr"
    fi

    local bytes sha
    bytes="$(stat -c '%s' "$target")"
    sha="$(sha256sum "$target" | cut -d' ' -f1)"
    write_manifest "$target" "$bytes" "$sha"
    emit backup_ok project="$PROJECT" file="$(basename "$target")" bytes="$bytes" sha256="$sha"

    log_info "aplicando retenção (${RETAIN_DAILY} diários + ${RETAIN_WEEKLY} semanas)..."
    local removed
    removed="$(prune_backups "$BACKUPS_DIR" "$RETAIN_DAILY" "$RETAIN_WEEKLY")"
    if [ "$removed" -gt 0 ]; then
        log_warn "poda removida: ${removed} backup(s) antigo(s)"
    fi
    log_pass "backup concluído: $target"
}

# ============================================================
# CHECK (alerta de backup velho/falho)
# ============================================================
check_backup_age() {
    local mf="$BACKUPS_DIR/last-backup.json"
    local max_age="${MAX_AGE:-$RPO_HOURS}"
    local epoch max_epoch age_h
    if [ ! -f "$mf" ]; then
        echo '{"event":"backup_stale","reason":"no_manifest","max_age_h":"'"$max_age"'"}' >&2
        return 1
    fi
    epoch="$(grep -o '"epoch":[0-9]*' "$mf" 2>/dev/null | head -n1 | cut -d: -f2)"
    max_epoch=$(( $(date +%s) - max_age * 3600 ))
    if [ -z "$epoch" ] || [ "$epoch" -lt "$max_epoch" ]; then
        age_h="$(( ( $(date +%s) - epoch ) / 3600 ))"
        echo "{\"event\":\"backup_stale\",\"reason\":\"too_old\",\"age_h\":\"$age_h\",\"max_age_h\":\"$max_age\"}" >&2
        return 1
    fi
    echo "{\"event\":\"backup_fresh\",\"age_h\":\"0\",\"max_age_h\":\"$max_age\"}" >&2
    return 0
}

# ============================================================
# MAIN
# ============================================================
date -d "2026-01-05" +%G-W%V >/dev/null 2>&1 || { echo "requer date GNU (date -d)." >&2; exit 2; }

mkdir -p "$BACKUPS_DIR"

if [ "$PRUNE_ONLY" -eq 1 ]; then
    [ "$CHECK_ONLY" -eq 1 ] && { echo "--prune-only e --check são mutuamente exclusivos" >&2; exit 2; }
    removed_l="$(prune_backups "$BACKUPS_DIR" "$RETAIN_DAILY" "$RETAIN_WEEKLY")"
    emit prune_done removed="$removed_l" dir="$BACKUPS_DIR"
    log_pass "poda concluída: ${removed_l} arquivo(s) removido(s)"
    exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    if check_backup_age; then
        log_pass "último backup dentro da janela (RPO ${RPO_HOURS}h)"
        exit 0
    fi
    exit 1
fi

resolve_passphrase_file
command -v gpg >/dev/null 2>&1 || fail_usage "gpg não encontrado no host."
docker info >/dev/null 2>&1 || fail_usage "Docker não está rodando."
ctr="$(resolve_mongo_container)"
run_backup "$ctr"