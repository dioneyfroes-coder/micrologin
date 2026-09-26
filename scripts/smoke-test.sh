#!/usr/bin/env bash

# ====================================
# SMOKE TEST FUNCIONAL - Authentication Microservice
# ====================================
#
# Não é um "curl /health e pronto". O objetivo é provar que a versão recém
# implantada serve tráfego de verdade: registro, login, perfil, rotação de
# refresh, rejeição de reuso e logout. Um health check 200 numa instância que
# não consegue autenticar ninguém é um deploy verde e inútil.
#
# Uso:
#   scripts/smoke-test.sh [BASE_URL]
#
#   BASE_URL   base pública do serviço (default: http://localhost:${APP_PORT:-3000})
#
# Requisitos: curl e python3 (para extrair JSON sem depender de jq).
#
# Códigos de saída:
#   0  todos os passos passaram - a versão serve tráfego
#   1  falha real (a versão não autentica) - o deploy deve reverter
#   2  inconclusivo (rate limit bloqueou a tentativa) - o deploy não reverte,
#      mas o pipeline fica vermelho para alguém olhar
#
# O caso 2 existe porque o smoke test é disparado do CI, e o egress do runner
# compartilha IP com o tráfego real: em produção o limite de login é de poucas
# tentativas por minuto. Um 429 é o serviço se comportando corretamente, não um
# defeito da versão - reverter um deploy bom por causa disso seria transformar
# um problema de capacidade em uma indisponibilidade.

set -euo pipefail

BASE_URL="${1:-http://localhost:${APP_PORT:-3000}}"
BASE_URL="${BASE_URL%/}"

# Quantas vezes insistir quando o rate limit responde, e quanto esperar.
SMOKE_429_RETRIES="${SMOKE_429_RETRIES:-3}"
SMOKE_429_WAIT="${SMOKE_429_WAIT:-20}"
SMOKE_429_MAX_WAIT="${SMOKE_429_MAX_WAIT:-60}"

RED='\033[0.31m'
GREEN='\033[0.32m'
BLUE='\033[0.34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_error()   { echo -e "${RED}❌ $1${NC}"; }

fail() {
    log_error "$1"
    exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail "python3 não encontrado no host (necessário para ler o JSON)."

# Executa uma requisição e grava corpo em $BODY e status em $STATUS.
# Não usa `curl -f`: queremos o corpo mesmo em erro, para a mensagem de falha.
BODY=""
STATUS=""

request() {
    local method="$1" path="$2" body="${3:-}" auth="${4:-}"
    local args=(-sS -o /tmp/smoke-body.$$ -w '%{http_code}' -X "$method" "${BASE_URL}${path}")

    [ -n "$auth" ] && args+=(-H "Authorization: Bearer ${auth}")
    if [ -n "$body" ]; then
        args+=(-H 'Content-Type: application/json' --data "$body")
    fi

    STATUS=$(curl "${args[@]}" || echo "000")
    BODY=$(cat /tmp/smoke-body.$$ 2>/dev/null || true)
    rm -f /tmp/smoke-body.$$
}

# Extrai um campo de topo do JSON resposta.
json_field() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
value = data
for key in sys.argv[1].split("."):
    if not isinstance(value, dict) or key not in value:
        sys.exit(1)
    value = value[key]
print(value if value is not None else "")
' "$2" 2>/dev/null
}

expect_status() {
    local expected="$1" step="$2"
    if [ "$STATUS" != "$expected" ]; then
        fail "${step}: esperado HTTP ${expected}, recebeu ${STATUS}. Corpo: ${BODY:0:400}"
    fi
}

# Se a resposta foi 429, extrai o retryAfter (segundos) do corpo.
retry_after() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    print(int(json.load(sys.stdin).get("details", {}).get("retryAfter", 0)))
except Exception:
    print(0)
' 2>/dev/null || echo 0
}

# Repete a requisição enquanto for rate limit e o tempo de espera for aceitável.
# Ao esgotar, sai com 2 (inconclusivo) em vez de 1 (falha da versão).
retry_on_rate_limit() {
    local attempt=1 wait_seconds

    while [ "$STATUS" = "429" ] && [ "$attempt" -le "$SMOKE_429_RETRIES" ]; do
        wait_seconds=$(retry_after "$BODY")
        [ "$wait_seconds" -gt 0 ] || wait_seconds="$SMOKE_429_WAIT"

        if [ "$wait_seconds" -gt "$SMOKE_429_MAX_WAIT" ]; then
            log_error "Rate limit ativo com retryAfter=${wait_seconds}s (acima de SMOKE_429_MAX_WAIT=${SMOKE_429_MAX_WAIT}s)."
            log_error "Inconclusivo: o deploy não pode ser julgado por limite de capacidade."
            exit 2
        fi

        log_info "Rate limit (429); aguardando ${wait_seconds}s (tentativa ${attempt}/${SMOKE_429_RETRIES})..."
        sleep "$wait_seconds"
        attempt=$((attempt + 1))
        "$@"
    done
}

# Usuário único por execução: smoke test repetido não pode colidir com o
# registro da execução anterior (e o username é a identidade da conta).
RUN_ID="$(date +%s)-$$"
USERNAME="smoke-${RUN_ID}"
PASSWORD="Sm0ke-Test-${RUN_ID}-Aa!"

log_info "Base URL: ${BASE_URL}"
log_info "Usuário de teste: ${USERNAME}"

cleanup() {
    if [ -n "${ACCESS_TOKEN:-}" ]; then
        request DELETE "/delete" "" "$ACCESS_TOKEN" || true
    fi
}
trap cleanup EXIT

# 1. Liveness: o processo responde?
log_info "[1/8] liveness"
request GET "/liveness"
expect_status 200 "liveness"
[ "$(json_field "$BODY" status)" = "alive" ] || fail "liveness sem status 'alive': ${BODY:0:200}"
log_success "liveness OK"

# 2. Readiness: com dependência de pé?
log_info "[2/8] readiness"
request GET "/readiness"
expect_status 200 "readiness"
[ "$(json_field "$BODY" ready)" = "True" ] || fail "readiness sem ready=true: ${BODY:0:300}"
log_success "readiness OK"

# 3. Registro (a API recebe o campo `user`; a resposta traz data.user.username)
log_info "[3/8] registro"
request POST "/register" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
retry_on_rate_limit request POST "/register" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 201 "registro"
log_success "registro OK"

# 4. Login devolve o par de tokens
log_info "[4/8] login"
request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
retry_on_rate_limit request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 "login"
ACCESS_TOKEN=$(json_field "$BODY" data.accessToken)
REFRESH_TOKEN=$(json_field "$BODY" data.refreshToken)
[ -n "$ACCESS_TOKEN" ] || fail "login sem data.accessToken: ${BODY:0:300}"
[ -n "$REFRESH_TOKEN" ] || fail "login sem data.refreshToken: ${BODY:0:300}"
log_success "login OK (par de tokens emitido)"

# 5. Perfil autenticado
log_info "[5/8] profile autenticado"
request GET "/profile" "" "$ACCESS_TOKEN"
expect_status 200 "profile"
[ "$(json_field "$BODY" data.user.username)" = "$USERNAME" ] \
    || fail "profile com username inesperado: ${BODY:0:300}"
log_success "profile OK"

# 6. Rotação de refresh
log_info "[6/8] rotação de refresh"
request POST "/refresh" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}"
expect_status 200 "refresh"
NEW_ACCESS=$(json_field "$BODY" data.accessToken)
NEW_REFRESH=$(json_field "$BODY" data.refreshToken)
[ -n "$NEW_ACCESS" ] || fail "refresh sem novo accessToken: ${BODY:0:300}"
[ -n "$NEW_REFRESH" ] || fail "refresh sem novo refreshToken: ${BODY:0:300}"
[ "$NEW_REFRESH" != "$REFRESH_TOKEN" ] || fail "refresh devolveu o mesmo refreshToken (rotação não ocorreu)"
log_success "refresh OK (token rotacionado)"

# 7. Reuso do refresh antigo é recusado: é o que a blacklist por jti garante
log_info "[7/8] reuso de refresh antigo é rejeitado"
request POST "/refresh" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}"
expect_status 401 "reuso de refresh"
log_success "reuso rejeitado OK"

# 8. Logout encerra a sessão
#
# O access token é enviado no header: o endpoint só consegue revogar o access
# token apresentado, e revogar os tokens do usuário depende de `req.user`, que
# vem do access token autenticado. Um logout só com refresh token deixa o
# access token vivo até expirar (achado registrado no roadmap, Fase 8).
log_info "[8/8] logout"
request POST "/logout" "{\"refreshToken\":\"${NEW_REFRESH}\"}" "$NEW_ACCESS"
expect_status 200 "logout"

# Access token revogado não pode mais abrir /profile
request GET "/profile" "" "$NEW_ACCESS"
[ "$STATUS" = "401" ] || fail "access token ainda válido após logout (HTTP ${STATUS})"

# E o refresh token revogado também não renova
request POST "/refresh" "{\"refreshToken\":\"${NEW_REFRESH}\"}"
[ "$STATUS" = "401" ] || fail "refresh token ainda válido após logout (HTTP ${STATUS})"
log_success "logout OK (sessão encerrada: access e refresh rejeitados)"

log_success "🎉 Smoke test passou: a versão implantada autentica de verdade."
