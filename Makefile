# ======================================
# Makefile - Authentication Service
# ======================================

.PHONY: help install setup dev dev-watch stop logs build build-docker build-docker-prod \
 test test-unit test-integration test-coverage test-watch lint lint-fix typecheck audit \
 deploy-local deploy-staging deploy-prod docker-up docker-down docker-rebuild docker-logs docker-clean \
 health metrics docs shell redis-cli mongo-shell pre-commit status watch reset clean

# Porta pública do app: lida de .env (fonte da verdade); default 3000.
APP_PORT:=$(shell grep -E '^APP_PORT=[0-9]+' .env 2>/dev/null | cut -d= -f2-)
ifeq ($(strip $(APP_PORT)),)
APP_PORT:=3000
endif

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

setup: ## Criar .env a partir do .env.example (mantém o existente)
	@if [ -f .env ]; then echo ".env já existe"; else cp .env.example .env; echo ".env criado de .env.example"; fi

dev: ## Iniciar em modo desenvolvimento (tsx watch)
	npm run dev

dev-watch: ## Iniciar com hot reload (alias de dev)
	npm run dev

stop: ## Parar aplicação (PM2)
	npm run stop

logs: ## Ver logs da aplicação (PM2)
	npm run logs

# ======================================
# TESTES
# ======================================

test: ## Executar todos os testes
	npm test

test-unit: ## Executar testes unitários
	npm run test:unit:fast

test-integration: ## Executar testes de integração
	npm run test:integration:app

test-coverage: ## Gerar relatório de cobertura
	npm run test:coverage:fast

test-watch: ## Executar testes em modo watch
	npm run test:watch

# ======================================
# QUALIDADE DE CÓDIGO
# ======================================

lint: ## Verificar qualidade do código
	npm run lint

lint-fix: ## Corrigir problemas de lint
	npm run lint:fix

typecheck: ## Verificação de tipos (tsc)
	npm run typecheck

audit: ## Auditoria de dependências (npm audit)
	npm run audit

pre-commit: ## Verificações pré-commit
	npm run lint
	npm run typecheck
	npm test

# ======================================
# BUILD E DEPLOY
# ======================================

build: ## Build da aplicação (tsc -> dist/)
	npm run build

build-docker: ## Build da imagem Docker (produção = último stage)
	docker build -t $(DOCKER_IMAGE_NAME):$(DOCKER_TAG) .

build-docker-prod: ## Build da imagem Docker para produção (idem, tag :prod)
	docker build -f Dockerfile -t $(DOCKER_IMAGE_NAME):prod .

deploy-local: ## Deploy local com Docker (resolve portas via .env + next-port.sh)
	@bash scripts/local-deploy.sh

deploy-staging: ## Deploy para staging (usando compose dev)
	@bash scripts/deploy.sh staging

deploy-prod: ## Deploy para produção (usando .env.prod)
	@bash scripts/deploy.sh production

# ======================================
# DOCKER
# ======================================

docker-up: ## Subir serviços Docker
	docker compose up -d

docker-down: ## Parar serviços Docker
	docker compose down

docker-rebuild: ## Rebuild completo dos containers
	docker compose up -d --build

docker-logs: ## Ver logs dos containers
	docker compose logs -f

docker-clean: ## Limpar containers e volumes
	docker compose down -v
	docker system prune -f

# ======================================
# UTILITÁRIOS
# ======================================

health: ## Verificar saúde da aplicação (porta do .env)
	curl -fsS "http://localhost:$(APP_PORT)/health"

metrics: ## Ver métricas da aplicação (porta do .env)
	curl -s "http://localhost:$(APP_PORT)/metrics"

docs: ## Abrir documentação da API
	@echo "Documentação disponível em: http://localhost:$(APP_PORT)/api-docs"

status: ## Status dos serviços + endpoints
	@echo "Verificando status dos serviços..."
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@echo "Testando endpoints (porta .env):"
	@curl -s "http://localhost:$(APP_PORT)/health" | jq . 2>/dev/null || echo "Aplicação não está respondendo"

shell: ## Acessar shell do container da aplicação
	docker compose exec auth-service sh

redis-cli: ## Acessar Redis CLI
	docker compose exec redis redis-cli

mongo-shell: ## Acessar MongoDB shell
	docker compose exec mongodb mongosh

watch: ## Monitorar aplicação em tempo real
	watch -n 1 'make status'

# ======================================
# CI
# ======================================

ci-test: ## Pipeline de testes para CI
	@make pre-commit

ci-build: ## Pipeline de build para CI
	npm run typecheck
	npm run build

# ======================================
# LIMPEZA
# ======================================

clean: ## Limpeza geral
	rm -rf node_modules
	rm -rf coverage
	rm -rf dist
	rm -rf logs/*
	docker system prune -f

reset: ## Reset completo do ambiente
	make clean
	make install
	make setup