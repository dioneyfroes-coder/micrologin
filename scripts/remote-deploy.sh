#!/usr/bin/env bash

# ====================================
# DEPLOY REMOTO - Authentication Microservice
# ====================================
#
# Roda NO SERVIDOR (não no CI). O CI resolve a imagem, copia este script e
# chama por SSH; aqui a versão já é imutável (tag por SHA ou digest) e o
# trabalho é: subir a versão certa, provar que ela serve tráfego e voltar
# atrás se não provar.
#
# Uso:
#   scripts/remote-deploy.sh --image ghcr.io/dioneyfroes-coder/micrologin@sha256:abc... \
#                           --env-file /opt/micrologin/.env.prod \
#                           --compose-file /opt/micrologin/docker-compose.prod.yml \
#                           --base-url https://api.exemplo.com \
#                           [--skip-smoke] [--keep-images 5]
#
# Saída: 0 somente se a versão nova passou no smoke test. Qualquer falha no
# caminho novo dispara rollback e devolve 1.

set -euo pipefail

# ====================================
# FUNÇÕES AUXILIARES
# ====================================
log_info()    { echo -e "\033[0;34mℹ️  $1\033[0m"; }
log_success() { echo -e "\033[0;32m✅ $1\033[0m"; }
log_warning() { echo -e "\033[1;33m⚠️  $1\033[0m"; }
log_error()   { echo -e "\033[0;31m❌ $1\033[0m" >&2; }

die() {
    log_error "$1"
    exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ====================================
# ARGUMENTOS
# ====================================
IMAGE=""
ENV_FILE=""
COMPOSE_FILE=""
BASE_URL=""
SKIP_SMOKE="false"
KEEP_IMAGES=5
STATE_DIR="${DEPLOY_STATE_DIR:-/var/lib/micrologin}"
LOCK_FILE="${STATE_DIR}/deploy.lock"
VERSION_FILE="${STATE_DIR}/deployed-version"
BACKUP_DIR="${STATE_DIR}/backups"
CONFIG_BACKUP_DIR="${STATE_DIR}/config-backups"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-micrologin}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-auth-service}"
READY_TIMEOUT="${DEPLOY_READY_TIMEOUT:-120}"
READY_INTERVAL="${DEPLOY_READY_INTERVAL:-3}"

while [ $# -gt 0 ]; do
    case "$1" in
        --image)        IMAGE="${2:-}"; shift 2 ;;
        --env-file)     ENV_FILE="${2:-}"; shift 2 ;;
        --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
        --base-url)     BASE_URL="${2:-}"; shift 2 ;;
        --keep-images)  KEEP_IMAGES="${2:-}"; shift 2 ;;
        --ready-timeout) READY_TIMEOUT="${2:-}"; shift 2 ;;
        --project)      COMPOSE_PROJECT="${2:-}"; shift 2 ;;
        --service)      COMPOSE_SERVICE="${2:-}"; shift 2 ;;
        --skip-smoke)   SKIP_SMOKE="true"; shift ;;
        -h|--help)      sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "Argumento desconhecido: $1" ;;
    esac
done

[ -n "$IMAGE" ] || die "--image é obrigatório (imagem imutável: tag por SHA ou digest)."
[ -n "$ENV_FILE" ] || die "--env-file é obrigatório."
[ -n "$COMPOSE_FILE" ] || die "--compose-file é obrigatório."
[ -f "$ENV_FILE" ] || die "Env file não encontrado: ${ENV_FILE}"
[ -f "$COMPOSE_FILE" ] || die "Compose file não encontrado: ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || die "Docker não encontrado no host."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não encontrado no host."
command -v flock >/dev/null 2>&1 || die "flock não encontrado (necessário para serializar deploys)."

# Separa a referência em repositório e versão. Uma tag não pode conter "/",
# então o sufixo depois do último ":" só é tag se não tiver barra - sem isso,
# `127.0.0.1:5001/micrologin@sha256:...` virava repositório `127.0.0.1`.
strip_tag() {
    local ref="$1" tail="${1##*:}"
    if [ "$tail" != "$ref" ] && [ "${tail#*/}" = "$tail" ]; then
        printf '%s' "${ref%:*}"
    else
        printf '%s' "$ref"
    fi
}

IMAGE_REPO="${IMAGE%@*}"
[ "$IMAGE_REPO" = "$IMAGE" ] && IMAGE_REPO="$(strip_tag "$IMAGE")"
IMAGE_NAME="${IMAGE_REPO##*/}"
[ -n "$IMAGE_NAME" ] || die "Não foi possível extrair o nome da imagem de ${IMAGE}."

# A imagem chega imutável: digest (`repo@sha256:...`) ou tag por SHA. O digest
# é o que entra no registro de versão implantada; a referência completa vai
# para o compose via IMAGE_REF, para não remontar `repo:sha256:...` por engano.
case "$IMAGE" in
    *@*) IMAGE_DIGEST="${IMAGE#*@}" ;;
    *)   IMAGE_DIGEST="$IMAGE" ;;
esac

# `none` em vez de string vazia: o registro de versão é um arquivo JSON
# consultado por gente e por script, e campo vazio vira ambiguidade.
digest_of() {
    if [ -z "$1" ]; then
        printf 'none'
    else
        printf '%s' "${1##*@}"
    fi
}

export REGISTRY="${REGISTRY:-${IMAGE_REPO%/*}}"
export IMAGE_NAME
export IMAGE_REF="$IMAGE"
export VERSION="$IMAGE_DIGEST"

compose() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Espera /readiness responder 200. Readiness, e não /health: /health pode
# responder 503 só porque a memória passou do limiar, e dar rollback por causa
# disso seria derrubar o serviço por um alarme que não é de tráfego.
wait_for_readiness() {
    local url="${1}/readiness"
    local deadline=$(( $(date +%s) + READY_TIMEOUT ))
    local attempt=1

    log_info "Aguardando readiness em ${url} (timeout ${READY_TIMEOUT}s)..."

    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -fsS -o /dev/null "$url" 2>/dev/null; then
            log_success "readiness OK (tentativa ${attempt})"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep "$READY_INTERVAL"
    done

    log_error "readiness não respondeu 200 em ${READY_TIMEOUT}s."
    compose ps || true
    compose logs --tail 80 || true
    return 1
}

# Registra a versão em vigor. É o que permite responder "o que está rodando?"
# sem inferir pelo estado do Docker.
record_version() {
    local digest="$1" status="$2" previous="${3:-none}"
    local image_ref="none"
    [ "$digest" != "none" ] && image_ref="${IMAGE_REPO}@${digest}"
    mkdir -p "$STATE_DIR"
    cat > "$VERSION_FILE" <<JSON
{
  "image": "${image_ref}",
  "status": "${status}",
  "previousImage": "${previous}",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployedBy": "${DEPLOYED_BY:-unknown}",
  "commit": "${DEPLOY_COMMIT:-unknown}",
  "host": "$(hostname)"
}
JSON
    log_success "Versão registrada em ${VERSION_FILE} (${status})"
}

# Lê a versão em vigor. "none" e vazio significam a mesma coisa: não há
# versão anterior conhecida. Sem essa distinção, um registro de falha de pull
# viraria uma referência inválida e o próximo deploy tentaria voltar para
# "repo@none".
current_deployed_image() {
    [ -f "$VERSION_FILE" ] || return 0
    python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as handle:
        image = json.load(handle).get("image", "") or ""
except Exception:
    image = ""
print("" if image in ("", "none") or image.endswith("@none") else image)
' "$VERSION_FILE" 2>/dev/null || true
}

backup_current_image() {
    local current
    current="$(current_deployed_image)"
    if [ -z "$current" ]; then
        log_warning "Nenhuma versão registrada; este é provavelmente o primeiro deploy."
        return 0
    fi

    local backup_tag="${IMAGE_NAME}-backup-$(date -u +%Y%m%d%H%M%S)"
    mkdir -p "$BACKUP_DIR"

    # A imagem anterior precisa existir localmente para o rollback ser rápido e
    # não depender de rede. Se não estiver, tenta o pull.
    if ! docker image inspect "$current" >/dev/null 2>&1; then
        log_warning "Imagem anterior não está local; tentando pull de ${current}"
        docker pull "$current" >/dev/null 2>&1 \
            || { log_warning "Pull da versão anterior falhou; o rollback pode não funcionar."; return 0; }
    fi

    docker tag "$current" "${IMAGE_REPO}:${backup_tag}"
    echo "$current" > "${BACKUP_DIR}/previous-image"
    log_success "Backup da versão anterior: ${IMAGE_REPO}:${backup_tag} (era ${current})"

    # Fase 2.3: a imagem anterior perde valor sem a CONFIGURAÇÃO que ela
    # rodava. Captura a config em execução (fonte da verdade = container) com a
    # tag = digest da imagem anterior; o rollback restaura por --match-tag.
    local current_digest
    current_digest="$(digest_of "$current")"
    if [ -n "$current_digest" ] && [ "$current_digest" != "none" ]; then
        if bash "${SCRIPT_DIR}/backup-config.sh" \
            --project "$COMPOSE_PROJECT" --service "$COMPOSE_SERVICE" \
            --env-file "$ENV_FILE" --backups-dir "$CONFIG_BACKUP_DIR" \
            --tag "deployed-${current_digest}" \
            --passphrase-file "$CONFIG_BACKUP_PASSPHRASE_FILE" \
            >/dev/null 2>&1; then
            echo "deployed-${current_digest}" > "${BACKUP_DIR}/previous-config-backup"
            log_success "Configuração em execução capturada (tag deployed-${current_digest})"
        else
            log_warning "Backup da configuração falhou; o rollback não terá a config antiga."
        fi
    fi
}

rollback() {
    local reason="$1"
    log_error "Deploy falhou (${reason}); iniciando rollback."

    local previous
    previous="$(current_deployed_image)"
    if [ -z "$previous" ]; then
        log_error "Sem versão anterior registrada; não há para onde voltar."
        record_version "$(digest_of "$previous")" "failed-no-rollback" || true
        exit 1
    fi

    if ! docker image inspect "$previous" >/dev/null 2>&1; then
        log_warning "Versão anterior ausente localmente; tentando pull de ${previous}"
        if ! docker pull "$previous" >/dev/null 2>&1; then
            log_error "Não foi possível obter a versão anterior. Deploy anteriorizado manualmente."
            record_version "$previous" "rollback-unavailable" || true
            exit 1
        fi
    fi

    PREVIOUS_DIGEST="$(digest_of "$previous")"
    log_info "Voltando para ${previous}"

    # Fase 2.3: o rollback NÃO pode subir a imagem anterior com o env file da
    # versão nova. Restaura a config que a imagem anterior rodava (--match-tag
    # usa metadata SEM segredo) e só então sobe o compose.
    if [ -n "$PREVIOUS_DIGEST" ] && [ "$PREVIOUS_DIGEST" != "none" ]; then
        log_info "Restaurando a configuração da versão anterior (deployed-${PREVIOUS_DIGEST})..."
        if ! bash "${SCRIPT_DIR}/restore-config.sh" \
            --match-tag "deployed-${PREVIOUS_DIGEST}" \
            --passphrase-file "$CONFIG_BACKUP_PASSPHRASE_FILE" \
            --backups-dir "$CONFIG_BACKUP_DIR" \
            --target-dir "$(dirname "$ENV_FILE")" \
            --env-file-out "$(basename "$ENV_FILE")" \
            --yes >/dev/null 2>&1; then
            log_error "Restauração da configuração falhou; abortando para não subir imagem antiga com config nova."
            record_version "$PREVIOUS_DIGEST" "rollback-config-failed" "$IMAGE_DIGEST" || true
            exit 1
        fi
        log_success "Configuração anterior restaurada"
    fi
    # IMAGE_REF, e não só VERSION: o compose usa IMAGE_REF quando definido, e
    # manter a referência antiga aqui significaria "rollback" que sobe a mesma
    # imagem quebrada e ainda reporta sucesso.
    export IMAGE_REF="$previous"
    export VERSION="${PREVIOUS_DIGEST}"

    if compose up -d; then
        if wait_for_readiness "$BASE_URL"; then
            # Readiness não basta: a release quebrada que causou o rollback
            # estava com readiness OK. Sem repetir o smoke aqui, "rollback
            # concluído" seria só uma intenção.
            if [ "$SKIP_SMOKE" = "true" ] || [ -z "$BASE_URL" ]; then
                record_version "$PREVIOUS_DIGEST" "rolled-back-unverified" "$IMAGE_DIGEST"
                log_success "Rollback concluído: serviço de volta em ${previous}."
            elif run_smoke_test; then
                record_version "$PREVIOUS_DIGEST" "rolled-back" "$IMAGE_DIGEST"
                log_success "Rollback concluído e verificado: serviço de volta em ${previous}."
            else
                ROLLBACK_SMOKE=$?
                if [ "$ROLLBACK_SMOKE" = "2" ]; then
                    log_error "Rollback subiu a versão anterior, mas o smoke test ficou inconclusivo (rate limit)."
                    record_version "$PREVIOUS_DIGEST" "rolled-back-unverified" "$IMAGE_DIGEST"
                else
                    log_error "O rollback subiu a versão anterior, mas ela também falha no smoke test."
                    log_error "O serviço anterior não serve tráfego: é preciso intervenção manual."
                    record_version "$PREVIOUS_DIGEST" "rolled-back-but-broken" "$IMAGE_DIGEST"
                fi
            fi
            exit 1
        fi
        log_error "Rollback executou, mas o serviço não ficou pronto."
    else
        log_error "Rollback falhou ao subir o container."
    fi

    record_version "$PREVIOUS_DIGEST" "rollback-failed" "$IMAGE_DIGEST"
    exit 1
}

prune_images() {
    log_info "Removendo imagens antigas (mantendo ${KEEP_IMAGES} Tags de ${IMAGE_REPO})..."
    local tags
    tags=$(docker images "$IMAGE_REPO" --format '{{.CreatedAt}} {{.Tag}}' \
        | grep -v -e '<none>' -e 'backup-' \
        | sort -r \
        | tail -n +$((KEEP_IMAGES + 1)) \
        | cut -d' ' -f2- || true)

    if [ -z "$tags" ]; then
        return 0
    fi

    echo "$tags" | while read -r tag; do
        [ -n "$tag" ] || continue
        # Nunca remove a imagem em uso nem tags de backup (são o caminho de volta).
        docker rmi "${IMAGE_REPO}:${tag}" >/dev/null 2>&1 || true
    done
    log_success "Limpeza concluída."
}

# Codes: 0 passou, 1 a versão não autentica, 2 inconclusivo (rate limit).
run_smoke_test() {
    local outcome=0
    log_info "Executando smoke test funcional contra ${BASE_URL}..."
    "${SCRIPT_DIR}/smoke-test.sh" "$BASE_URL" || outcome=$?

    case "$outcome" in
        0) log_success "Smoke test passou."; return 0 ;;
        2) return 2 ;;
        *) log_error "Smoke test falhou: a versão implantada não autentica."; return 1 ;;
    esac
}

# ====================================
# MAIN
# ====================================
mkdir -p "$STATE_DIR" "$BACKUP_DIR" "$CONFIG_BACKUP_DIR"

# Fase 2.3: o deploy guarda a configuração em execução de cada versão; sem a
# passphrase o rollback voltaria só a imagem — o buraco que a fase fecha.
if [ -z "${CONFIG_BACKUP_PASSPHRASE_FILE:-}" ] || [ ! -r "${CONFIG_BACKUP_PASSPHRASE_FILE}" ]; then
    die "CONFIG_BACKUP_PASSPHRASE_FILE é obrigatória (arquivo legível) para o deploy: sem ela a configuração em execução não é capturada."
fi

# Dois deploys simultâneos no mesmo host se atropelam: o segundo `up -d` roda
# com a imagem do primeiro no meio do readiness. flock serializa.
log_info "Adquirindo lock de deploy (${LOCK_FILE})..."
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    die "Outro deploy está em andamento neste host."
fi

log_info "Deploy de ${IMAGE}"
log_info "  env:    ${ENV_FILE}"
log_info "  compose:${COMPOSE_FILE}"
log_info "  url:    ${BASE_URL:-<não informado: smoke local indisponível>}"

PREVIOUS_IMAGE="$(current_deployed_image)"
[ -n "$PREVIOUS_IMAGE" ] && log_info "Versão em vigor: ${PREVIOUS_IMAGE}"

backup_current_image

# ====================================
# SUBIR A VERSÃO NOVA
# ====================================
log_info "Baixando a imagem por digest: ${IMAGE}"
if ! docker pull "$IMAGE"; then
    log_error "Falha no pull de ${IMAGE}"
    # Nada mudou no host ainda: a versão em vigor continua no ar. Rollback aqui
    # só gastaria tempo; o registro fica marcado como falha de download.
    record_version "$(digest_of "$PREVIOUS_IMAGE")" "failed-pull" "$IMAGE_DIGEST" || true
    exit 1
fi

log_info "Subindo a versão nova com docker compose up -d"
if ! compose up -d; then
    log_error "docker compose up -d falhou"
    rollback "compose-up-failed"
fi

if ! wait_for_readiness "$BASE_URL"; then
    rollback "readiness-failed"
fi

if [ "$SKIP_SMOKE" = "true" ]; then
    log_warning "Smoke test pulado por --skip-smoke; o registro vai marcar isso."
    record_version "$IMAGE_DIGEST" "deployed-without-smoke" "$(digest_of "$PREVIOUS_IMAGE")"
    exit 0
fi

if [ -z "$BASE_URL" ]; then
    log_error "--base-url é obrigatório para validar o deploy com smoke test."
    rollback "missing-base-url"
fi

set +e
run_smoke_test
SMOKE_OUTCOME=$?
set -e

case "$SMOKE_OUTCOME" in
    0)
        ;;
    2)
        # Inconclusivo: o serviço respondeu 429, ou seja, está no ar e aplicando
        # a política de rate limit. Reverter aqui trocaria uma versão possivelmente
        # boa por causa de limite de capacidade, então a versão fica, mas o
        # pipeline fica vermelho para um humano decidir.
        log_error "Smoke test inconclusivo (rate limit). A versão ${IMAGE_DIGEST} permanece no ar."
        log_error "Pipeline em vermelho por decisão de projeto: limite de login bloqueou a verificação."
        record_version "$IMAGE_DIGEST" "deployed-inconclusive" "$(digest_of "$PREVIOUS_IMAGE")"
        exit 1
        ;;
    *)
        rollback "smoke-test-failed"
        ;;
esac

record_version "$IMAGE_DIGEST" "deployed" "$(digest_of "$PREVIOUS_IMAGE")"
prune_images

# Fase 2.3: o sucesso vira o alvo do próximo rollback. Guarda a config da
# versão que acabou de subir sob a tag do digest (a próxima volta precisa dela).
if bash "${SCRIPT_DIR}/backup-config.sh" \
    --project "$COMPOSE_PROJECT" --service "$COMPOSE_SERVICE" \
    --env-file "$ENV_FILE" --backups-dir "$CONFIG_BACKUP_DIR" \
    --tag "deployed-${IMAGE_DIGEST}" \
    --passphrase-file "$CONFIG_BACKUP_PASSPHRASE_FILE" \
    >/dev/null 2>&1; then
    echo "deployed-${IMAGE_DIGEST}" > "${BACKUP_DIR}/previous-config-backup"
    log_success "Configuração da versão nova capturada (tag deployed-${IMAGE_DIGEST})"
else
    log_warning "Backup da configuração nova falhou; o próximo rollback usará a anterior."
fi

log_success "🎉 Deploy concluído e validado: ${IMAGE_REPO}@${IMAGE_DIGEST}"
