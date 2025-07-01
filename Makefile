# ======================================
# Makefile - Authentication Service
# ======================================

.PHONY: help install test build deploy clean docker lint security

# Variáveis
NODE_ENV ?= development
DOCKER_IMAGE_NAME ?= auth-service
DOCKER_TAG ?= latest

# Comando padrão
help: ## Exibir ajuda
	@echo "Authentication Service - Comandos Disponíveis:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ======================================
# DESENVOLVIMENTO
# ======================================

install: ## Instalar dependências
	npm ci

setup: ## Configurar ambiente de desenvolvimento
	@bash scripts/setup-env.sh

dev: ## Iniciar em modo desenvolvimento
	npm run dev:direct

dev-watch: ## Iniciar com hot reload
	npm run dev

stop: ## Parar aplicação
	npm run stop

logs: ## Ver logs da aplicação
	npm run logs

# ======================================
# TESTES
# ======================================

test: ## Executar todos os testes
	npm run test

test-unit: ## Executar testes unitários
	npm run test:unit:fast

test-integration: ## Executar testes de integração
	npm run test:integration:app

test-coverage: ## Gerar relatório de cobertura
	npm run test:coverage:fast

test-watch: ## Executar testes em modo watch
	npm run test:watch

test-performance: ## Executar testes de performance
	@bash scripts/performance-test.sh

# ======================================
# QUALIDADE DE CÓDIGO
# ======================================

lint: ## Verificar qualidade do código
	npm run lint:check

lint-fix: ## Corrigir problemas de lint
	npm run lint:fix

security: ## Auditoria de segurança
	npm run security:audit

security-fix: ## Corrigir vulnerabilidades
	npm run security:fix

# ======================================
# BUILD E DEPLOY
# ======================================

build: ## Build da aplicação
	npm run build

build-docker: ## Build da imagem Docker
	docker build -t $(DOCKER_IMAGE_NAME):$(DOCKER_TAG) .

build-docker-prod: ## Build da imagem Docker para produção
	docker build -f Dockerfile -t $(DOCKER_IMAGE_NAME):prod .

deploy-local: ## Deploy local com Docker
	@bash scripts/local-deploy.sh

deploy-staging: ## Deploy para staging
	npm run deploy:staging

deploy-prod: ## Deploy para produção
	npm run deploy:prod

# ======================================
# DOCKER
# ======================================

docker-up: ## Subir serviços Docker
	docker-compose up -d

docker-down: ## Parar serviços Docker
	docker-compose down

docker-rebuild: ## Rebuild completo dos containers
	npm run docker:rebuild

docker-logs: ## Ver logs dos containers
	docker-compose logs -f

docker-clean: ## Limpar containers e volumes
	docker-compose down -v
	docker system prune -f

# ======================================
# UTILITÁRIOS
# ======================================

backup: ## Criar backup
	@bash scripts/backup-restore.sh backup

restore: ## Restaurar backup (uso: make restore BACKUP=filename)
	@bash scripts/backup-restore.sh restore $(BACKUP)

clean: ## Limpeza geral
	rm -rf node_modules
	rm -rf coverage
	rm -rf logs/*
	docker system prune -f

reset: ## Reset completo do ambiente
	make clean
	make install
	make setup

health: ## Verificar saúde da aplicação
	curl -k https://localhost:3000/health

pre-commit: ## Executar verificações pré-commit
	@bash scripts/pre-commit.sh

# ======================================
# CI/CD
# ======================================

ci-test: ## Pipeline de testes para CI
	npm run ci:test

ci-build: ## Pipeline de build para CI
	npm run ci:build

ci-deploy: ## Pipeline completo de CI/CD
	npm run ci:deploy

# ======================================
# MONITORAMENTO
# ======================================

metrics: ## Ver métricas da aplicação
	curl -k https://localhost:3000/metrics

docs: ## Abrir documentação da API
	@echo "Documentação disponível em: https://localhost:3000/api-docs"

status: ## Status dos serviços
	@echo "Verificando status dos serviços..."
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@echo "Testando endpoints:"
	@curl -k -s https://localhost:3000/health | jq . 2>/dev/null || echo "Aplicação não está respondendo"

# ======================================
# DESENVOLVIMENTO AVANÇADO
# ======================================

shell: ## Acessar shell do container da aplicação
	docker-compose exec app sh

redis-cli: ## Acessar Redis CLI
	docker-compose exec redis redis-cli

mongo-shell: ## Acessar MongoDB shell
	docker-compose exec mongodb mongosh

load-test: ## Executar teste de carga
	npm run test:load

watch: ## Monitorar aplicação em tempo real
	watch -n 1 'make status'
