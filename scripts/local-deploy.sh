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

# Localizar raiz do projeto (este script fica em scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR" || error "Não foi possível acessar $ROOT_DIR"

# ==================================================
# PORTAS — .env é a fonte da verdade. Se uma porta
# estiver em uso, next-port.sh soma +1 até achar livre.
# ==================================================
ENV_FILE="${ENV_FILE:-.env}"
if [ ! -f "$ENV_FILE" ]; then
    warning "$ENV_FILE não existe; copie de .env.example: cp .env.example $ENV_FILE"
fi

declare -A PORTS
while IFS='=' read -r key val; do
    PORTS[$key]="$val"
done <<< "$(bash "$SCRIPT_DIR/next-port.sh" --env "$ENV_FILE")"

needs_update=0
declare -A DEF=( [APP_PORT]=3000 [DEBUG_PORT]=9229 [MONGO_PORT]=27017 [REDIS_PORT]=6379 )
for key in APP_PORT DEBUG_PORT MONGO_PORT REDIS_PORT; do
    cfg="$(grep -E "^${key}=[0-9]+$" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
    desired="${cfg:-${DEF[$key]}}"
    if [ "$desired" != "${PORTS[$key]}" ]; then
        if [ -n "$cfg" ]; then
            log "Porta ${key}: ${cfg} em uso -> ${PORTS[$key]}"
        else
            log "Porta ${key}: ausente no $ENV_FILE; adicionando ${PORTS[$key]}"
        fi
        needs_update=1
    fi
done

if [ "$needs_update" -eq 1 ]; then
    read -p "   Atualizar $ENV_FILE com as portas livres? (Y/n): " -r
    echo
    if [[ $REPLY =~ ^[Yy]$ || -z $REPLY ]]; then
        for key in APP_PORT DEBUG_PORT MONGO_PORT REDIS_PORT; do
            if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
                sed -i "s/^${key}=.*/${key}=${PORTS[$key]}/" "$ENV_FILE"
            else
                echo "${key}=${PORTS[$key]}" >> "$ENV_FILE"
            fi
        done
        success "$ENV_FILE atualizado com portas livres"
    fi
fi

# Parar containers existentes
log "Parando containers existentes..."
docker compose down 2>/dev/null || true

# Limpar volumes antigos (opcional)
read -p "Deseja limpar volumes antigos? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    log "Limpando volumes..."
    docker compose down -v
    docker volume prune -f
fi

# Build da imagem
log "Construindo imagem Docker..."
docker compose build --no-cache

if [ $? -ne 0 ]; then
    error "Falha ao construir a imagem Docker"
fi

# Subir serviços
log "Iniciando serviços..."
docker compose up -d

if [ $? -ne 0 ]; then
    error "Falha ao iniciar os serviços"
fi

# Aguardar serviços ficarem prontos
log "Aguardando serviços ficarem prontos..."
sleep 10

# Verificar saúde dos serviços
log "Verificando saúde dos serviços..."

# Redis
if docker compose exec redis redis-cli ping | grep -q PONG; then
    success "Redis está funcionando"
else
    warning "Redis pode não estar funcionando corretamente"
fi

# MongoDB
if docker compose exec mongodb mongosh --eval "db.runCommand('ping')" | grep -q '"ok"'; then
    success "MongoDB está funcionando"
else
    warning "MongoDB pode não estar funcionando corretamente"
fi

# Aplicação
sleep 5
if curl -s "http://localhost:${PORTS[APP_PORT]}/health" | grep -q "healthy"; then
    success "Aplicação está funcionando"
else
    warning "Aplicação pode não estar funcionando corretamente"
fi

# Executar testes básicos
log "Executando testes de saúde..."
if curl -s "http://localhost:${PORTS[APP_PORT]}/health" >/dev/null; then
    success "Endpoint /health respondendo"
else
    warning "Endpoint /health não está respondendo"
fi

if curl -s "http://localhost:${PORTS[APP_PORT]}/api-docs" >/dev/null; then
    success "Swagger UI disponível"
else
    warning "Swagger UI não está disponível"
fi

# Mostrar logs dos últimos minutos
log "Últimos logs da aplicação:"
docker compose logs --tail=20 auth-service

# Informações finais
echo ""
success "Deploy local concluído!"
echo ""
echo "🌐 Endpoints disponíveis:"
echo "  - Aplicação: http://localhost:${PORTS[APP_PORT]}"
echo "  - Health Check: http://localhost:${PORTS[APP_PORT]}/health"
echo "  - Swagger UI: http://localhost:${PORTS[APP_PORT]}/api-docs"
echo "  - Métricas: http://localhost:${PORTS[APP_PORT]}/metrics"
echo ""
echo "📊 Para monitorar logs:"
echo "  docker compose logs -f auth-service"
echo ""
echo "🛑 Para parar:"
echo "  docker compose down"
