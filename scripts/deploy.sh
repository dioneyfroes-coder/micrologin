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

    APP_PORT=${APP_PORT:-3000}
    PROD_BASE_URL=${PROD_BASE_URL:-https://api.yourapp.com}

    log_success "Prerequisites check passed"
}

run_tests() {
    log_info "Running tests before deployment..."
    npm run test:unit:fast
    npm run test:integration:app
    log_success "All tests passed"
}

build_and_push() {
    log_info "Building and pushing Docker image..."
    local ts sha commit_tag
    ts=$(date +%Y%m%d%H%M%S)
    sha=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "no-git")
    commit_tag="${sha}-${ts}"

    # Tag imutável (SHA do commit + data) para rastreabilidade/rollback
    docker build -t "${REGISTRY}/${IMAGE_NAME}:${commit_tag}" .
    docker push "${REGISTRY}/${IMAGE_NAME}:${commit_tag}"

    # Tag mutável (latest ou VERSION) apontando para o mesmo build
    docker tag "${REGISTRY}/${IMAGE_NAME}:${commit_tag}" "${REGISTRY}/${IMAGE_NAME}:${VERSION}"
    docker push "${REGISTRY}/${IMAGE_NAME}:${VERSION}"

    export IMAGE_TAG="${commit_tag}"
    log_success "Image built and pushed: ${REGISTRY}/${IMAGE_NAME}:${commit_tag} (${VERSION})"
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
    docker compose up -d
    wait_for_health_check "http://localhost:${APP_PORT}/health"
    log_success "Staging deployment completed"
}

backup_current_version() {
    log_info "Creating backup of current version..."
    local timestamp backup_tag
    timestamp=$(date +%Y%m%d_%H%M%S)
    backup_tag="${IMAGE_NAME}-backup-${timestamp}"
    docker tag "${REGISTRY}/${IMAGE_NAME}:latest" "${REGISTRY}/${IMAGE_NAME}:${backup_tag}" || true
    docker push "${REGISTRY}/${IMAGE_NAME}:${backup_tag}" || true
    log_success "Backup created: ${backup_tag}"
}

deploy_production() {
    log_info "Deploying to production environment..."
    backup_current_version
    docker compose --env-file ".env.prod" -f docker-compose.prod.yml up -d
    wait_for_health_check "${PROD_BASE_URL}/health"
    run_smoke_tests
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
    docker images "${REGISTRY}/${IMAGE_NAME}" --format "table {{.Tag}}" | grep -v TAG | sort -V | head -n -5 | xargs -r -I{} docker rmi "${REGISTRY}/${IMAGE_NAME}:{}" || true
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

    check_prerequisites
    run_tests
    build_and_push

    case "$ENVIRONMENT" in
        staging)    deploy_staging ;;
        production) deploy_production ;;
    esac

    cleanup
    log_success "🎉 Deployment completed successfully!"
}

trap 'log_error "Deployment failed!"; rollback; exit 1' ERR

main "$@"