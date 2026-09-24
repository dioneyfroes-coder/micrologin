#!/bin/bash

# ======================================
# SCRIPT DE MONITORAMENTO AUTOMATIZADO
# ======================================

# Configurações — lidas do .env (fonte da verdade) e sobrescrevíveis por variável de ambiente.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

# Porta pública do app vem do .env (next-port.sh resolve a APP_PORT configurada).
resolved_port="$(bash "$SCRIPT_DIR/next-port.sh" --env "$ENV_FILE" 2>/dev/null | sed -n 's/^APP_PORT=//p')"
SERVICE_URL="${SERVICE_URL:-http://localhost:${resolved_port:-3000}}"
ALERT_EMAIL="${ALERT_EMAIL:-admin@company.com}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}" # deixe vazio para desativar Slack
LOG_FILE="${LOG_FILE:-$PROJECT_DIR/logs/auth-service-monitor.log}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}" # segundos

mkdir -p "$(dirname "$LOG_FILE")"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Função para logs
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[SUCCESS] $1${NC}" | tee -a "$LOG_FILE"
}

warning() {
    echo -e "${YELLOW}[WARNING] $1${NC}" | tee -a "$LOG_FILE"
}

# Função para enviar alerta por email
send_email_alert() {
    local subject="$1"
    local body="$2"
    
    if command -v mail &> /dev/null; then
        echo "$body" | mail -s "$subject" "$ALERT_EMAIL"
        log "Email alert sent to $ALERT_EMAIL"
    else
        warning "Mail command not found. Install mailutils or configure SMTP."
    fi
}

# Função para enviar alerta no Slack
send_slack_alert() {
    local message="$1"
    local color="$2"  # good, warning, danger
    
    if [[ -n "$SLACK_WEBHOOK" ]]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"attachments\":[{\"color\":\"$color\",\"text\":\"$message\"}]}" \
            "$SLACK_WEBHOOK" &> /dev/null
        log "Slack alert sent"
    fi
}

# Verificar saúde do serviço
check_health() {
    local response=$(curl -k -s -w "%{http_code}" -o /tmp/health_response.json "$SERVICE_URL/health")
    local http_code="${response: -3}"
    
    if [[ "$http_code" == "200" ]]; then
        local status=$(cat /tmp/health_response.json | jq -r '.status' 2>/dev/null)
        if [[ "$status" == "healthy" ]]; then
            success "Service is healthy"
            return 0
        else
            warning "Service is degraded: $status"
            return 1
        fi
    else
        error "Service health check failed (HTTP $http_code)"
        return 2
    fi
}

# Verificar métricas do sistema
check_metrics() {
    local metrics=$(curl -k -s "$SERVICE_URL/metrics")
    
    # Verificar se há dados de métrica
    if [[ -z "$metrics" ]]; then
        error "No metrics data available"
        return 1
    fi
    
    # Extrair métricas importantes
    local cpu_usage=$(echo "$metrics" | grep "process_cpu_seconds_total" | tail -1 | awk '{print $2}')
    local memory_usage=$(echo "$metrics" | grep "process_resident_memory_bytes" | tail -1 | awk '{print $2}')
    local request_count=$(echo "$metrics" | grep "http_requests_total" | tail -1 | awk '{print $2}')
    
    log "CPU: ${cpu_usage}s, Memory: ${memory_usage} bytes, Requests: ${request_count}"
    
    return 0
}

# Verificar dashboard de segurança
check_security_dashboard() {
    local security_stats=$(curl -k -s "$SERVICE_URL/security/stats")
    
    if [[ -z "$security_stats" ]]; then
        error "Security dashboard not responding"
        return 1
    fi
    
    # Verificar nível de risco
    local risk_level=$(echo "$security_stats" | jq -r '.security.riskLevel' 2>/dev/null)
    local blocked_requests=$(echo "$security_stats" | jq -r '.security.blockedRequests' 2>/dev/null)
    
    case "$risk_level" in
        "LOW")
            success "Security risk level: LOW"
            ;;
        "MEDIUM")
            warning "Security risk level: MEDIUM ($blocked_requests blocked requests)"
            ;;
        "HIGH")
            error "Security risk level: HIGH ($blocked_requests blocked requests)"
            send_email_alert "🚨 HIGH SECURITY RISK" "Security risk level is HIGH with $blocked_requests blocked requests"
            send_slack_alert "🚨 HIGH SECURITY RISK: $blocked_requests blocked requests" "danger"
            ;;
    esac
    
    return 0
}

# Verificar logs de segurança
check_security_logs() {
    local recent_events=$(curl -k -s "$SERVICE_URL/security/events?limit=10")
    
    if [[ -z "$recent_events" ]]; then
        warning "No recent security events"
        return 0
    fi
    
    # Contar eventos críticos nas últimas 24h
    local critical_events=$(echo "$recent_events" | jq '[.events[] | select(.severity == "critical")] | length' 2>/dev/null)
    
    if [[ "$critical_events" -gt 0 ]]; then
        error "Found $critical_events critical security events in the last 24h"
        send_email_alert "🚨 Critical Security Events" "Found $critical_events critical security events"
        send_slack_alert "🚨 $critical_events critical security events detected" "danger"
    fi
    
    return 0
}

# Verificar conectividade com dependências
check_dependencies() {
    local health_response=$(curl -k -s "$SERVICE_URL/health")
    
    # Verificar MongoDB
    local mongodb_status=$(echo "$health_response" | jq -r '.services.mongodb.status' 2>/dev/null)
    if [[ "$mongodb_status" != "healthy" ]]; then
        error "MongoDB is not healthy: $mongodb_status"
        send_email_alert "🚨 MongoDB Issue" "MongoDB status: $mongodb_status"
        send_slack_alert "🚨 MongoDB issue detected: $mongodb_status" "warning"
    fi
    
    # Verificar Redis
    local redis_status=$(echo "$health_response" | jq -r '.services.redis.status' 2>/dev/null)
    if [[ "$redis_status" != "healthy" ]] && [[ "$redis_status" != "degraded" ]]; then
        warning "Redis is not optimal: $redis_status"
    fi
    
    return 0
}

# Verificar rate limiting
check_rate_limiting() {
    local rate_limit_info=$(curl -k -s "$SERVICE_URL/debug/ratelimit" 2>/dev/null)
    
    if [[ -n "$rate_limit_info" ]]; then
        local blocked_ips=$(echo "$rate_limit_info" | jq -r '.blocked | length' 2>/dev/null)
        if [[ "$blocked_ips" -gt 5 ]]; then
            warning "High number of blocked IPs: $blocked_ips"
        fi
    fi
    
    return 0
}

# Função principal de monitoramento
monitor_service() {
    log "Starting monitoring cycle..."
    
    # Verificações básicas
    if ! check_health; then
        error "Health check failed"
        send_email_alert "🚨 Service Health Check Failed" "The authentication service is not responding properly"
        send_slack_alert "🚨 Authentication service health check failed" "danger"
    fi
    
    # Verificar métricas
    check_metrics
    
    # Verificar segurança
    check_security_dashboard
    check_security_logs
    
    # Verificar dependências
    check_dependencies
    
    # Verificar rate limiting
    check_rate_limiting
    
    success "Monitoring cycle completed"
    echo "----------------------------------------" | tee -a "$LOG_FILE"
}

# Função para executar uma vez
run_once() {
    log "Running single monitoring check..."
    monitor_service
}

# Função para executar continuamente
run_continuous() {
    log "Starting continuous monitoring (interval: ${CHECK_INTERVAL}s)..."
    
    while true; do
        monitor_service
        sleep "$CHECK_INTERVAL"
    done
}

# Função para mostrar status atual
show_status() {
    echo "=== AUTH SERVICE STATUS ==="
    curl -k -s "$SERVICE_URL/health" | jq '.'
    echo ""
    echo "=== SECURITY STATS ==="
    curl -k -s "$SERVICE_URL/security/stats" | jq '.'
    echo ""
    echo "=== RECENT EVENTS ==="
    curl -k -s "$SERVICE_URL/security/events?limit=5" | jq '.events[]'
}

# Função para mostrar ajuda
show_help() {
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  once       - Run monitoring check once"
    echo "  continuous - Run continuous monitoring"
    echo "  status     - Show current service status"
    echo "  help       - Show this help message"
    echo ""
    echo "Configuration (defaults do .env, sobrescreva com vars de ambiente):"
    echo "  SERVICE_URL: $SERVICE_URL"
    echo "  ALERT_EMAIL: $ALERT_EMAIL"
    echo "  LOG_FILE: $LOG_FILE"
    echo "  CHECK_INTERVAL: ${CHECK_INTERVAL}s"
}

# Verificar dependências
check_dependencies_script() {
    if ! command -v curl &> /dev/null; then
        error "curl is required but not installed"
        exit 1
    fi
    
    if ! command -v jq &> /dev/null; then
        warning "jq is recommended for JSON parsing"
    fi
}

# Main
case "${1:-once}" in
    "once")
        check_dependencies_script
        run_once
        ;;
    "continuous")
        check_dependencies_script
        run_continuous
        ;;
    "status")
        show_status
        ;;
    "help")
        show_help
        ;;
    *)
        echo "Unknown option: $1"
        show_help
        exit 1
        ;;
esac
