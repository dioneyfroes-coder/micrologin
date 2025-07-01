#!/bin/bash

# ======================================
# Script de Inicialização do Ambiente
# ======================================

echo "🚀 Inicializando ambiente de desenvolvimento..."

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Função para logs
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
    exit 1
}

success() {
    echo -e "${GREEN}[SUCCESS] $1${NC}"
}

warning() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

# Verificar dependências do sistema
log "Verificando dependências do sistema..."

# Node.js
if ! command -v node >/dev/null 2>&1; then
    error "Node.js não está instalado. Instale o Node.js v18+ primeiro."
fi

NODE_VERSION=$(node --version | cut -d'v' -f2)
if [ "$(printf '%s\n' "18.0.0" "$NODE_VERSION" | sort -V | head -n1)" != "18.0.0" ]; then
    warning "Node.js versão $NODE_VERSION detectada. Recomendado: v18+"
else
    success "Node.js $NODE_VERSION ✓"
fi

# npm
if ! command -v npm >/dev/null 2>&1; then
    error "npm não está instalado."
fi
success "npm $(npm --version) ✓"

# Docker
if ! command -v docker >/dev/null 2>&1; then
    warning "Docker não está instalado. Algumas funcionalidades podem não funcionar."
else
    if ! docker info >/dev/null 2>&1; then
        warning "Docker não está rodando. Inicie o Docker para funcionalidades completas."
    else
        success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') ✓"
    fi
fi

# docker-compose
if command -v docker-compose >/dev/null 2>&1; then
    success "docker-compose $(docker-compose --version | cut -d' ' -f3 | tr -d ',') ✓"
elif docker compose version >/dev/null 2>&1; then
    success "docker compose $(docker compose version --short) ✓"
else
    warning "docker-compose não está disponível."
fi

# Git
if command -v git >/dev/null 2>&1; then
    success "Git $(git --version | cut -d' ' -f3) ✓"
else
    warning "Git não está instalado."
fi

# Instalar dependências do projeto
log "Instalando dependências do projeto..."
if [ -f "package.json" ]; then
    npm install
    if [ $? -eq 0 ]; then
        success "Dependências instaladas"
    else
        error "Falha ao instalar dependências"
    fi
else
    error "package.json não encontrado"
fi

# Verificar arquivo .env
log "Verificando configuração de ambiente..."
if [ ! -f ".env" ]; then
    warning "Arquivo .env não encontrado. Criando arquivo modelo..."
    cat > .env << EOF
# ======================================
# Configuração de Ambiente - Development
# ======================================

# Ambiente
NODE_ENV=development

# Servidor
PORT=3000
HOST=localhost

# Banco de dados
MONGODB_URI=mongodb://localhost:27017/auth_dev
MONGODB_TEST_URI=mongodb://localhost:27017/auth_test

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# JWT
JWT_SECRET=your_jwt_secret_here_change_in_production
JWT_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d

# Rate Limiting
RATE_LIMIT_IP_POINTS=100
RATE_LIMIT_IP_DURATION=900
RATE_LIMIT_LOGIN_POINTS=5
RATE_LIMIT_LOGIN_DURATION=900

# SSL
SSL_CERT_PATH=./server.crt
SSL_KEY_PATH=./server.key

# Logs
LOG_LEVEL=debug
LOG_FORMAT=combined

# Métricas
METRICS_ENABLED=true

# Swagger
SWAGGER_ENABLED=true
EOF
    success "Arquivo .env criado. Configure as variáveis conforme necessário."
else
    success "Arquivo .env existe"
fi

# Verificar certificados SSL
log "Verificando certificados SSL..."
if [ ! -f "server.crt" ] || [ ! -f "server.key" ]; then
    warning "Certificados SSL não encontrados. Gerando certificados auto-assinados..."
    
    # Gerar certificados auto-assinados
    openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -days 365 -nodes \
        -subj "/C=BR/ST=State/L=City/O=Organization/CN=localhost" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        success "Certificados SSL gerados"
    else
        warning "Falha ao gerar certificados SSL. Verifique se openssl está instalado."
    fi
else
    success "Certificados SSL existem"
fi

# Executar testes básicos
log "Executando testes básicos..."
npm run test:unit:quick
if [ $? -eq 0 ]; then
    success "Testes básicos passaram"
else
    warning "Alguns testes falharam. Verifique a configuração."
fi

# Verificar lint
log "Verificando qualidade do código..."
npm run lint:check 2>/dev/null
if [ $? -eq 0 ]; then
    success "Código passa na verificação de qualidade"
else
    warning "Código tem problemas de qualidade. Execute 'npm run lint:fix' para corrigir."
fi

# Preparar ambiente Docker (se disponível)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "Preparando ambiente Docker..."
    
    # Verificar se as imagens base existem
    docker pull node:22-alpine >/dev/null 2>&1 &
    docker pull redis:7-alpine >/dev/null 2>&1 &
    docker pull mongo:7 >/dev/null 2>&1 &
    
    wait
    success "Imagens Docker preparadas"
fi

# Configurar hooks do Git (se Git estiver disponível)
if command -v git >/dev/null 2>&1 && [ -d ".git" ]; then
    log "Configurando hooks do Git..."
    
    # Criar hook pre-commit
    mkdir -p .git/hooks
    cat > .git/hooks/pre-commit << EOF
#!/bin/bash
npm run pre-commit
EOF
    chmod +x .git/hooks/pre-commit
    success "Hook pre-commit configurado"
fi

# Criar diretórios necessários
log "Criando diretórios necessários..."
mkdir -p logs
mkdir -p backups
mkdir -p performance-results
success "Diretórios criados"

# Informações finais
echo ""
echo "🎉 Ambiente inicializado com sucesso!"
echo ""
echo "📋 Próximos passos:"
echo "  1. Configure as variáveis no arquivo .env"
echo "  2. Inicie os serviços: npm run docker:up"
echo "  3. Execute a aplicação: npm run dev"
echo "  4. Acesse: https://localhost:3000"
echo ""
echo "🔧 Comandos úteis:"
echo "  - Testes rápidos: npm run test:unit:fast"
echo "  - Deploy local: npm run deploy:local"
echo "  - Performance: npm run performance"
echo "  - Backup: npm run backup"
echo "  - Logs: npm run docker:logs"
echo ""
echo "📚 Documentação:"
echo "  - API: https://localhost:3000/api-docs"
echo "  - Health: https://localhost:3000/health"
echo "  - Métricas: https://localhost:3000/metrics"
