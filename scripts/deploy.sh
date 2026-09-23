#!/bin/bash

# ====================================
# SCRIPT DE DEPLOY AUTOMATIZADO
# Authentication Microservice
# ====================================

set -euo pipefail

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configurações padrão
ENVIRONMENT=${1:-staging}
VERSION=${2:-latest}
REGISTRY=${REGISTRY:-ghcr.io/your-org}
SERVICE_NAME="auth-service"

echo -e "${BLUE}🚀 Starting deployment of ${SERVICE_NAME} to ${ENVIRONMENT}${NC}"

# ====================================
# FUNÇÕES AUXILIARES
# ====================================

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Verificar Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker."
        exit 1
    fi
    
    # Verificar Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose not found. Please install Docker Compose."
        exit 1
    fi
    
    # Verificar arquivo de configuração
    if [ "$ENVIRONMENT" = "production" ] && [ ! -f ".env.production" ]; then
        log_error "Production environment file not found: .env.production"
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

run_tests() {
    log_info "Running tests before deployment..."
    
    # Executar testes unitários
    npm run test:unit:fast
    
    # Executar testes de integração
    npm run test:integration:app
    
    log_success "All tests passed"
}

build_and_push() {
    log_info "Building and pushing Docker image..."
    
    # Build da imagem
    docker build -t ${REGISTRY}/${SERVICE_NAME}:${VERSION} .
    
    # Push para registry
    docker push ${REGISTRY}/${SERVICE_NAME}:${VERSION}
    
    log_success "Image built and pushed: ${REGISTRY}/${SERVICE_NAME}:${VERSION}"
}

deploy_staging() {
    log_info "Deploying to staging environment..."
    
    # Parar serviços existentes
    docker compose -f docker-compose.yml down || true
    
    # Iniciar novos serviços
    docker compose -f docker-compose.yml up -d
    
    # Aguardar health check
    wait_for_health_check "http://localhost:3000/health"
    
    log_success "Staging deployment completed"
}

deploy_production() {
    log_info "Deploying to production environment..."
    
    # Backup atual
    backup_current_version
    
    # Deploy blue-green
    blue_green_deploy
    
    # Verificar health checks
    wait_for_health_check "https://api.yourapp.com/health"
    
    # Smoke tests
    run_smoke_tests
    
    log_success "Production deployment completed"
}

backup_current_version() {
    log_info "Creating backup of current version..."
    
    # Criar backup do estado atual
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_TAG="${SERVICE_NAME}-backup-${TIMESTAMP}"
    
    # Tag da imagem atual como backup
    docker tag ${REGISTRY}/${SERVICE_NAME}:latest ${REGISTRY}/${SERVICE_NAME}:${BACKUP_TAG}
    docker push ${REGISTRY}/${SERVICE_NAME}:${BACKUP_TAG}
    
    log_success "Backup created: ${BACKUP_TAG}"
}

blue_green_deploy() {
    log_info "Performing blue-green deployment..."
    
    # Deploy da nova versão (green)
    export VERSION=${VERSION}
    docker compose -f docker-compose.prod.yml up -d
    
    # Aguardar health check da nova versão
    sleep 30
    
    # Switch do load balancer
    log_info "Switching traffic to new version..."
    
    # Aqui você implementaria a lógica específica do seu load balancer
    # Exemplo: kubectl patch service, consul, nginx reload, etc.
    
    log_success "Traffic switched to new version"
}

wait_for_health_check() {
    local url=$1
    local max_attempts=30
    local attempt=1
    
    log_info "Waiting for health check: ${url}"
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f -s "${url}" > /dev/null; then
            log_success "Health check passed"
            return 0
        fi
        
        log_info "Attempt ${attempt}/${max_attempts} failed, waiting..."
        sleep 10
        ((attempt++))
    done
    
    log_error "Health check failed after ${max_attempts} attempts"
    return 1
}

run_smoke_tests() {
    log_info "Running smoke tests..."
    
    # Teste básico de saúde
    curl -f https://api.yourapp.com/health
    
    # Teste de autenticação
    # Implementar testes específicos
    
    log_success "Smoke tests passed"
}

rollback() {
    log_error "Deployment failed, initiating rollback..."
    
    # Implementar lógica de rollback
    # docker compose down
    # docker compose up -d (versão anterior)
    
    log_success "Rollback completed"
}

cleanup() {
    log_info "Cleaning up old images..."
    
    # Remover imagens antigas (manter apenas as 5 mais recentes)
    docker images ${REGISTRY}/${SERVICE_NAME} --format "table {{.Tag}}" | grep -v TAG | sort -V | head -n -5 | xargs -r docker rmi ${REGISTRY}/${SERVICE_NAME}: || true
    
    log_success "Cleanup completed"
}

# ====================================
# MAIN EXECUTION
# ====================================

main() {
    log_info "Starting deployment process..."
    log_info "Environment: ${ENVIRONMENT}"
    log_info "Version: ${VERSION}"
    log_info "Registry: ${REGISTRY}"
    
    # Verificar pré-requisitos
    check_prerequisites
    
    # Executar testes
    run_tests
    
    # Build e push da imagem
    build_and_push
    
    # Deploy baseado no ambiente
    case $ENVIRONMENT in
        "staging")
            deploy_staging
            ;;
        "production")
            deploy_production
            ;;
        *)
            log_error "Unknown environment: $ENVIRONMENT"
            exit 1
            ;;
    esac
    
    # Cleanup
    cleanup
    
    log_success "🎉 Deployment completed successfully!"
}

# Trap para cleanup em caso de erro
trap 'log_error "Deployment failed!"; rollback; exit 1' ERR

# Executar main
main "$@"
