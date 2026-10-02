#!/usr/bin/env bash

# ====================================
# DRILL DE PERSISTÊNCIA DO REDIS (Fase 2.2)
# Authentication Microservice
# ====================================
#
# A falha que esta fase fecha é silenciosa. Com o Redis sem persistência, um
# restart de container apaga a blacklist de revogação, a versão de sessão e o
# carimbo `user_tokens_revoked` — e os tokens revogados voltam a valer, sem
# erro, sem log, sem 5xx. O fail-closed (`SESSION_FAIL_OPEN`) não cobre esse
# caso: ele trata o Redis fora do ar, não o Redis de pé com memória vazia.
#
# O drill exercita o caminho inteiro contra um Redis autenticado de verdade:
#
#   1. registra dois usuários e autentica os dois (A vai ser revogado, B não);
#   2. revoga a sessão de A por /logout e prova que o token de A morreu (401);
#   3. confere a configuração de persistência pelo próprio redis-cli
#      (appendonly, appendfsync, save) e que o AOF existe no volume;
#   4. reinicia o container do Redis (o mesmo volume, processo novo);
#   5. repete o login de B: tem que continuar 200.
#   6. repete o uso do token de A: tem que continuar 401.
#
# O passo 5 é o que dá sentido ao 6. Sem o controle, "401 depois do restart"
# seria ambíguo: daria para o fail-closed estar barrando tudo por indisponibilidade
# e o teste passaria por acidente. B sendo 200 prova que o Redis voltou, está
# autenticado e está validando tokens de verdade — então o 401 de A só pode ser
# a blacklist que voltou do disco.
#
# Também mede o tempo entre derrubar o container e ele voltar a responder
# (o RTO do Redis, que é o número que vai para docs/REDIS.md).
#
# O drill tem dois modos, porque "a persistência funciona" e "a revogação
# sobrevive a perder o dado" são perguntas diferentes com respostas diferentes:
#
#   padrão (--restart)  o container reinicia, o volume fica. A revogação tem
#                       que sobreviver. É o que a D22 comprou.
#   --volume-loss       o volume do Redis é DESTRUIDO. O Mongo fica intacto de
#                       propósito: se os usuários sumissem junto, um 401 do
#                       token de A seria ambíguo (usuário inexistente ou
#                       revogação perdida?). Com o banco de pé, um 200 do token
#                       de A só pode significar que o registro de revogação foi
#                       junto com o volume. É a D20: o limite aceito, medido.
#
# Uso:
#   scripts/test-redis-persistence.sh [--keep] [--skip-build] [--volume-loss]
#
#   --keep         não destrói o stack no fim (para depurar com docker logs)
#   --skip-build   usa a imagem já construída em vez de reconstruir
#   --volume-loss  destrói o volume do Redis e mede a exposição resultante, em
#                  vez de provar que a revogação sobreviveu ao restart
#
# Códigos de saída:
#   0  o modo terminou como se espera: no padrão, revogação sobreviveu ao
#      restart; em --volume-loss, o limite aceito está presente e medido
#   1  alguma asserção falhou
#   2  pré-requisito ausente (docker parado, curl/python3 faltando)
#
# Atenção ao ler o resultado de --volume-loss: um drill verde aqui significa
# "o buraco continua existindo", não "o sistema está bem". Se um dia esse drill
# reprovar porque a revogação passou a sobreviver à perda de volume, é sinal
# bom: a D20 foi fechada e a documentação precisa acompanhar.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

PROJECT="micrologin-redis"
COMPOSE_FILE="docker-compose.redis.yml"
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

KEEP_STACK=0
SKIP_BUILD=0
VOLUME_LOSS=0
for arg in "$@"; do
    case "$arg" in
        --keep)       KEEP_STACK=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        --volume-loss) VOLUME_LOSS=1 ;;
        *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

if [ "$VOLUME_LOSS" -eq 1 ]; then
    EVENTO="perda de volume"
    DEPOIS="da perda de volume"
    ESPERADO="o limite aceito da D20 estar presente e medido"
else
    EVENTO="restart"
    DEPOIS="do restart"
    ESPERADO="a revogação ter sobrevivido ao restart"
fi

WAIT_READY_TIMEOUT="${WAIT_READY_TIMEOUT:-180}"

REDIS_TEST_PORT="${REDIS_TEST_PORT:-3301}"
BASE_URL="http://localhost:${REDIS_TEST_PORT}"
export REDIS_TEST_PORT

REDIS_TEST_KEYS_DIR="${REDIS_TEST_KEYS_DIR:-${ROOT_DIR}/.redis-keys}"
REDIS_TEST_DEPS_DIR="${REDIS_TEST_DEPS_DIR:-${ROOT_DIR}/.redis-deps}"
REDIS_TEST_KID="${REDIS_TEST_KID:-redis-v1}"
export REDIS_TEST_KEYS_DIR REDIS_TEST_DEPS_DIR REDIS_TEST_KID

RUN_ID="$(date +%s)-$$"
# A será revogado; B é o controle que nunca é revogado. Os nomes ficam curtos
# de propósito: a política de usuário recusa acima de 30 caracteres, e o drill
# não quer falhar por um 400 de validação em vez de por o que está testando.
USER_A="rd-rev-${RUN_ID}"
USER_B="rd-ctl-${RUN_ID}"
PASSWORD="R3dis-Test-${RUN_ID}-Xx!"

BODY_FILE="$(mktemp)"

REDIS_CONTAINER="micrologin-redis-redis"
REDIS_CONTAINER_APP="micrologin-redis-app"

RED='\033[0.31m'; GREEN='\033[0.32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}"; exit 1; }
fail_usage(){ echo -e "${RED}❌ $1${NC}" >&2; exit 2; }

cleanup() {
    rm -f "$BODY_FILE"
    if [ "$KEEP_STACK" -eq 1 ]; then
        log_warn "Stack mantido (--keep). Remova com:"
        echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v"
        echo "  rm -rf ${REDIS_TEST_KEYS_DIR} ${REDIS_TEST_DEPS_DIR}"
        return
    fi
    log_info "Destruindo o stack de teste e o material efêmero..."
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$REDIS_TEST_KEYS_DIR" "$REDIS_TEST_DEPS_DIR"
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || fail_usage "Docker não está rodando."
command -v curl >/dev/null 2>&1 || fail_usage "curl não encontrado no host."
command -v python3 >/dev/null 2>&1 || fail_usage "python3 não encontrado no host."

STATUS=""
BODY=""
request() {
    local method="$1" path="$2" payload="${3:-}" token="${4:-}"
    local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}")
    [ -n "$payload" ] && args+=(-H 'Content-Type: application/json' --data "$payload")
    [ -n "$token" ] && args+=(-H "Authorization: Bearer ${token}")
    STATUS=$(curl --max-time 15 "${args[@]}" 2>/dev/null || echo "000")
    BODY=$(cat "$BODY_FILE" 2>/dev/null || true)
}

json_field() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
value = data
for key in sys.argv[1].split("."):
    if not isinstance(value, dict) or key not in value:
        sys.exit(0)
    value = value[key]
print(value if value is not None else "")
' "$2" 2>/dev/null || true
}

wait_for() {
    local timeout="$1" what="$2"
    shift 2
    local deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    fail "esperou ${timeout}s por: ${what}"
}

# Registra e autentica um usuário, deixando em globals o par de tokens e o id.
# Globais porque o Bash não tem passagem por referência e a prova do drill
# precisa do par inteiro e do dono (a chave de versão de sessão é por id).
LAST_ACCESS=""
LAST_REFRESH=""
LAST_USER_ID=""
register_and_login() {
    local user="$1"
    request POST "/register" "{\"user\":\"${user}\",\"password\":\"${PASSWORD}\"}"
    # /register responde 201 no sucesso (200 não é emitido pelo controller).
    [ "$STATUS" = "201" ] || fail "registro de ${user} falhou (HTTP ${STATUS})"
    request POST "/login" "{\"user\":\"${user}\",\"password\":\"${PASSWORD}\"}"
    [ "$STATUS" = "200" ] || fail "login de ${user} falhou (HTTP ${STATUS})"
    LAST_ACCESS="$(json_field "$BODY" data.accessToken)"
    LAST_REFRESH="$(json_field "$BODY" data.refreshToken)"
    LAST_USER_ID="$(json_field "$BODY" data.user.id)"
    [ -n "$LAST_ACCESS" ] || fail "login de ${user} não devolveu accessToken"
    [ -n "$LAST_REFRESH" ] || fail "login de ${user} não devolveu refreshToken"
}

# O estado de autenticação que precisa continuar idêntico depois do restart.
# As duas funções são predicados (retornam 0 quando a afirmação vale), porque
# `wait_for` as usa como sondas enquanto o app reconecta no Redis.
is_access_still_valid() {
    local token="$1"
    [ -n "$token" ] || return 1
    request GET "/profile" "" "$token"
    [ "$STATUS" = "200" ]
}

is_access_still_revoked() {
    local token="$1"
    [ -n "$token" ] || return 1
    request GET "/profile" "" "$token"
    [ "$STATUS" = "401" ]
}

redis_cli() {
    docker exec "$REDIS_CONTAINER" sh -c \
        'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" redis-cli --no-auth-warning --user auth-service "$@"' \
        sh "$@" 2>/dev/null | tr -d '\r'
}

# Arquivos dentro do container, sem passar pelo Redis e portanto sem depender
# de permissão de comando.
redis_file() { docker exec "$REDIS_CONTAINER" sh -c "$1" 2>/dev/null; }

# ============================================================
# 1. Stack de pé
# ============================================================
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE} Drill de persistência do Redis — modo: ${EVENTO}${NC}"
echo -e "${BLUE} Stack: ${PROJECT} @ ${BASE_URL}${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

log_info "Subindo o stack de teste (build da imagem de produção inclusa)"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "$REDIS_TEST_KEYS_DIR" "$REDIS_TEST_DEPS_DIR"
bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$REDIS_TEST_KEYS_DIR" "$REDIS_TEST_KID" --for-container >/dev/null
bash "${SCRIPT_DIR}/generate-dependency-secrets.sh" "$REDIS_TEST_DEPS_DIR" --for-container --skip-verify >/dev/null

if [ "$SKIP_BUILD" -eq 1 ]; then
    "${COMPOSE[@]}" up -d --no-build >/dev/null
else
    "${COMPOSE[@]}" build >/dev/null
    "${COMPOSE[@]}" up -d >/dev/null
fi

wait_for "$WAIT_READY_TIMEOUT" "readiness 200" bash -c "
    [ \"\$(curl -s -o /dev/null -w '%{http_code}' ${BASE_URL}/readiness)\" = '200' ]"
log_pass "stack no ar e pronto para tráfego"

# ============================================================
# 2. A persistência, conferida por fora do Redis
# ============================================================
# Não dá para perguntar ao servidor: a ACL da aplicação é `+@all -@admin
# -@dangerous`, e tanto `CONFIG GET` quanto `INFO` estão em @admin — as duas
# respondem NOPERM para o usuário que a aplicação usa (foi o que aconteceu na
# primeira versão deste drill). A conferência é então em duas frentes que não
# dependem de permissão nenhuma: o que existe no volume, e se o dado volta.
#
# O diretório `appendonlydir` só existe com o AOF ligado; sem `--appendonly
# yes` o /data fica vazio. E o arquivo `.incr.aof` crescendo depois de uma
# escrita prova que a escrita está indo para o AOF, não só que o diretório foi
# criado na largada.
DATA_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$REDIS_CONTAINER")"
[ "$DATA_MOUNT" = "volume" ] || fail "/data do Redis está montado como '${DATA_MOUNT:-nada}', esperado volume nomeado"
# `.Name` e não `.Source`: o Source é o caminho do mountpoint dentro do host
# (/var/lib/docker/volumes/<nome>/_data) e `docker volume rm` recusa esse caminho.
REDIS_VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$REDIS_CONTAINER")"
[ -n "$REDIS_VOLUME" ] || fail "não foi possível localizar o volume nomeado montado em /data (necessário para o modo --volume-loss)"
log_pass "/data em volume nomeado (o dado sobrevive ao container)"

[ -n "$(redis_file 'test -d /data/appendonlydir && echo yes')" ] \
    || fail "não existe /data/appendonlydir — o AOF não está ligado (appendonly yes)"
log_pass "/data/appendonlydir existe (AOF ligado)"

# ============================================================
# 3. Dois usuários, um revogável e um controle
# ============================================================
log_info "Registrando e autenticando os dois usuários..."
register_and_login "$USER_A"
ACCESS_A="$LAST_ACCESS"; REFRESH_A="$LAST_REFRESH"; USER_A_ID="$LAST_USER_ID"
register_and_login "$USER_B"
ACCESS_B="$LAST_ACCESS"

is_access_still_valid "$ACCESS_A" || fail "token de A não autentica logo após o login (HTTP ${STATUS})"
is_access_still_valid "$ACCESS_B" || fail "token de B não autentica logo após o login (HTTP ${STATUS})"
log_pass "A e B autenticam com /profile 200 (baseline antes de revogar)"

# ============================================================
# 4. Revogar A e provar que a revogação funciona antes do restart
# ============================================================
# /logout com o par apresentado derruba a sessão inteira: blacklista o par E
# incrementa a versão de sessão do usuário. É o caminho que um logout real usa,
# e ele escreve as chaves que o drill vai procurar no disco depois.
log_info "Revogando a sessão de A via /logout..."
request POST "/logout" "{\"refreshToken\":\"${REFRESH_A}\"}" "$ACCESS_A"
[ "$STATUS" = "200" ] || fail "/logout de A falhou (HTTP ${STATUS})"

is_access_still_revoked "$ACCESS_A" || fail "token de A continua 200 depois do logout (HTTP ${STATUS}) — a revogação não está valendo"
log_pass "token de A está revogado (401) antes do restart"

# Prova no nível dos dados, antes do restart: a versão de sessão de A tem de
# estar no Redis e valer ao menos 1 (0 = nenhum logout registrado; 1 = este
# logout). Sem conferir, um 401 poderia ser qualquer coisa menos revogação.
VERSION_KEY="user_session_version:${USER_A_ID}"
VERSION_BEFORE="$(redis_cli GET "$VERSION_KEY" | tr -d '\r')"
[ -n "$VERSION_BEFORE" ] || fail "chave ${VERSION_KEY} ausente antes do restart — o logout não chegou ao Redis"
[ "$VERSION_BEFORE" -ge 1 ] 2>/dev/null || fail "versão de sessão de A é '${VERSION_BEFORE}', esperado >= 1"
log_pass "chave ${VERSION_KEY} = ${VERSION_BEFORE} antes do restart (revogação gravada)"

DBSIZE_BEFORE="$(redis_cli DBSIZE | tr -d '\r')"
[ "${DBSIZE_BEFORE:-0}" -gt 0 ] 2>/dev/null || fail "Redis não tem nenhuma chave antes do restart (DBSIZE='${DBSIZE_BEFORE}')"
log_info "Redis com ${DBSIZE_BEFORE} chave(s) antes do restart"

# A escrita desta revogação tem que estar no AOF. `appendonlydir` existir prova
# que o AOF foi ligado; o `.incr.aof` ter grown prova que a gravação de verdade
# está acontecendo por ele — que é o que dá o RPO de ~1s do `everysec`.
sleep 2
AOF_BYTES="$(redis_file 'cat /data/appendonlydir/*.incr.aof 2>/dev/null | wc -c' | tr -d ' ')"
[ "${AOF_BYTES:-0}" -gt 0 ] 2>/dev/null || fail "AOF incremental vazio depois da revogação (${AOF_BYTES:-0} bytes) — a escrita não está indo para o AOF"
log_pass "escrita da revogação está no AOF (${AOF_BYTES} bytes em appendonly.aof.*.incr.aof)"

# ============================================================
# 5. Restart do container do Redis (mesmo volume, processo novo)
# ============================================================
if [ "$VOLUME_LOSS" -eq 1 ]; then
    # Só o volume do Redis. O `down -v` derrubaria também o volume do Mongo, e
    # aí o token de A poderia dar 401 só porque o usuário deixou de existir —
    # o teste mediria a coisa errada. Destruir o /data do Redis e nada mais é a
    #perda que a D20 descreve: o dado de revogação some, os usuários não.
    log_warn "Destruindo o volume do Redis (${REDIS_VOLUME}); o Mongo fica intacto..."
    EVENT_START_MS="$(date +%s%3N)"
    "${COMPOSE[@]}" stop redis >/dev/null
    "${COMPOSE[@]}" rm -f redis >/dev/null
    docker volume rm "$REDIS_VOLUME" >/dev/null
    "${COMPOSE[@]}" up -d redis >/dev/null
else
    log_warn "Reiniciando o container do Redis (o volume persiste; o processo não)..."
    # Em milissegundos: o restart de um container local leva menos de um segundo,
    # e "RTO 0s" é um número que não diz nada.
    EVENT_START_MS="$(date +%s%3N)"
    "${COMPOSE[@]}" restart redis >/dev/null
fi
wait_for "$WAIT_READY_TIMEOUT" "Redis responder de novo" redis_cli PING
RTO_MS="$(( $(date +%s%3N) - EVENT_START_MS ))"
RTO_SEC="$(awk -v ms="$RTO_MS" 'BEGIN{printf "%.1f", ms/1000}')"
log_pass "Redis de volta em ${RTO_SEC}s (PONG)"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE} Tempo de indisponibilidade do Redis (parou -> PONG): ${RTO_SEC}s${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"

# O app pode precisar de um instante para a reconexão do ioredis: o middleware
# de autenticação valida o token no mesmo instante da requisição.
wait_for 30 "app aceitar requisição autenticada de novo" is_access_still_valid "$ACCESS_B"

# ============================================================
# 6. O controle: B (nunca revogado) tem que continuar funcionando
# ============================================================
is_access_still_valid "$ACCESS_B" || fail "controle B virou ${STATUS} depois ${DEPOIS} — o Redis não voltou de verdade, então o teste de A não diria nada"
log_pass "controle B continua 200 depois ${DEPOIS} (Redis voltou e valida tokens)"

# ============================================================
# 7. O que acontece com A (revogado) — o modo decide o veredito
# ============================================================
VERSION_AFTER="$(redis_cli GET "$VERSION_KEY" | tr -d '\r')"
DBSIZE_AFTER="$(redis_cli DBSIZE | tr -d '\r')"

if [ "$VOLUME_LOSS" -eq 0 ]; then
    # A tem que continuar morto: é o que a persistência comprou.
    if is_access_still_valid "$ACCESS_A"; then
        log_warn "token de A voltou a valer (HTTP ${STATUS}) depois do restart"
        fail "REGRESSÃO: revogação não sobreviveu ao restart do Redis — ou o appendonly/save/volume foi desligado"
    fi
    # "Não é 200" não basta: um 5xx também seria "não 200", e o teste passaria
    # batendo numa falha do serviço em vez de numa blacklist. O 401 é o que
    # prova que a revogação foi consultada e foi negada.
    [ "$STATUS" = "401" ] || fail "token de A respondeu ${STATUS} depois do restart (esperado 401) — se é 5xx, isto é indisponibilidade, não revogação"
    log_pass "token de A continua revogado (401) depois do restart — a blacklist sobreviveu"

    # E o dado tem de ter voltado do disco, não veio do caminho do fail-closed:
    # a chave de sessão de A tem que continuar no Redis, com o MESMO valor.
    [ -n "$VERSION_AFTER" ] || fail "chave ${VERSION_KEY} sumiu depois do restart (versão de sessão não persistiu)"
    [ "$VERSION_AFTER" = "$VERSION_BEFORE" ] || fail "versão de sessão de A mudou no restart (${VERSION_BEFORE} -> ${VERSION_AFTER})"
    log_pass "${VERSION_KEY} = ${VERSION_AFTER} depois do restart (mesmo valor, relido do volume)"

    [ "${DBSIZE_AFTER:-0}" -gt 0 ] 2>/dev/null || fail "Redis ficou sem chaves depois do restart (DBSIZE='${DBSIZE_AFTER}')"
    log_pass "Redis com ${DBSIZE_AFTER} chave(s) depois do restart (estado relido do volume)"

    # O AOF é reescrito do zero a cada 60s pelo Redis; o snapshot RDB é a segunda
    # camada e não aparece no mesmo instante. Aqui só se confirma que o diretório
    # continua lá depois do restart, e o flag `--save` é o que
    # `tests/unit/redis-persistence-config.test.ts` prende no compose.
    [ -n "$(redis_file 'test -d /data/appendonlydir && echo yes')" ] \
        || fail "appendonlydir sumiu depois do restart"
    log_pass "appendonlydir intacto depois do restart"

    echo -e "${GREEN}🎉 Persistência de revogação verificada: o que foi revogado continua revogado.${NC}"
    exit 0
fi

# --- modo --volume-loss: aqui o ESPERADO é o buraco existir, e ser medido ---

# Primeiro o dado: a revogação de A tem que ter sumido do Redis. Sem isto, um
# 200 do token de A poderia ser qualquer outra coisa (uma chave com TTL
# expirada, um bug no filtro) em vez do que a D20 descreve: o registro sumiu.
[ -z "$VERSION_AFTER" ] || fail "a chave ${VERSION_KEY} continua no Redis depois da perda de volume (valor ${VERSION_AFTER}) — a revogação NÃO foi perdida e o modo --volume-loss está medindo outra coisa"
log_pass "${VERSION_KEY} sumiu do Redis (DBSIZE ${DBSIZE_BEFORE} -> ${DBSIZE_AFTER:-0} chave(s)): o registro de revogação foi perdido"

# Agora o efeito. 200 no token de A é a prova de que a perda de dado virou
# fail-open de fato — o serviço aceitou uma sessão que tinha sido encerrada.
is_access_still_valid "$ACCESS_A" \
    || fail "token de A respondeu ${STATUS} depois da perda de volume (esperado 200) — o limite da D20 NÃO se manifestou; se a revogação passou a sobreviver à perda de volume, a D20 foi fechada e a documentação precisa ser atualizada"
log_pass "token de A voltou a valer (200) depois da perda de volume — fail-open de fato, por ausência do dado"

# E a parte que define a gravidade: o par inteiro. O refresh de A já tinha sido
# consumido pelo /logout; a detecção de reuso (que também mora no Redis
# perdido) não tem como disparar. Se ele volta, o atacante que guardou o par não
# precisa esperar o access token morrer: ele renova o access token a cada 15
# minutos até o refresh expirar. É essa janela que D20 está aceitando.
request POST "/refresh" "{\"refreshToken\":\"${REFRESH_A}\"}"
if [ "$STATUS" = "200" ]; then
    NEW_ACCESS="$(json_field "$BODY" data.accessToken)"
    NEW_EXPIRES="$(json_field "$BODY" data.expiresIn)"
    if [ -n "$NEW_ACCESS" ] && is_access_still_valid "$NEW_ACCESS"; then
        EXPOSURE_OPEN=1
        log_pass "refresh de A (já consumido) voltou a valer e emitiu um accessToken novo que autentica — janela de exposição aberta pela perda de volume"
    else
        EXPOSURE_OPEN=0
    fi
else
    NEW_EXPIRES=""
    EXPOSURE_OPEN=0
    log_warn "refresh de A respondeu ${STATUS} após a perda de volume (o access token sozinho foi exposto)"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE} Custo medido do limite aceito (D20)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo "  access token revogado ......... volta a valer por até o TTL dele"
echo "  refresh token já consumido .... $( [ "$EXPOSURE_OPEN" -eq 1 ] \
    && echo "volta a valer e renova access tokens até expirar" \
    || echo "não voltou a valer neste drill" )"
if [ -n "$NEW_EXPIRES" ]; then
    # `expiresIn` do par de tokens sai em milissegundos (o próprio jwtTokenService
    # converte com `expiresIn / 1000` ao montar o TTL da blacklist), então dividir
    # por 1000 é leitura de campo, não unit trick. Os 899783 ms medidos são o
    # `JWT_EXPIRES=15m` do ambiente, e é por isso que a janela do access token
    # some ao lado dos 7 dias do refresh.
    NEW_MIN="$(awk -v ms="$NEW_EXPIRES" 'BEGIN{printf "%.1f", ms/60000}')"
    echo "  TTL do access token renovado ... ${NEW_EXPIRES} ms (~${NEW_MIN} min, medido na resposta)"
fi
# "Silencioso" é afirmação, então ela é conferida: o fail-open não pode estar
# acompanhado de erro que o operador veria. Conta o que o app registrou como
# erro depois do evento — se a perda de volume gritasse, o drill reprovaria.
APP_ERRORS="$(docker logs "$REDIS_CONTAINER_APP" --since "${EVENT_START_MS%???}" 2>&1 | grep -cE '\b(error|fatal|unhandled|exception)\b' || true)"
echo "  Erros no log do app após o evento ... ${APP_ERRORS:-0}"
[ "${APP_ERRORS:-0}" -eq 0 ] 2>/dev/null || fail "o app registrou ${APP_ERRORS} erro(s) após a perda de volume — o fail-open não é silencioso, e a documentação diz que é"
echo ""
echo -e "${YELLOW}⚠️  Drill verde aqui significa que o limite da D20 continua valendo.${NC}"
echo -e "${YELLOW}   Se um dia este drill reprovar porque a revogação sobreviveu à${NC}"
echo -e "${YELLOW}   perda de volume, a D20 foi fechada e a documentação precisa ir junto.${NC}"
echo -e "${GREEN}✅ Limite da D20 medido: ${ESPERADO}.${NC}"
