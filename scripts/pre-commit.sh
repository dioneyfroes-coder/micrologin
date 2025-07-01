#!/bin/bash

# ======================================
# Script de Validação Pré-Commit
# ======================================

echo "🔍 Executando validações pré-commit..."

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para exibir status
print_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
    else
        echo -e "${RED}❌ $2${NC}"
        exit 1
    fi
}

# 1. Verificar se há arquivos staged
if [ -z "$(git diff --cached --name-only)" ]; then
    echo -e "${YELLOW}⚠️  Nenhum arquivo staged para commit${NC}"
    exit 1
fi

# 2. Executar ESLint
echo "🎨 Executando ESLint..."
npm run lint:check 2>/dev/null
if [ $? -ne 0 ]; then
    npx eslint src/ tests/ --ext .js --format compact
fi
print_status $? "ESLint check"

# 3. Executar testes unitários rápidos
echo "🧪 Executando testes unitários..."
npm run test:unit:fast
print_status $? "Testes unitários"

# 4. Verificar vulnerabilidades
echo "🔒 Verificando vulnerabilidades..."
npm audit --audit-level high
print_status $? "Auditoria de segurança"

# 5. Verificar formato de código (se Prettier estiver configurado)
if command -v prettier >/dev/null 2>&1; then
    echo "💅 Verificando formato de código..."
    npx prettier --check src/ tests/
    print_status $? "Formato de código"
fi

# 6. Verificar tamanho do bundle (opcional)
echo "📦 Analisando tamanho do projeto..."
du -sh . | head -1

echo -e "${GREEN}🎉 Todas as validações passaram! Pronto para commit.${NC}"
