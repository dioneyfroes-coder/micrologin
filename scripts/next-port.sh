#!/bin/bash

# ======================================
# next-port.sh — acha a próxima porta livre no host
# ======================================
# O .env é a fonte da verdade das portas do Docker Compose. Se uma porta
# estiver em uso, soma-se +1 até achar a próxima livre e imprime o resultado.
#
# Uso:
#   scripts/next-port.sh 3000 27017 6379       # imprime a próxima porta livre >= cada desejada
#   scripts/next-port.sh --env [/caminho/.env] # resolve APP_PORT/DEBUG_PORT/MONGO_PORT/REDIS_PORT
#                                               # do .env e imprime KEY=valor (lido e ajustado)
#   scripts/next-port.sh --help                # esta ajuda
#
# Exemplo: APP_PORT=3000 ocupada -> imprime APP_PORT=3001.

set -euo pipefail

readonly DEFAULTS="APP_PORT=3000
DEBUG_PORT=9229
MONGO_PORT=27017
REDIS_PORT=6379"

# Verifica se a porta está escutando (TCP) no host.
port_in_use() {
    local port="$1"
    [ -n "$(ss -ltnH 2>/dev/null | awk -v p="$port" '$4 ~ ":" p "$" {print}')" ]
}

# Soma +1 até achar uma porta livre (máx. 65535).
next_free() {
    local p="$1"
    while port_in_use "$p" && [ "$p" -lt 65535 ]; do
        p=$((p + 1))
    done
    echo "$p"
}

env_default() {
    local key="$1" file="${2:-.env}" value=""
    if [ -f "$file" ]; then
        value="$(grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    fi
    if [ -z "$value" ]; then
        value="$(grep -E "^${key}=" <<<"$DEFAULTS" | cut -d= -f2-)"
    fi
    echo "$value"
}

resolve_env() {
    local file="${1:-.env}" key val
    for key in APP_PORT DEBUG_PORT MONGO_PORT REDIS_PORT; do
        val="$(env_default "$key" "$file")"
        echo "${key}=$(next_free "$val")"
    done
}

case "${1:-}" in
    --help|-h)
        sed -n '2,14p' "$0"
        ;;
    --env)
        resolve_env "${2:-.env}"
        ;;
    *)
        for p in "$@"; do
            next_free "$p"
        done
        ;;
esac