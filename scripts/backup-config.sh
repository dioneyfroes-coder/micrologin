#!/usr/bin/env bash

# ====================================
# BACKUP DA CONFIGURAÇÃO EM VIGOR (Fase 2.3)
# Authentication Microservice
# ====================================
#
# O deploy guarda a imagem anterior `*─backup-*` e o registro `deployed-version`
# (`remote-deploy.sh`), mas nenhum dos dois captura a **configuração** com que a
# imagem anterior rodava: o rollback volta a imagem e usa o `.env.prod` que está
# em disco no momento — o da versão nova. É o buraco que esta fase fecha.
#
# A fonte da verdade aqui NÃO é o arquivo `.env.prod` em disco. É o container
# rodando. Provado no drill (e no test-config-backup.sh): editar o env file sem
# redeployar deixa o disco com um valor e o container com outro — e quem
# "rodava" de verdade era o container. Um backup que copiasse o arquivo
# capturaria uma config que nunca foi ao ar, ou perderia a que estava.
#
# O que este script captura de uma vez, cifrado gpg AES-256 simétrico (igual ao
# backup do Mongo, docs/BACKUP.md):
#
#   - o ambiente interpolado do container em execução (docker inspect) — o que
#     o processo viu ao subir, e o que reproduz o comportamento observado;
#   - o env file usado pelo deploy (`.env.prod`), byte a byte, para restaurar
#     preservando ordem/comentários — os valores de cada chave são sobrepostos
#     pelos do container em execução na restauração;
#   - os arquivos de compose que o compose de fato usou (label
#     `com.docker.compose.project.config_files`);
#   - o material de segredo montado no container de aplicação (destino
#     `/run/secrets/...`): chaves ES256 e credenciais das dependências.
#     Restaurar a imagem do rollback sem as chaves que ela usava seria restaurar
#     uma imagem que não assina/verifica token.
#
# O archive sai por pipe direto ao gpg (nunca existe em claro no disco de
# destino final); o staging temporário de coleta é 0700 e é removido no EXIT.
#
# O metadata externo (`<archive>.meta.json`) é deliberadamente SEM segredos: só
# tag, image ref/id, data e contagem — é o que o rollback consulta para achar o
# archive da imagem certa sem decifrar todos.
#
# Uso:
#   scripts/backup-config.sh --passphrase-file ARQ [--project NOME] [--service NOME]
#                            [--env-file ARQ] [--backups-dir DIR] [--tag T]
#                            [--skip-verify] [--retain-daily N]
#   scripts/backup-config.sh --prune-only ...
#   scripts/backup-config.sh --check [--max-age H] [--rpo-hours H]
#
# Códigos de saída:
#   0  backup criado e verificado (ou poda/check OK)
#   1  falha; emite evento estruturado no stderr
#   2  uso errado ou pré-requisito ausente

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PROJECT="micrologin"
SERVICE="auth-service"
ENV_FILE=""
BACKUPS_DIR="${ROOT_DIR}/cfg-backups"
TAG="last"
PASSPHRASE_FILE=""
RPO_HOURS=24
MAX_AGE=""
SKIP_VERIFY=0
PRUNE_ONLY=0
CHECK_ONLY=0
RETAIN_DAILY=14

usage() {
    echo "uso: $0 [--passphrase-file ARQ] [--project NOME] [--service NOME] [--env-file ARQ]" >&2
    echo "        [--backups-dir DIR] [--tag T] [--skip-verify] [--retain-daily N]" >&2
    echo "        [--rpo-hours H] [--prune-only] [--check] [--max-age H]" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --project)         PROJECT="${2:?valor exigido para --project}"; shift 2 ;;
        --service)         SERVICE="${2:?valor exigido para --service}"; shift 2 ;;
        --env-file)        ENV_FILE="${2:?valor exigido para --env-file}"; shift 2 ;;
        --backups-dir)     BACKUPS_DIR="${2:?valor exigido para --backups-dir}"; shift 2 ;;
        --tag)             TAG="${2:?valor exigido para --tag}"; shift 2 ;;
        --passphrase-file) PASSPHRASE_FILE="${2:?valor exigido para --passphrase-file}"; shift 2 ;;
        --rpo-hours)       RPO_HOURS="${2:?valor exigido para --rpo-hours}"; shift 2 ;;
        --max-age)         MAX_AGE="${2:?valor exigido para --max-age}"; shift 2 ;;
        --retain-daily)    RETAIN_DAILY="${2:?valor exigido para --retain-daily}"; shift 2 ;;
        --skip-verify)     SKIP_VERIFY=1; shift ;;
        --prune-only)      PRUNE_ONLY=1; shift ;;
        --check)           CHECK_ONLY=1; shift ;;
        -h|--help)         usage ;;
        *)                 echo "argumento desconhecido: $1" >&2; usage ;;
    esac
done

for v in "$RPO_HOURS" "$RETAIN_DAILY"; do
    case "$v" in
        ''|*[!0-9]*) echo "rpo/retain precisam ser inteiros positivos" >&2; exit 2 ;;
    esac
done
[ "$RPO_HOURS" -ge 1 ] && [ "$RETAIN_DAILY" -ge 1 ] \
    || { echo "rpo/retain precisam ser >= 1" >&2; exit 2; }

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}" >&2; emit_failed "$1"; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

TMPDIR_CFG=""
TMPDIR_VERIFY=""
cleanup() {
    [ -n "$TMPDIR_CFG" ] && rm -rf -- "$TMPDIR_CFG"
    [ -n "$TMPDIR_VERIFY" ] && rm -rf -- "$TMPDIR_VERIFY"
    :
}
trap cleanup EXIT

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
emit_failed() { emit config_backup_failed where=backup_config reason="$1" project="$PROJECT" tag="$TAG"; }

# ============================================================
# PRÉ-REQUISITOS E PASSPHRASE
# ============================================================
command -v gpg >/dev/null 2>&1 || fail_usage "gpg não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail_usage "python3 não encontrado no host (usado para o manifest)."
date -d "2026-01-05" +%Y >/dev/null 2>&1 || fail_usage "requer date GNU (date -d)."

if [ "$CHECK_ONLY" -eq 0 ] && [ "$PRUNE_ONLY" -eq 0 ]; then
    if [ -z "$PASSPHRASE_FILE" ] && [ -n "${CONFIG_BACKUP_PASSPHRASE_FILE:-}" ]; then
        PASSPHRASE_FILE="$CONFIG_BACKUP_PASSPHRASE_FILE"
        log_warn "passphrase lida de CONFIG_BACKUP_PASSPHRASE_FILE; o modo explícito é --passphrase-file"
    fi
    [ -n "$PASSPHRASE_FILE" ] || fail_usage "sem passphrase: use --passphrase-file ARQ ou CONFIG_BACKUP_PASSPHRASE_FILE"
    [ -f "$PASSPHRASE_FILE" ] || fail_usage "arquivo de passphrase não encontrado: $PASSPHRASE_FILE"
    MODE_CHECK="$(stat -c '%a' "$PASSPHRASE_FILE" 2>/dev/null || echo "???")"
    case "$MODE_CHECK" in
        ???) [ "${MODE_CHECK:1:2}" = "00" ] || log_warn "passphrase legível por grupo/outros (modo $MODE_CHECK) — considere chmod 600" ;;
        *) log_warn "não foi possível conferir o modo da passphrase" ;;
    esac
fi

GPG() { gpg --batch --yes --no-tty "$@"; }
gpg_encrypt() { # gpg_encrypt <saida> (lê o tar.gz no stdin)
    GPG --symmetric --cipher-algo AES256 --passphrase-file "$PASSPHRASE_FILE" --output "$1"
}
gpg_decrypt() { # gpg_decrypt <entrada> <saida>
    GPG --decrypt --passphrase-file "$PASSPHRASE_FILE" --output "$2" "$1" 2>/dev/null
}

# ============================================================
# CONTAINER ALVO E COLETA
# ============================================================
resolve_app_container() {
    local ctr
    ctr="$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
        --filter "label=com.docker.compose.service=${SERVICE}" \
        --format '{{.Names}}' 2>/dev/null | head -n1)"
    [ -n "$ctr" ] || fail_usage "container '${SERVICE}' do projeto '${PROJECT}' não está rodando"
    docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null | grep -q '^true$' \
        || fail "container $ctr não está em estado running"
    echo "$ctr"
}

inspect_json() { # inspect_json <ctr> <template>
    docker inspect -f "$2" "$1" 2>/dev/null || echo "{}"
}

collect_compose_files() { # collect_compose_files <stage> <workdir> <labels_json>
    local stage="$1" workdir="$2" labels_json="$3" files
    files="$(printf '%s' "$labels_json" | python3 -c '
import json, sys
labels = json.load(sys.stdin)
for key in ("com.docker.compose.project.config_files", "com.docker.compose.project.config_file"):
    value = labels.get(key)
    if value:
        print(value)
        break
' 2>/dev/null || true)"
    [ -n "$files" ] || { log_warn "sem label de config_files; compose não copiado (não crítico para env)" ; return 0; }
    mkdir -p "$stage/compose"
    local rel abs
    while IFS=',' read -ra parts; do
        for rel in "${parts[@]}"; do
            [ -n "$rel" ] || continue
            case "$rel" in
                /*) abs="$rel" ;;
                *)  abs="$workdir/$rel" ;;
            esac
            [ -f "$abs" ] || { log_warn "compose listado na label não existe em disco: $abs"; continue; }
            cp -a -- "$abs" "$stage/compose/$(basename "$abs")"
        done
    done <<< "$files"
}

collect_secret_mounts() { # collect_secret_mounts <stage> <ctr> <workdir>
    local stage="$1" ctr="$2" workdir="$3" line src rel dest uid gid mode rp
    mkdir -p "$stage/secrets"
    docker inspect -f '{{json .Mounts}}' "$ctr" 2>/dev/null \
        | python3 -c '
import json, os, sys
mounts, workdir = json.load(sys.stdin), sys.argv[1]
out = []
for m in mounts:
    if m.get("Type") != "bind":
        continue
    dest = m.get("Destination", "")
    if dest != "/run/secrets" and not dest.startswith("/run/secrets/"):
        continue
    src = m.get("Source", "")
    if not src:
        continue
    # rel = caminho do SOURCE relativamente ao diretório do compose: é o que a
    # restauração deve recriar em disco. Ex.: source ./secrets -> rel secrets;
    # source ./secrets/deps -> rel secrets/deps (o segundo resolve através do
    # primeiro bind, igual em produção).
    if os.path.normpath(src).startswith(os.path.normpath(workdir)):
        rel = os.path.relpath(src, workdir)
    else:
        rel = os.path.basename(src.rstrip("/")) or "secrets"
    out.append({"src": src, "rel": rel, "dest": dest})
out.sort(key=lambda m: len(m["dest"]))
for m in out:
    print(m["src"] + " " + m["rel"] + " " + m["dest"])
' "$workdir" > "$stage/secrets.list"
    : > "$stage/secrets.owner"
    while IFS=' ' read -r src rel dest; do
        [ -n "$src" ] || continue
        case "$src" in
            /*) : ;;
            *) log_warn "fonte de mount não absoluta, pulando: $src"; continue ;;
        esac
        # leitura pelo CONTAINER (fonte da verdade), não pelo host: em produção
        # o operador pode não ter acesso de leitura aos arquivos 600 do uid da
        # aplicação. docker cp passa pelo daemon e não depende da permissão do
        # usuário corrente.
        if docker exec -u 0 "$ctr" sh -c '[ -d "$1" ]' -- "$dest" >/dev/null 2>&1; then
            mkdir -p "$stage/secrets/$rel"
            docker cp "$ctr:$dest/." "$stage/secrets/$rel/" \
                || fail "não foi possível coletar $dest do container $ctr"
        else
            mkdir -p "$stage/secrets/$(dirname "$rel")"
            docker cp "$ctr:$dest" "$stage/secrets/$rel" \
                || fail "não foi possível coletar $dest do container $ctr"
        fi
        # dono/modo REAIS: o docker cp os descarta (extrai como o usuário
        # corrente). A verdade está no source do host, que os geradores
        # (--for-container) ajustam para o uid de quem lê dentro do container.
        # Recolhe com a mesma primitiva descartável que generate-*.sh usam.
        if docker info >/dev/null 2>&1; then
            if docker exec -u 0 "$ctr" sh -c '[ -d "$1" ]' -- "$dest" >/dev/null 2>&1; then
                docker run --rm -u 0 -v "$src:/s:ro" --entrypoint sh alpine \
                    -c 'cd /s && find . -type f -exec stat -c "%u %g %a %n" {} \;' 2>/dev/null \
                    | while read -r uid gid mode rp; do
                        echo "secrets/$rel/${rp#./} $uid $gid $mode" >> "$stage/secrets.owner"
                    done || true
            else
                docker run --rm -u 0 -v "$src:/s:ro" --entrypoint sh alpine \
                    -c 'stat -c "%u %g %a %n" /s' 2>/dev/null \
                    | while read -r uid gid mode rp; do
                        echo "secrets/$rel $uid $gid $mode" >> "$stage/secrets.owner"
                    done || true
            fi
        else
            log_warn "docker indisponível para ler o dono real do material em $src"
        fi
    done < "$stage/secrets.list"
}

collect_env_file() { # collect_env_file <stage> <env_file>
    local stage="$1" env_file="$2"
    mkdir -p "$stage/env"
    if [ -z "$env_file" ] || [ ! -f "$env_file" ]; then
        log_warn "--env-file não encontrado (${env_file:-vazio}); já fica coberto pelo ambiente em execução"
        return 0
    fi
    cp -a -- "$env_file" "$stage/env/$(basename "$env_file")"
}

# ============================================================
# MANIFEST (dentro do archive) E METADATA EXTERNO (sem segredo)
# ============================================================
build_manifest_stage() { # build_manifest_stage <stage> <utc_full>
    local stage="$1" utc_full="$2"
    local json
    json="$(python3 - "$stage" "$TAG" "$IMAGE_REF" "$IMAGE_ID" "$utc_full" <<'PY'
import hashlib, json, os, sys
stage, tag, image_ref, image_id, utc_full = sys.argv[1:]
build = json.load(open(os.path.join(stage, "build.json")))
running_env = build["running_env"]
owners = {}
owner_file = os.path.join(stage, "secrets.owner")
if os.path.isfile(owner_file):
    for line in open(owner_file, encoding="utf-8", errors="replace"):
        parts = line.split()
        if len(parts) != 4:
            continue
        rel, uid, gid, mode = parts
        owners[rel] = {"uid": int(uid), "gid": int(gid), "mode": mode}
entries = []
for root, dirs, files in os.walk(stage):
    dirs.sort(); files.sort()
    for name in files:
        p = os.path.join(root, name)
        rel = os.path.relpath(p, stage)
        if rel in ("build.json", "secrets.list", "secrets.owner", "cfg-manifest.json"):
            continue
        data = open(p, "rb").read()
        entry = {"archive": rel, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        if rel in owners:
            entry.update(owners[rel])
        entries.append(entry)
entries.sort(key=lambda e: e["archive"])
manifest = {
    "captured_at": utc_full,
    "build": "config-backup-v1",
    "tag": tag,
    "image_ref": image_ref,
    "image_id": image_id,
    "entries": entries,
    "env_keys": sorted(running_env.keys()),
    "note": "fonte da verdade = container em execução (docker inspect); restore sobrepõe os valores de running_env",
}
with open(os.path.join(stage, "cfg-manifest.json"), "w") as handle:
    json.dump(manifest, handle, indent=2, ensure_ascii=False)
print("/")
PY
)"
    [ "$json" = "/" ] || fail "falha ao gerar o manifest do archive"
}

write_meta() { # write_meta <stage> <target> <utc_full> <epoch> <bytes> <sha>
    local stage="$1" target="$2" utc_full="$3" epoch="$4" bytes="$5" sha="$6"
    python3 - "$target" "$TAG" "$IMAGE_REF" "$IMAGE_ID" "$utc_full" "$epoch" "$bytes" "$sha" "$RPO_HOURS" "$RETAIN_DAILY" <<'PY'
import json, os, sys
target, tag, image_ref, image_id, utc_full, epoch, bytes_, sha, rpo_h, retain_daily = sys.argv[1:]
meta = {
    "event": "config_backup_ok",
    "file": os.path.basename(target),
    "tag": tag,
    "image_ref": image_ref,
    "image_id": image_id,
    "utc": utc_full,
    "epoch": int(epoch),
    "bytes": int(bytes_),
    "encrypted_sha256": sha,
    "rpo_h": int(rpo_h),
    "retain_daily": int(retain_daily),
}
with open(target + ".meta.json", "w") as handle:
    json.dump(meta, handle, indent=2)
# guarda: este metadata é lido sem decifrar o archive; nenhum valor de env pode
# chegar aqui além dos campos secos acima.
assert "running_env" not in meta and not any(k.endswith("_env") for k in meta)
PY
}

# ============================================================
# RETENÇÃO E CHECK
# ============================================================
list_archives() { # list_archives <dir>
    find "$1" -maxdepth 1 -type f -name 'cfg-*.tar.gz.gpg' -printf '%f\n' 2>/dev/null | sort
}
prune_archives() {
    local dir="$1" keep="$2" removed=0 count=0 n=0 f
    while IFS= read -r f; do count=$((count + 1)); done < <(list_archives "$dir")
    [ "$count" -le "$keep" ] && { echo 0; return; }
    local to_remove=$((count - keep))
    while IFS= read -r f; do
        [ "$n" -ge "$to_remove" ] && break
        rm -f -- "$dir/$f" "$dir/$f.meta.json"
        removed=$((removed + 1)); n=$((n + 1))
    done < <(list_archives "$dir")
    echo "$removed"
}

check_backup_age() {
    local mf="$BACKUPS_DIR/last-config-backup.json"
    local max_age="${MAX_AGE:-$RPO_HOURS}"
    local epoch max_epoch age_h
    if [ ! -f "$mf" ]; then
        echo '{"event":"config_backup_stale","reason":"no_manifest","max_age_h":'"$max_age"'}' >&2
        return 1
    fi
    epoch="$(grep -o '"epoch":[0-9]*' "$mf" 2>/dev/null | head -n1 | cut -d: -f2)"
    max_epoch=$(( $(date +%s) - max_age * 3600 ))
    if [ -z "$epoch" ] || [ "$epoch" -lt "$max_epoch" ]; then
        age_h="$(( ( $(date +%s) - epoch ) / 3600 ))"
        echo "{\"event\":\"config_backup_stale\",\"reason\":\"too_old\",\"age_h\":\"$age_h\",\"max_age_h\":\"$max_age\"}" >&2
        return 1
    fi
    echo "{\"event\":\"config_backup_fresh\",\"age_h\":\"0\",\"max_age_h\":\"$max_age\"}" >&2
    return 0
}

# ============================================================
# VERIFICAÇÃO
# ============================================================
verify_capture() { # verify_capture <target>
    local target="$1"
    local plain
    TMPDIR_VERIFY="$(mktemp -d "${TMPDIR:-/tmp}/cfg-verify-$$-XXXXXX")"
    chmod 700 "$TMPDIR_VERIFY"
    plain="$TMPDIR_VERIFY/plain.tar.gz"
    if ! gpg_decrypt "$target" "$plain"; then
        fail "archive não decifra com a passphrase fornecida"
    fi
    if ! gzip -t "$plain"; then
        fail "archive decifra mas não é gzip íntegro"
    fi
    if ! python3 - "$plain" <<'PY'
import gzip, hashlib, json, sys, tarfile
try:
    with tarfile.open(sys.argv[1], "r:gz") as tar:
        names = tar.getnames()
        if "cfg-manifest.json" not in names:
            sys.exit("manifest ausente no archive")
        manifest = json.load(tar.extractfile("cfg-manifest.json"))
        entries = {e["archive"]: e for e in manifest["entries"]}
        for member in tar.getmembers():
            if not member.isfile() or member.name in ("cfg-manifest.json", "build.json", "secrets.list"):
                continue
            if member.name not in entries:
                sys.exit("arquivo sem registro no manifest: " + member.name)
            data = tar.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != entries[member.name]["sha256"]:
                sys.exit("sha256 diverge: " + member.name)
        missing = [n for n in entries if n not in names]
        if missing:
            sys.exit("manifest lista arquivo ausente no archive: " + missing[0])
except SystemExit:
    raise
except Exception:
    sys.exit("verificação do manifest falhou")
PY
    then
        fail "verificação do archive falhou"
    fi
    rm -rf -- "$TMPDIR_VERIFY"; TMPDIR_VERIFY=""
}

# ============================================================
# MAIN
# ============================================================
[ "$PRUNE_ONLY" -eq 1 ] && [ "$CHECK_ONLY" -eq 1 ] \
    && { echo "--prune-only e --check são mutuamente exclusivos" >&2; exit 2; }

mkdir -p "$BACKUPS_DIR"

if [ "$PRUNE_ONLY" -eq 1 ]; then
    removed_p="$(prune_archives "$BACKUPS_DIR" "$RETAIN_DAILY")"
    emit config_prune_done removed="$removed_p" dir="$BACKUPS_DIR"
    log_pass "poda concluída: ${removed_p} archive(s) removido(s)"
    exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    if check_backup_age; then
        log_pass "último backup de configuração dentro da janela (RPO ${RPO_HOURS}h)"
        exit 0
    fi
    exit 1
fi

docker info >/dev/null 2>&1 || fail_usage "Docker não está rodando."
ctr="$(resolve_app_container)"

TMPDIR_CFG="$(mktemp -d "${TMPDIR:-/tmp}/cfg-backup-$$-XXXXXX")"
chmod 700 "$TMPDIR_CFG"

for attempt in 1 2 3; do
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    target="$BACKUPS_DIR/cfg-${TAG}-${stamp}.tar.gz.gpg"
    [ ! -e "$target" ] && break
    sleep 1
done
[ -e "$target" ] && fail_usage "destino já existe: $target"

ENV_JSON="$(inspect_json "$ctr" '{{json .Config.Env}}')"
RUNNING_ENV_JSON="$(printf '%s' "$ENV_JSON" | python3 -c '
import json, sys
env_list = json.load(sys.stdin)
env_dict = {}
for item in env_list:
    if "=" in item:
        k, v = item.split("=", 1)
        env_dict[k] = v
print(json.dumps(env_dict))
')"
LABELS_JSON="$(inspect_json "$ctr" '{{json .Config.Labels}}')"
IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$ctr" 2>/dev/null || echo "none")"
IMAGE_ID="$(docker inspect -f '{{.Image}}' "$ctr" 2>/dev/null || echo "none")"
CREATED="$(docker inspect -f '{{.Created}}' "$ctr" 2>/dev/null || echo "none")"
UTC_FULL="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EPOCH="$(date -u +%s)"
WORKDIR="$(printf '%s' "$LABELS_JSON" | python3 -c '
import json, sys
labels = json.load(sys.stdin)
print(labels.get("com.docker.compose.project.working_dir", ""))
' 2>/dev/null || echo "$ROOT_DIR")"
[ -n "$WORKDIR" ] && [ -d "$WORKDIR" ] || WORKDIR="$ROOT_DIR"

if [ -z "$ENV_FILE" ]; then
    [ -f "$WORKDIR/.env.prod" ] && ENV_FILE="$WORKDIR/.env.prod" || true
fi

cat > "$TMPDIR_CFG/build.json" <<JSON
{
  "captured_at": "$UTC_FULL",
  "project": "$PROJECT",
  "service": "$SERVICE",
  "container": "$ctr",
  "image_ref": "$IMAGE_REF",
  "image_id": "$IMAGE_ID",
  "created": "$CREATED",
  "compose_labels": $LABELS_JSON,
  "running_env": $RUNNING_ENV_JSON
}
JSON

collect_compose_files "$TMPDIR_CFG" "$WORKDIR" "$LABELS_JSON"
collect_secret_mounts "$TMPDIR_CFG" "$ctr" "$WORKDIR"
collect_env_file "$TMPDIR_CFG" "$ENV_FILE"

SECRET_COUNT="$(wc -l < "$TMPDIR_CFG/secrets.list" 2>/dev/null | tr -d ' ' || echo 0)"
log_info "coletado do container ${ctr} (${IMAGE_REF}) — ${IMAGE_ID:0:12}; ${SECRET_COUNT} mount(s) de segredo"

build_manifest_stage "$TMPDIR_CFG" "$UTC_FULL"

log_info "cifrando para $(basename "$target")..."
tar -C "$TMPDIR_CFG" --transform='s,^\./,,' --exclude='secrets.list' --exclude='secrets.owner' -czf - . \
    | gpg_encrypt "$target" || { rm -f -- "$target"; fail "tar/gpg terminaram em erro; ${target} não ficou no disco"; }
[ -s "$target" ] || { rm -f -- "$target"; fail "archive vazio (nada no disco)"; }

if [ "$SKIP_VERIFY" -eq 0 ]; then
    log_info "verificando o archive recém-criado (decifra -> gzip -> sha256 de cada entry)..."
    verify_capture "$target"
fi

BYTES="$(stat -c '%s' "$target")"
SHA_V="$(sha256sum "$target" | cut -d' ' -f1)"
write_meta "$TMPDIR_CFG" "$target" "$UTC_FULL" "$EPOCH" "$BYTES" "$SHA_V"

cat > "$BACKUPS_DIR/last-config-backup.json" <<JSON
{"event":"config_backup_ok","file":"$(basename "$target")","utc":"$UTC_FULL","epoch":$EPOCH,"bytes":$BYTES,"encrypted_sha256":"$SHA_V","tag":"$TAG","image_ref":"$IMAGE_REF","rpo_h":$RPO_HOURS,"retain_daily":$RETAIN_DAILY}
JSON

removed_c="$(prune_archives "$BACKUPS_DIR" "$RETAIN_DAILY")"
[ "$removed_c" -gt 0 ] && log_warn "poda removida: ${removed_c} archive(s) antigo(s)"
log_pass "configuração em vigor capturada: $(basename "$target") (image ${IMAGE_REF})"
emit config_backup_ok project="$PROJECT" service="$SERVICE" tag="$TAG" file="$(basename "$target")" image_ref="$IMAGE_REF"