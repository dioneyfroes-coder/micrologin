#!/bin/bash

# ======================================
# Script de Backup e Restore
# ======================================

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configurações
BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
MONGODB_CONTAINER="mongodb"
REDIS_CONTAINER="redis"

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

# Função de ajuda
show_help() {
    echo "Script de Backup e Restore"
    echo ""
    echo "Uso: $0 [comando] [opções]"
    echo ""
    echo "Comandos:"
    echo "  backup          Criar backup completo"
    echo "  restore [file]  Restaurar backup específico"
    echo "  list           Listar backups disponíveis"
    echo "  clean          Limpar backups antigos (>30 dias)"
    echo ""
    echo "Exemplos:"
    echo "  $0 backup"
    echo "  $0 restore backup_20231201_143022.tar.gz"
    echo "  $0 list"
    echo "  $0 clean"
}

# Função para criar backup
create_backup() {
    log "Iniciando processo de backup..."
    
    # Criar diretório de backup
    mkdir -p $BACKUP_DIR
    
    local backup_name="backup_${TIMESTAMP}"
    local backup_path="$BACKUP_DIR/$backup_name"
    mkdir -p $backup_path
    
    # Verificar se containers estão rodando
    if ! docker ps | grep -q $MONGODB_CONTAINER; then
        warning "Container MongoDB não está rodando"
    else
        log "Fazendo backup do MongoDB..."
        docker exec $MONGODB_CONTAINER mongodump --out /tmp/mongodb_backup
        docker cp $MONGODB_CONTAINER:/tmp/mongodb_backup $backup_path/
        success "Backup MongoDB concluído"
    fi
    
    if ! docker ps | grep -q $REDIS_CONTAINER; then
        warning "Container Redis não está rodando"
    else
        log "Fazendo backup do Redis..."
        docker exec $REDIS_CONTAINER redis-cli BGSAVE
        sleep 2
        docker cp $REDIS_CONTAINER:/data/dump.rdb $backup_path/redis_dump.rdb
        success "Backup Redis concluído"
    fi
    
    # Backup dos arquivos de configuração
    log "Fazendo backup dos arquivos de configuração..."
    cp -r src/ $backup_path/
    cp package*.json $backup_path/
    cp docker-compose*.yml $backup_path/
    cp Dockerfile $backup_path/
    [ -f .env ] && cp .env $backup_path/
    
    # Backup dos certificados
    [ -f server.crt ] && cp server.crt $backup_path/
    [ -f server.key ] && cp server.key $backup_path/
    
    # Criar arquivo de metadados
    cat > $backup_path/metadata.json << EOF
{
    "timestamp": "$TIMESTAMP",
    "date": "$(date)",
    "version": "$(npm version --json | jq -r .autentication)",
    "node_version": "$(node --version)",
    "npm_version": "$(npm --version)",
    "git_commit": "$(git rev-parse HEAD 2>/dev/null || echo 'unknown')",
    "git_branch": "$(git branch --show-current 2>/dev/null || echo 'unknown')"
}
EOF
    
    # Compactar backup
    log "Compactando backup..."
    cd $BACKUP_DIR
    tar -czf "${backup_name}.tar.gz" $backup_name
    rm -rf $backup_name
    cd - >/dev/null
    
    success "Backup criado: $BACKUP_DIR/${backup_name}.tar.gz"
    
    # Mostrar informações do backup
    local backup_size=$(du -h "$BACKUP_DIR/${backup_name}.tar.gz" | awk '{print $1}')
    echo "📊 Informações do backup:"
    echo "  - Arquivo: ${backup_name}.tar.gz"
    echo "  - Tamanho: $backup_size"
    echo "  - Data: $(date)"
}

# Função para restaurar backup
restore_backup() {
    local backup_file=$1
    
    if [ -z "$backup_file" ]; then
        error "Especifique o arquivo de backup para restaurar"
    fi
    
    if [ ! -f "$BACKUP_DIR/$backup_file" ]; then
        error "Arquivo de backup não encontrado: $BACKUP_DIR/$backup_file"
    fi
    
    log "Iniciando processo de restore do backup: $backup_file"
    
    # Confirmar operação
    echo -e "${YELLOW}⚠️  ATENÇÃO: Esta operação irá sobrescrever os dados atuais!${NC}"
    read -p "Tem certeza que deseja continuar? (yes/NO): " -r
    if [[ ! $REPLY =~ ^yes$ ]]; then
        echo "Operação cancelada."
        exit 0
    fi
    
    # Extrair backup
    local temp_dir="$BACKUP_DIR/temp_restore_$$"
    mkdir -p $temp_dir
    cd $temp_dir
    tar -xzf "../$backup_file"
    
    local backup_dir=$(ls -1 | head -1)
    cd $backup_dir
    
    # Mostrar informações do backup
    if [ -f metadata.json ]; then
        echo "📋 Informações do backup:"
        cat metadata.json | jq .
        echo ""
    fi
    
    # Parar aplicação
    log "Parando aplicação..."
    docker-compose down 2>/dev/null || true
    
    # Restaurar MongoDB
    if [ -d mongodb_backup ]; then
        log "Restaurando MongoDB..."
        docker-compose up -d mongodb
        sleep 5
        docker cp mongodb_backup $MONGODB_CONTAINER:/tmp/
        docker exec $MONGODB_CONTAINER mongorestore --drop /tmp/mongodb_backup
        success "MongoDB restaurado"
    fi
    
    # Restaurar Redis
    if [ -f redis_dump.rdb ]; then
        log "Restaurando Redis..."
        docker-compose up -d redis
        sleep 2
        docker cp redis_dump.rdb $REDIS_CONTAINER:/data/dump.rdb
        docker restart $REDIS_CONTAINER
        success "Redis restaurado"
    fi
    
    # Restaurar arquivos de aplicação
    log "Restaurando arquivos de aplicação..."
    cd - >/dev/null
    cp -r $temp_dir/$backup_dir/src/* src/ 2>/dev/null || true
    cp $temp_dir/$backup_dir/package*.json . 2>/dev/null || true
    cp $temp_dir/$backup_dir/.env . 2>/dev/null || true
    
    # Limpar arquivos temporários
    rm -rf $temp_dir
    
    # Reinstalar dependências
    log "Reinstalando dependências..."
    npm install
    
    # Reiniciar aplicação
    log "Reiniciando aplicação..."
    docker-compose up -d
    
    success "Restore concluído com sucesso!"
    
    # Verificar saúde da aplicação
    sleep 10
    if curl -k -s https://localhost:3000/health >/dev/null; then
        success "Aplicação está funcionando corretamente"
    else
        warning "Verifique se a aplicação iniciou corretamente"
    fi
}

# Função para listar backups
list_backups() {
    log "Backups disponíveis:"
    
    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A $BACKUP_DIR 2>/dev/null)" ]; then
        echo "  Nenhum backup encontrado."
        return
    fi
    
    echo ""
    printf "%-30s %-10s %-20s\n" "Arquivo" "Tamanho" "Data"
    printf "%-30s %-10s %-20s\n" "$(printf '%*s' 30 | tr ' ' '-')" "$(printf '%*s' 10 | tr ' ' '-')" "$(printf '%*s' 20 | tr ' ' '-')"
    
    for backup in $BACKUP_DIR/*.tar.gz; do
        if [ -f "$backup" ]; then
            local filename=$(basename "$backup")
            local size=$(du -h "$backup" | awk '{print $1}')
            local date=$(stat -c %y "$backup" 2>/dev/null || stat -f %Sm "$backup" 2>/dev/null)
            printf "%-30s %-10s %-20s\n" "$filename" "$size" "$(echo $date | cut -d' ' -f1)"
        fi
    done
}

# Função para limpar backups antigos
clean_backups() {
    log "Limpando backups antigos (>30 dias)..."
    
    if [ ! -d "$BACKUP_DIR" ]; then
        echo "  Nenhum diretório de backup encontrado."
        return
    fi
    
    local removed=0
    for backup in $BACKUP_DIR/*.tar.gz; do
        if [ -f "$backup" ]; then
            # Verificar se o arquivo tem mais de 30 dias
            if [ $(find "$backup" -mtime +30 -print | wc -l) -gt 0 ]; then
                echo "  Removendo: $(basename "$backup")"
                rm "$backup"
                ((removed++))
            fi
        fi
    done
    
    if [ $removed -eq 0 ]; then
        echo "  Nenhum backup antigo encontrado."
    else
        success "$removed backup(s) removido(s)"
    fi
}

# Main
case "$1" in
    backup)
        create_backup
        ;;
    restore)
        restore_backup "$2"
        ;;
    list)
        list_backups
        ;;
    clean)
        clean_backups
        ;;
    *)
        show_help
        ;;
esac
