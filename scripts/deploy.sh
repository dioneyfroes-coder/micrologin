#!/bin/bash

# ====================================
# SCRIPT DE DEPLOY AUTOMATIZADO
# Authentication Microservice
#
# Uso:
#   scripts/deploy.sh staging      # usa o compose dev (.env) + ports do .env
#   scripts/deploy.sh production   # usa docker-compose.prod.yml + .env.prod
#
# Variáveis são lidas de .env/.env.prod (fonte da verdade):
#   REGISTRY, IMAGE_NAME, VERSION, APP_PORT, PROD_BASE_URL
# ====================================

set -euo pipefail

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ENVIRONMENT=${1:-staging}
VERSION=${2:-latest}
SERVICE_NAME="auth-service"

echo -e "${BLUE}🚀 Starting deployment of ${SERVICE_NAME} to ${ENVIRONMENT}${NC}"

# ====================================
# FUNÇÕES AUXILIARES
# ====================================

log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Carrega apenas variáveis da fonte da verdade (.env / .env.prod)
load_env() {
    local file="$1"
    [ -f "$file" ] || return 0
    while IFS='=' read -r key val; do
        [ -n "$key" ] && export "$key=$val"
    done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$file" 2>/dev/null || true)
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    command -v docker >/dev/null 2>&1 || { log_error "Docker not found."; exit 1; }
    docker compose version >/dev/null 2>&1 || { log_error "Docker Compose v2 not found."; exit 1; }

    case "$ENVIRONMENT" in
        staging)
            ENV_FILE=".env"
            [ -f "$ENV_FILE" ] || log_warning ".env não existe; copie de .env.example"
            load_env "$ENV_FILE"
            ;;
        production)
            ENV_FILE=".env.prod"
            [ -f "$ENV_FILE" ] || { log_error "$ENV_FILE não encontrado."; exit 1; }
            load_env "$ENV_FILE"
            ;;
        *) log_error "Unknown environment: $ENVIRONMENT"; exit 1 ;;
    esac

    REGISTRY=${REGISTRY:-auth-service}
    IMAGE_NAME=${IMAGE_NAME:-auth-service}
    VERSION=${VERSION:-latest}
    export REGISTRY IMAGE_NAME VERSION

    if [ "$ENVIRONMENT" = "production" ] && can_push; then
        log_warning "Garanta que o host está logado no registry: docker login ${REGISTRY%%/*}"
    fi

    APP_PORT=${APP_PORT:-3000}
    PROD_BASE_URL=${PROD_BASE_URL:-https://api.yourapp.com}

    log_success "Prerequisites check passed"
}

run_tests() {
    log_info "Running tests before deployment..."
    npm run test:unit:fast || return 1
    npm run test:integration:app || return 1
    log_success "All tests passed"
}

# Só faz push de fato se houver um registry remoto (contém `.` ou `:`).
# Sem registry, a imagem fica apenas local (deploy local/staging sem push).
can_push() {
    case "$REGISTRY" in
        *.*|*:*) return 0 ;;
        *) return 1 ;;
    esac
}

build_and_push() {
    log_info "Building Docker image..."
    local ts sha commit_tag
    ts=$(date +%Y%m%d%H%M%S)
    sha=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "no-git")
    commit_tag="${sha}-${ts}"

    # Tag imutável (SHA do commit + data) para rastreabilidade/rollback.
    # O compose passa a subir essa tag (e não `latest`).
    export VERSION="${commit_tag}"

    docker build -t "${REGISTRY}/${IMAGE_NAME}:${commit_tag}" . || return 1

    # Tag mutável (latest) apontando para o mesmo build (usada por backup/rollback)
    docker tag "${REGISTRY}/${IMAGE_NAME}:${commit_tag}" "${REGISTRY}/${IMAGE_NAME}:latest" || return 1

    if can_push; then
        log_info "Pushing image to ${REGISTRY}..."
        docker push "${REGISTRY}/${IMAGE_NAME}:${commit_tag}" || return 1
        docker push "${REGISTRY}/${IMAGE_NAME}:latest" || return 1
    else
        log_warning "REGISTRY=${REGISTRY} não é um registry remoto; pulando push (imagem apenas local)."
    fi

    log_success "Image built: ${REGISTRY}/${IMAGE_NAME}:${commit_tag} (latest)"
}

wait_for_health_check() {
    local url="$1"
    local max_attempts=30 attempt=1
    log_info "Waiting for health check: ${url}"
    while [ "$attempt" -le "$max_attempts" ]; do
        if curl -f -s "$url" > /dev/null 2>&1; then
            log_success "Health check passed"
            return 0
        fi
        log_info "Attempt ${attempt}/${max_attempts} failed, waiting..."
        sleep 10
        ((attempt++)) || true
    done
    log_error "Health check failed after ${max_attempts} attempts"
    return 1
}

deploy_staging() {
    log_info "Deploying to staging environment..."
    docker compose down || true
    docker compose up -d || return 1
    wait_for_health_check "http://localhost:${APP_PORT}/health" || return 1
    log_success "Staging deployment completed"
}

backup_current_version() {
    log_info "Creating backup of current version..."
    local timestamp backup_tag
    timestamp=$(date +%Y%m%d_%H%M%S)
    backup_tag="${IMAGE_NAME}-backup-${timestamp}"
    docker tag "${REGISTRY}/${IMAGE_NAME}:latest" "${REGISTRY}/${IMAGE_NAME}:${backup_tag}" || true
    if can_push; then
        docker push "${REGISTRY}/${IMAGE_NAME}:${backup_tag}" || true
    fi
    log_success "Backup created: ${backup_tag}"
}

deploy_production() {
    log_info "Deploying to production environment..."
    docker compose --env-file ".env.prod" -f docker-compose.prod.yml up -d || return 1
    wait_for_health_check "${PROD_BASE_URL}/health" || return 1
    run_smoke_tests || return 1
    log_success "Production deployment completed"
}

run_smoke_tests() {
    log_info "Running smoke tests..."
    curl -f -s "${PROD_BASE_URL}/health" > /dev/null
    curl -f -s "${PROD_BASE_URL}/api-docs" > /dev/null || log_warning "Swagger não respondeu (ok se desabilitado)"
    log_success "Smoke tests passed"
}

cleanup() {
    log_info "Cleaning up old images..."
    # Mantém as 5 mais recentes por data de criação; remove o resto.
    docker image ls "${REGISTRY}/${IMAGE_NAME}" --format '{{.CreatedAt}}\t{{.Tag}}' \
        | sort -r \
        | tail -n +6 \
        | cut -f2 \
        | while read -r tag; do
            [ -n "$tag" ] && docker rmi "${REGISTRY}/${IMAGE_NAME}:${tag}" >/dev/null 2>&1 || true
        done
    log_success "Cleanup completed"
}

rollback() {
    log_error "Deployment failed, iniciando rollback..."
    local backup_tag latest_backup
    latest_backup=$(docker images "${REGISTRY}/${IMAGE_NAME}" --format '{{.Tag}}' \
        | grep -E "^${IMAGE_NAME}-backup-" | sort | tail -1 || true)

    if [ -z "$latest_backup" ]; then
        log_warning "Nenhuma imagem de backup encontrada (${IMAGE_NAME}-backup-*)."
        log_warning "Abortando rollback; verifique o estado do serviço manualmente."
        exit 1
    fi

    log_info "Restaurando imagem de backup: ${REGISTRY}/${IMAGE_NAME}:${latest_backup}"
    docker pull "${REGISTRY}/${IMAGE_NAME}:${latest_backup}" || true
    docker tag "${REGISTRY}/${IMAGE_NAME}:${latest_backup}" "${REGISTRY}/${IMAGE_NAME}:${VERSION}"

    if [ "$ENVIRONMENT" = "production" ]; then
        docker compose --env-file ".env.prod" -f docker-compose.prod.yml up -d
    else
        docker compose up -d
    fi

    log_success "Rollback concluído (voltou para ${latest_backup})"
}

# ====================================
# MAIN EXECUTION
# ====================================

main() {
    log_info "Starting deployment process..."
    log_info "Environment: ${ENVIRONMENT}"

    check_prerequisites || { log_error "Pré-requisitos falharam."; exit 1; }
    run_tests || { log_error "Testes falharam; abortando deploy."; exit 1; }

    # Backup ANTES de build_and_push: `latest` ainda aponta para a imagem em
    # execução (rollback precisa da versão anterior, não da recém-construída).
    if [ "$ENVIRONMENT" = "production" ]; then
        backup_current_version || log_warning "Backup não pôde ser criado (primeiro deploy?)."
    fi

    build_and_push || { log_error "Build/push falhou; iniciando rollback."; rollback; exit 1; }

    case "$ENVIRONMENT" in
        staging)
            deploy_staging || { log_error "Deploy de staging falhou; iniciando rollback."; rollback; exit 1; }
            ;;
        production)
            deploy_production || { log_error "Deploy de produção falhou; iniciando rollback."; rollback; exit 1; }
            ;;
    esac

    cleanup || true
    log_success "🎉 Deployment completed successfully!"
}

main "$@"