#!/bin/bash

# ====================================
# SCRIPT DE BUILD AUTOMATIZADO
# Authentication Microservice
# ====================================

set -euo pipefail

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configurações
BUILD_TYPE=${1:-development}
VERSION=${2:-$(git describe --tags --always)}
REGISTRY=${REGISTRY:-ghcr.io/your-org}
SERVICE_NAME="auth-service"

echo -e "${BLUE}🏗️  Building ${SERVICE_NAME} - ${BUILD_TYPE} (${VERSION})${NC}"

# ====================================
# FUNÇÕES
# ====================================

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

cleanup_build() {
    log_info "Cleaning up build artifacts..."
    rm -rf dist/ build/ .tmp/ || true
    docker system prune -f --filter "label=build=temp" || true
    log_success "Build cleanup completed"
}

lint_code() {
    log_info "Running code linting..."
    npm run lint || {
        log_warning "Linting found issues, but continuing build..."
    }
    log_success "Code linting completed"
}

run_security_scan() {
    log_info "Running security scan..."
    
    # Audit npm dependencies
    npm audit --audit-level=high || {
        log_warning "Security audit found issues"
    }
    
    # Scan with safety CLI if available
    if command -v safety &> /dev/null; then
        safety check || {
            log_warning "Safety scan found issues"
        }
    fi
    
    log_success "Security scan completed"
}

build_application() {
    log_info "Building application..."
    
    # Clean install dependencies
    rm -rf node_modules package-lock.json
    npm install
    
    # Run tests
    npm run test:unit:fast
    
    # Build for production if needed
    if [ "$BUILD_TYPE" = "production" ]; then
        npm prune --production
    fi
    
    log_success "Application build completed"
}

build_docker_image() {
    log_info "Building Docker image..."
    
    local target="production"
    if [ "$BUILD_TYPE" = "development" ]; then
        target="development"
    fi
    
    # Build multi-arch image
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        --target $target \
        --tag ${REGISTRY}/${SERVICE_NAME}:${VERSION} \
        --tag ${REGISTRY}/${SERVICE_NAME}:latest \
        --label "version=${VERSION}" \
        --label "build-date=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        --label "git-commit=$(git rev-parse HEAD)" \
        --label "build-type=${BUILD_TYPE}" \
        --push \
        .
    
    log_success "Docker image built: ${REGISTRY}/${SERVICE_NAME}:${VERSION}"
}

scan_docker_image() {
    log_info "Scanning Docker image for vulnerabilities..."
    
    # Usar Trivy se disponível
    if command -v trivy &> /dev/null; then
        trivy image --severity HIGH,CRITICAL ${REGISTRY}/${SERVICE_NAME}:${VERSION} || {
            log_warning "Image scan found vulnerabilities"
        }
    fi
    
    log_success "Docker image scan completed"
}

generate_sbom() {
    log_info "Generating Software Bill of Materials (SBOM)..."
    
    # Usar syft se disponível
    if command -v syft &> /dev/null; then
        syft ${REGISTRY}/${SERVICE_NAME}:${VERSION} -o json > sbom.json
        log_success "SBOM generated: sbom.json"
    else
        log_warning "SBOM generation skipped (syft not available)"
    fi
}

create_build_report() {
    log_info "Creating build report..."
    
    cat > build-report.json << EOF
{
  "service": "${SERVICE_NAME}",
  "version": "${VERSION}",
  "buildType": "${BUILD_TYPE}",
  "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "gitCommit": "$(git rev-parse HEAD)",
  "gitBranch": "$(git rev-parse --abbrev-ref HEAD)",
  "image": "${REGISTRY}/${SERVICE_NAME}:${VERSION}",
  "nodeVersion": "$(node --version)",
  "npmVersion": "$(npm --version)"
}
EOF
    
    log_success "Build report created: build-report.json"
}

# ====================================
# MAIN EXECUTION
# ====================================

main() {
    log_info "Starting build process..."
    
    # Cleanup
    cleanup_build
    
    # Code quality checks
    lint_code
    run_security_scan
    
    # Build application
    build_application
    
    # Build Docker image
    build_docker_image
    
    # Security scans
    scan_docker_image
    
    # Generate artifacts
    generate_sbom
    create_build_report
    
    log_success "🎉 Build completed successfully!"
    log_info "Image: ${REGISTRY}/${SERVICE_NAME}:${VERSION}"
}

# Trap para cleanup em caso de erro
trap 'log_error "Build failed!"; cleanup_build; exit 1' ERR

# Executar main
main "$@"
