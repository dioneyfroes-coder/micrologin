#!/usr/bin/env bash

# ====================================
# RESTAURAÇÃO DA CONFIGURAÇÃO EM VIGOR (Fase 2.3)
# Authentication Microservice
# ====================================
#
# Par de `scripts/backup-config.sh`. O archive `cfg-<tag>-<utc>.tar.gz.gpg`
# contém o que ESTAVA RODANDO (fonte da verdade = container), não o que o
# arquivo em disco dizia. Esta restauração:
#
#   1. decifra com a mesma passphrase do backup (nunca em argv),
#   2. valida o sha256 de cada arquivo contra o manifest (nunca aplica o que
#      não é íntegro),
#   3. coloca o compose e o material de segredo no diretório alvo,
#   4. regenara o env file: pega o arquivo original capturado (ordem,
#      comentários) e sobrepõe o VALOR EM EXECUÇÃO de cada chave — depois
#      acrescenta chaves que o compose interpolava de outra origem (shell,
#      ex.: `${CFG_TEST_KID}`) e que estavam em execução.
#
# Assim, `docker compose up -d` a partir do que esta ferramenta restaurou sobe
# a MESMA configuração que rodava quando o backup foi feito — mesmo que o
# operador tivesse editado o arquivo e não tivesse redeployado (ver drill).
#
# O rollback dos deploys usa isto com `--match-image`: acha o archive cujo
# metadata registra a imagem anterior e restaura a config ANTES de subir a
# imagem antiga (scripts/deploy.sh e scripts/remote-deploy.sh).
#
# Uso:
#   scripts/restore-config.sh (--archive ARQ | --match-image REF | --match-tag TAG)
#                             --passphrase-file ARQ [--backups-dir DIR]
#                             [--target-dir DIR] [--env-file-out NOME] [--yes]
#
# Sem `--yes` faz dryrun: valida tudo e mostra o que mudaria, sem escrever.
#
# Códigos de saída:
#   0  restaurado (ou dryrun sem diferenças)
#   1  falha (não decifrou, sha não conferiu, alvo inválido)
#   2  uso errado ou pré-requisito ausente

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

BACKUPS_DIR="${ROOT_DIR}/cfg-backups"
ARCHIVE=""
MATCH_IMAGE=""
MATCH_TAG=""
PASSPHRASE_FILE=""
TARGET_DIR="$ROOT_DIR"
ENV_FILE_OUT=".env.prod"
DO_APPLY=0

usage() {
    echo "uso: $0 (--archive ARQ | --match-image REF | --match-tag TAG) --passphrase-file ARQ" >&2
    echo "        [--backups-dir DIR] [--target-dir DIR] [--env-file-out NOME] [--yes]" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --archive)        ARCHIVE="${2:?valor exigido para --archive}"; shift 2 ;;
        --match-image)    MATCH_IMAGE="${2:?valor exigido para --match-image}"; shift 2 ;;
        --match-tag)      MATCH_TAG="${2:?valor exigido para --match-tag}"; shift 2 ;;
        --backups-dir)    BACKUPS_DIR="${2:?valor exigido para --backups-dir}"; shift 2 ;;
        --passphrase-file) PASSPHRASE_FILE="${2:?valor exigido para --passphrase-file}"; shift 2 ;;
        --target-dir)     TARGET_DIR="${2:?valor exigido para --target-dir}"; shift 2 ;;
        --env-file-out)   ENV_FILE_OUT="${2:?valor exigido para --env-file-out}"; shift 2 ;;
        --yes)            DO_APPLY=1; shift ;;
        -h|--help)        usage ;;
        *)                echo "argumento desconhecido: $1" >&2; usage ;;
    esac
done

[ -n "$PASSPHRASE_FILE" ] || usage
[ -f "$PASSPHRASE_FILE" ] || { echo "passphrase não encontrado: $PASSPHRASE_FILE" >&2; exit 2; }
[ -d "$TARGET_DIR" ] || { echo "--target-dir não existe: $TARGET_DIR" >&2; exit 2; }

MODES=0
for v in "$ARCHIVE" "$MATCH_IMAGE" "$MATCH_TAG"; do [ -n "$v" ] && MODES=$((MODES + 1)); done
[ "$MODES" -eq 1 ] || usage

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0.34m'; NC='\033[0m'
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }

TMPDIR_R=""
cleanup() {
    [ -n "$TMPDIR_R" ] && rm -rf -- "$TMPDIR_R"
    :
}
trap cleanup EXIT

command -v gpg >/dev/null 2>&1 || fail "gpg não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail "python3 não encontrado no host."

GPG() { gpg --batch --yes --no-tty "$@"; }

# ------------------------------------------------------------
# 1) Achar o archive (modo explícito ou por metadata sem segredos)
# ------------------------------------------------------------
if [ -n "$MATCH_IMAGE" ] || [ -n "$MATCH_TAG" ]; then
    ARCHIVE="$(python3 - "$BACKUPS_DIR" "$MATCH_IMAGE" "$MATCH_TAG" <<'PY'
import json, os, sys
backups_dir, image, tag = sys.argv[1:]
candidates = []
for name in sorted(os.listdir(backups_dir)):
    if not name.endswith(".meta.json"):
        continue
    try:
        meta = json.load(open(os.path.join(backups_dir, name)))
    except (ValueError, OSError):
        continue
    if image and meta.get("image_ref") not in ("", "none") and meta.get("image_ref") == image:
        candidates.append(name)
    elif tag and meta.get("tag") == tag:
        candidates.append(name)
if not candidates:
    print("")
else:
    # o mais novo pelo epoch do metadata (nome também carrega ts)
    candidates.sort()
    print(os.path.join(backups_dir, candidates[-1][:-len(".meta.json")]))
PY
)"
    [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] \
        || fail "nenhum archive de configuração para ${MATCH_IMAGE:-tag=${MATCH_TAG:-?}} em ${BACKUPS_DIR}"
else
    [ -f "$ARCHIVE" ] || fail "archive não encontrado: ${ARCHIVE}"
fi
log_info "archive: $(basename "$ARCHIVE")"

# ------------------------------------------------------------
# 2) Decifra + extrai + valida shas e caminhos
# ------------------------------------------------------------
TMPDIR_R="$(mktemp -d "${TMPDIR:-/tmp}/cfg-restore-$$-XXXXXX")"
chmod 700 "$TMPDIR_R"
GPG --decrypt --passphrase-file "$PASSPHRASE_FILE" --output "$TMPDIR_R/plain.tar.gz" "$ARCHIVE" 2>/dev/null \
    || fail "archive não decifra com a passphrase fornecida"
gzip -t "$TMPDIR_R/plain.tar.gz" || fail "archive não é um gzip íntegro"
mkdir "$TMPDIR_R/x"
python3 - "$TMPDIR_R/plain.tar.gz" "$TMPDIR_R/x" <<'PY'
import hashlib, json, os, sys, tarfile
archive, outdir = sys.argv[1], sys.argv[2]
with tarfile.open(archive, "r:gz") as tar:
    if "cfg-manifest.json" not in tar.getnames():
        sys.exit("manifest ausente no archive")
    manifest = json.load(tar.extractfile("cfg-manifest.json"))
    entries = {e["archive"]: e for e in manifest["entries"]}
    for member in tar.getmembers():
        if member.isdir() or member.name in ("cfg-manifest.json", "build.json", "secrets.list"):
            continue
        if member.name not in entries:
            sys.exit("arquivo sem registro no manifest: " + member.name)
        data = tar.extractfile(member).read()
        if hashlib.sha256(data).hexdigest() != entries[member.name]["sha256"]:
            sys.exit("sha256 diverge: " + member.name)
    for name in tar.getnames():
        target = os.path.normpath(os.path.join(outdir, name))
        if not target.startswith(os.path.normpath(outdir)):
            sys.exit("caminho fora do diretório de extração: " + name)
    tar.extractall(outdir)
PY
MANIFEST="$TMPDIR_R/x/cfg-manifest.json"
BUILD_JSON="$TMPDIR_R/x/build.json"

log_info "capturado de: $(python3 -c '
import json,sys
b=json.load(open(sys.argv[1]))
print(b.get("image_ref","?") + "  VERSION=" + b["running_env"].get("VERSION","(sem VERSION)"))
' "$BUILD_JSON")"

ENV_ORIGINAL="$(find "$TMPDIR_R/x/env" -maxdepth 1 -type f -print -quit 2>/dev/null || true)"

# ------------------------------------------------------------
# 3) Regenara o env file (fonte da verdade = running_env)
# ------------------------------------------------------------
python3 - "$TMPDIR_R/x" "$ENV_ORIGINAL" > "$TMPDIR_R/env.new" <<'PY'
import json, os, re, sys
xdir, env_original = sys.argv[1], sys.argv[2] or ""
manifest = json.load(open(os.path.join(xdir, "cfg-manifest.json")))
build = json.load(open(os.path.join(xdir, "build.json")))
meta = build.get("manifest_meta", {})
running_env = build.get("running_env", {})
compose_text = ""
for e in manifest["entries"]:
    if e["archive"].startswith("compose/"):
        p = os.path.join(xdir, e["archive"])
        if os.path.isfile(p):
            compose_text += open(p, encoding="utf-8", errors="replace").read()

result = []
if env_original and os.path.isfile(env_original):
    # preserva ordem/comentários; sobrepõe o valor que ESTAVA RODANDO
    for line in open(env_original, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m and m.group(1) in running_env and line.strip() and not line.lstrip().startswith("#"):
            result.append(m.group(1) + "=" + running_env[m.group(1)])
        else:
            result.append(line)
else:
    # sem original capturado: gera a partir do ambiente em execução
    for k in sorted(running_env):
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", k) and k not in (
            "PATH", "HOSTNAME", "HOME", "PWD", "TERM", "SHLVL", "OLDPWD",
            "NODE_VERSION", "YARN_VERSION", "TZ",
        ):
            result.append(k + "=" + running_env[k])

# chaves que o compose interpolava (${X} / ${X:-...}) e vinha de outra origem
# (shell), mas que estavam em execução: garantem o mesmo valor ao subir
#
# `declared` é lido com re.M sobre as linhas de `result`: sem isso, um join sem
# separador colaria as linhas e o regex ancorado em `^` só encontraria a
# PRIMEIRA chave — o que fazia cada chave interpolada ser anexada de novo,
# produzindo um env file com a mesma chave duas vezes. Um env file com chave
# duplicada é um arquivo malformado cujo valor depende da ordem de leitura, e o
# rollback é justamente o caminho em que ninguém pode affordar isso.
def env_keys_of(text):
    return set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-]?[^}]*)?\}", text) or [])

# A referência da IMAGEM que rodava vem do `image_ref` do manifest, não do env
# file do host. O env do disco já foi sobrescrito pela versão nova antes do
# backup (o backup acontece no meio do deploy), então regenerar a partir dele
# devolveria a tag da imagem QUEBROCA — o rollback subiria a versão que ele
# acabou de desfazer, e ainda reportaria sucesso.
image_ref = meta.get("image_ref", "")
if image_ref and image_ref not in ("", "none"):
    for idx, line in enumerate(result):
        if line.startswith("CFG_TEST_IMAGE="):
            result[idx] = "CFG_TEST_IMAGE=" + image_ref
            break
    else:
        result.append("CFG_TEST_IMAGE=" + image_ref)

declared = set(re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)(?==)", "\n".join(result), re.M))
interpolated = env_keys_of(compose_text)
for k in sorted(interpolated):
    if k in running_env and k not in declared:
        result.append(k + "=" + running_env[k])

sys.stdout.write("\n".join(result) + ("\n" if result else ""))
PY
ENV_NEW="$TMPDIR_R/env.new"

# ------------------------------------------------------------
# 4) Plano: o que mudaria no alvo
# ------------------------------------------------------------
CHANGED=0
NEW_FILES=0
declare_plan() { # declare_plan <rotulo> <rel> <sha>
    local label="$1" rel="$2" sha="$3" abs cur
    abs="$TARGET_DIR/$rel"
    if [ ! -e "$abs" ]; then
        echo "  [novo]     ${label} ${rel}"
        NEW_FILES=$((NEW_FILES + 1)); CHANGED=$((CHANGED + 1))
        return
    fi
    cur="$(sha256sum "$abs" 2>/dev/null | cut -d' ' -f1 || echo "?")"
    if [ "$cur" != "$sha" ]; then
        echo "  [alterado] ${label} ${rel} (${cur:0:12} -> ${sha:0:12})"
        CHANGED=$((CHANGED + 1))
    fi
}

echo -e "${BLUE}─ Plano de restauração (alvo: ${TARGET_DIR}) ─${NC}"
while IFS='|' read -r rel sha; do
    [ -n "$rel" ] || continue
    declare_plan "compose" "$(basename "$rel")" "$sha"
done < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for e in m["entries"]:
    if e["archive"].startswith("compose/"):
        print(e["archive"] + "|" + e["sha256"])
PY
)

while IFS='|' read -r rel sha; do
    [ -n "$rel" ] || continue
    declare_plan "segredo" "$rel" "$sha"
done < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for e in m["entries"]:
    a = e["archive"]
    if a.startswith("secrets/"):
        print(a[len("secrets/"):] + "|" + e["sha256"])
PY
)

if [ -s "$ENV_NEW" ]; then
    if [ -f "$TARGET_DIR/$ENV_FILE_OUT" ]; then
        if ! diff -q "$ENV_NEW" "$TARGET_DIR/$ENV_FILE_OUT" >/dev/null 2>&1; then
            echo "  [alterado] env ${ENV_FILE_OUT} (regerado com valores em execução)"
            CHANGED=$((CHANGED + 1))
        fi
    else
        echo "  [novo]     env ${ENV_FILE_OUT}"
        CHANGED=$((CHANGED + 1))
    fi
fi
echo ""

if [ "$CHANGED" -eq 0 ]; then
    log_pass "dryrun: nada a restaurar — o alvo já está idêntico ao backup"
    exit 0
fi

if [ "$DO_APPLY" -eq 0 ]; then
    log_warn "dryrun: ${CHANGED} diferença(s) acima (${NEW_FILES} nova(s)). Rode com --yes para aplicar."
    exit 0
fi

log_info "aplicando restauração em ${TARGET_DIR}..."
python3 - "$TMPDIR_R/x" "$TARGET_DIR" "$ENV_FILE_OUT" "$ENV_NEW" > "$TMPDIR_R/apply.out" <<'PY'
import json, os, shutil, sys
xdir, target_dir, env_out, env_new = sys.argv[1:]
manifest = json.load(open(os.path.join(xdir, "cfg-manifest.json")))
for e in manifest["entries"]:
    a = e["archive"]
    src = os.path.join(xdir, a)
    if a.startswith("compose/"):
        rel = os.path.basename(a)
    elif a.startswith("secrets/"):
        rel = a[len("secrets/"):]
    else:
        continue
    dest = os.path.normpath(os.path.join(target_dir, rel))
    if not dest.startswith(os.path.normpath(target_dir)):
        sys.exit("caminho fora do alvo: " + a)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # Substituição atômica, e não copy2 direto no destino: o arquivo no disco
    # é do dono e modo que o CONTAINER usa (uid 1001/999, modo 444), então quem
    # restaura não consegue abri-lo para escrita — nem o pode chmodar, por não
    # ser o dono. copy2 rebentaria com PermissionError. `rename` só exige
    # escrita no DIRETÓRIO, que é do operador, e ainda deixa o destino
    # inteiro: se a cópia falhar no meio, a versão anterior continua no lugar.
    # O dono/modo abaixo voltam logo em seguida.
    tmp = dest + ".restore-tmp"
    if os.path.isdir(src):
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp)
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        os.replace(tmp, dest)
    else:
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copy2(src, tmp)
        os.replace(tmp, dest)
    # o dono/modo REAIS do material voltam com ele (o copiar acima os perde
    # quando o operador não é root). O manifest guarda uid/gid/mode capturados
    # do source (fase 2.3); reaplicar é obrigatório para o container reler.
    if a.startswith("secrets/") and e.get("uid") is not None:
        print("OWNER|%s|%s|%s|%s" % (rel, e["uid"], e["gid"], e.get("mode", "0")))
dest_env = os.path.join(target_dir, env_out)
# mesmo motivo dos segredos: o env file em produção pode ser de outro dono
# (root, ou o usuário do deploy em outro host) e abrir para escrita falharia.
env_tmp = dest_env + ".restore-tmp"
shutil.copy2(env_new, env_tmp)
os.replace(env_tmp, dest_env)
print("env regerado: " + dest_env)
PY

OWNER_JOBS="$TMPDIR_R/owner.jobs"
grep -E '^OWNER\|' "$TMPDIR_R/apply.out" | while IFS='|' read -r tag rel uid gid mode; do
    [ -n "$rel" ] || continue
    case "$uid$gid$mode" in *[!0-9]*|"") fail "dono inválido no manifest (${rel}: ${uid}:${gid}:${mode})" ;; esac
    printf 'chown %s:%s %q && chmod %s %q\n' "$uid" "$gid" "$rel" "$mode" "$rel"
done > "$OWNER_JOBS"

if [ -s "$OWNER_JOBS" ]; then
    if docker info >/dev/null 2>&1; then
        log_info "reaplicando dono/modo dos segredos restaurados (igual generate-* --for-container)..."
        # mesmo container descartável que os geradores usam: o daemon é root e
        # ajusta o dono que os containers (uid 1001 do app, 999 das deps) leem
        docker run --rm -i -u 0 -v "$TARGET_DIR:/t:rw" --entrypoint sh alpine \
            -c 'cd /t && sh -e' < "$OWNER_JOBS" \
            || fail "aplicar o dono dos segredos falhou; reexecute como root ou com docker"
        log_pass "dono/modo dos segredos restaurados"
    else
        fail "restauração precisa reaplicar o dono dos segredos (uid/gid registrados) e docker não está disponível"
    fi
fi
grep -v '^OWNER|' "$TMPDIR_R/apply.out" >&2

echo ""
log_pass "restauração aplicada. Para subir a mesma configuração:"
echo "  docker compose --env-file ${TARGET_DIR}/${ENV_FILE_OUT} -f <compose restaurado> up -d --force-recreate"
exit 0