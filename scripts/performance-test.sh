#!/bin/bash

# ======================================
# Script de Teste de Performance Local
# ======================================

echo "🏃‍♂️ Iniciando testes de performance..."

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configurações
BASE_URL="https://localhost:3000"
OUTPUT_DIR="./performance-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Criar diretório de resultados
mkdir -p $OUTPUT_DIR

echo "📊 Configuração do teste:"
echo "  - URL Base: $BASE_URL"
echo "  - Diretório de saída: $OUTPUT_DIR"
echo "  - Timestamp: $TIMESTAMP"
echo ""

# Verificar se a aplicação está rodando
echo "🔍 Verificando se a aplicação está rodando..."
if ! curl -k -s $BASE_URL/health >/dev/null; then
    echo -e "${RED}❌ Aplicação não está respondendo em $BASE_URL${NC}"
    echo "Inicie a aplicação primeiro com: npm start ou docker-compose up"
    exit 1
fi
echo -e "${GREEN}✅ Aplicação está rodando${NC}"

# Função para executar teste com curl
run_curl_test() {
    local endpoint=$1
    local name=$2
    local requests=${3:-100}
    local concurrent=${4:-10}
    
    echo "🧪 Testando $name ($requests requests, $concurrent concurrent)..."
    
    # Arquivo temporário para resultados
    local temp_file="$OUTPUT_DIR/curl_${name}_${TIMESTAMP}.txt"
    
    # Executar teste
    seq 1 $requests | xargs -I {} -P $concurrent curl -k -s -w "%{http_code},%{time_total},%{time_connect},%{time_starttransfer}\n" -o /dev/null $BASE_URL$endpoint > $temp_file
    
    # Analisar resultados
    local total_requests=$(wc -l < $temp_file)
    local success_requests=$(grep "^200" $temp_file | wc -l)
    local avg_time=$(awk -F, '{sum+=$2} END {print sum/NR}' $temp_file)
    local max_time=$(awk -F, '{if($2>max) max=$2} END {print max}' $temp_file)
    local min_time=$(awk -F, '{if(NR==1 || $2<min) min=$2} END {print min}' $temp_file)
    
    echo "  📈 Resultados para $name:"
    echo "    - Total de requests: $total_requests"
    echo "    - Requests bem-sucedidas: $success_requests"
    echo "    - Taxa de sucesso: $(( success_requests * 100 / total_requests ))%"
    echo "    - Tempo médio: ${avg_time}s"
    echo "    - Tempo mínimo: ${min_time}s"
    echo "    - Tempo máximo: ${max_time}s"
    echo ""
}

# Função para executar teste com Apache Bench (se disponível)
run_ab_test() {
    local endpoint=$1
    local name=$2
    local requests=${3:-1000}
    local concurrent=${4:-50}
    
    if command -v ab >/dev/null 2>&1; then
        echo "🚀 Testando $name com Apache Bench ($requests requests, $concurrent concurrent)..."
        ab -n $requests -c $concurrent -k -r $BASE_URL$endpoint > "$OUTPUT_DIR/ab_${name}_${TIMESTAMP}.txt" 2>&1
        
        # Extrair métricas principais
        local success_rate=$(grep "Complete requests:" "$OUTPUT_DIR/ab_${name}_${TIMESTAMP}.txt" | awk '{print $3}')
        local rps=$(grep "Requests per second:" "$OUTPUT_DIR/ab_${name}_${TIMESTAMP}.txt" | awk '{print $4}')
        local avg_time=$(grep "Time per request:" "$OUTPUT_DIR/ab_${name}_${TIMESTAMP}.txt" | head -1 | awk '{print $4}')
        
        echo "  🎯 Resultados Apache Bench para $name:"
        echo "    - Requests completadas: $success_rate"
        echo "    - Requests por segundo: $rps"
        echo "    - Tempo médio por request: ${avg_time}ms"
        echo ""
    fi
}

# Função para teste de carga com K6 (se disponível)
run_k6_test() {
    if command -v k6 >/dev/null 2>&1 && [ -f "tests/load/k6-load-test.js" ]; then
        echo "🎪 Executando teste de carga com K6..."
        k6 run tests/load/k6-load-test.js --out json="$OUTPUT_DIR/k6_results_${TIMESTAMP}.json"
        echo ""
    fi
}

# Executar testes básicos de saúde
echo "🏥 Teste básico de health check..."
run_curl_test "/health" "health_check" 50 5

# Teste de endpoints de autenticação
echo "🔐 Teste de endpoints de autenticação..."
run_curl_test "/api-docs" "swagger_docs" 30 3

# Teste com Apache Bench se disponível
run_ab_test "/health" "health_check_ab" 500 25

# Teste com K6 se disponível
run_k6_test

# Teste de memória e CPU durante execução
echo "💻 Coletando métricas do sistema..."
if command -v docker >/dev/null 2>&1; then
    docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" > "$OUTPUT_DIR/docker_stats_${TIMESTAMP}.txt"
    echo "  📊 Estatísticas do Docker salvas em docker_stats_${TIMESTAMP}.txt"
fi

# Teste de endpoint de métricas
echo "📊 Coletando métricas da aplicação..."
curl -k -s $BASE_URL/metrics > "$OUTPUT_DIR/app_metrics_${TIMESTAMP}.txt"
echo "  📈 Métricas da aplicação salvas em app_metrics_${TIMESTAMP}.txt"

# Relatório final
echo ""
echo "🎉 Testes de performance concluídos!"
echo ""
echo "📁 Resultados salvos em: $OUTPUT_DIR"
echo "📋 Arquivos gerados:"
ls -la $OUTPUT_DIR/*${TIMESTAMP}* | awk '{print "  - " $9}'
echo ""
echo "💡 Dicas:"
echo "  - Compare os resultados com execuções anteriores"
echo "  - Monitore o uso de CPU e memória durante picos de carga"
echo "  - Considere otimizações se o tempo de resposta for > 200ms"
echo "  - Verifique logs de erro se a taxa de sucesso for < 99%"
