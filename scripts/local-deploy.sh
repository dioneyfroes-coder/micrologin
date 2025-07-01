#!/bin/bash

# ======================================
# Script de Deploy Local - Desenvolvimento
# ======================================

echo "🚀 Iniciando deploy local para desenvolvimento..."

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

# Verificar se Docker está rodando
if ! docker info >/dev/null 2>&1; then
    error "Docker não está rodando. Inicie o Docker primeiro."
fi

# Parar containers existentes
log "Parando containers existentes..."
docker-compose down 2>/dev/null || true

# Limpar volumes antigos (opcional)
read -p "Deseja limpar volumes antigos? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    log "Limpando volumes..."
    docker-compose down -v
    docker volume prune -f
fi

# Build da imagem
log "Construindo imagem Docker..."
docker-compose build --no-cache

if [ $? -ne 0 ]; then
    error "Falha ao construir a imagem Docker"
fi

# Subir serviços
log "Iniciando serviços..."
docker-compose up -d

if [ $? -ne 0 ]; then
    error "Falha ao iniciar os serviços"
fi

# Aguardar serviços ficarem prontos
log "Aguardando serviços ficarem prontos..."
sleep 10

# Verificar saúde dos serviços
log "Verificando saúde dos serviços..."

# Redis
if docker-compose exec redis redis-cli ping | grep -q PONG; then
    success "Redis está funcionando"
else
    warning "Redis pode não estar funcionando corretamente"
fi

# MongoDB
if docker-compose exec mongodb mongosh --eval "db.runCommand('ping')" | grep -q '"ok"'; then
    success "MongoDB está funcionando"
else
    warning "MongoDB pode não estar funcionando corretamente"
fi

# Aplicação
sleep 5
if curl -k -s https://localhost:3000/health | grep -q "healthy"; then
    success "Aplicação está funcionando"
else
    warning "Aplicação pode não estar funcionando corretamente"
fi

# Executar testes básicos
log "Executando testes de saúde..."
if curl -k -s https://localhost:3000/health >/dev/null; then
    success "Endpoint /health respondendo"
else
    warning "Endpoint /health não está respondendo"
fi

if curl -k -s https://localhost:3000/api-docs >/dev/null; then
    success "Swagger UI disponível"
else
    warning "Swagger UI não está disponível"
fi

# Mostrar logs dos últimos minutos
log "Últimos logs da aplicação:"
docker-compose logs --tail=20 app

# Informações finais
echo ""
success "Deploy local concluído!"
echo ""
echo "🌐 Endpoints disponíveis:"
echo "  - Aplicação: https://localhost:3000"
echo "  - Health Check: https://localhost:3000/health"
echo "  - Swagger UI: https://localhost:3000/api-docs"
echo "  - Métricas: https://localhost:3000/metrics"
echo ""
echo "📊 Para monitorar logs:"
echo "  docker-compose logs -f app"
echo ""
echo "🛑 Para parar:"
echo "  docker-compose down"
