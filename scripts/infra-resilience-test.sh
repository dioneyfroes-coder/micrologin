#!/usr/bin/env bash

# ====================================
# TESTE DE RESILIÊNCIA DE INFRAESTRUTURA
# Authentication Microservice
# ====================================
#
# Teste unitário com duplo prova a lógica. Não prova que o *processo* reage a
# uma queda de verdade, que é a pergunta que interessa em produção: o serviço
# volta sozinho depois que o Redis some? O health check para de mentir? O
# container reinicia sem ficar pendurado no socket do Redis?
#
# Este script responde a isso derrubando serviço de verdade e observando o
# serviço de fora, por HTTP — que é como o orquestrador e o cliente o enxergam.
# Ele cobre os dois itens de infraestrutura que o roadmap (Fase 8) deixou
# pendentes por dependerem de docker:
#
#   1. reconexão do Redis — o Redis é parado com o app no ar; o app precisa
#      negar autenticação (fail-closed), continuar pronto para tráfego,
#      declarar a degradação, e voltar a autenticar sozinho quando o Redis
#      retorna, sem restart;
#   2. restart do container — o container do app é reiniciado; ele precisa
#      encerrar em segundos (o timer de reconexão do Redis segura o processo
#      se não for cancelado) e voltar a autenticar de ponta a ponta.
#
# E prova o item de maior risco da Fase 1.3: as dependências exigem credencial
# de verdade. O app saudável não prova isso (o banco poderia estar aberto), por
# isso o teste conecta anônimo e com senha errada em cada serviço real, e mostra
# que o container da aplicação lê as próprias senhas mas não a do root do Mongo.
#
# E prova a Fase 1.4: as duas senhas das dependências giram contra o stack no ar.
# A do Redis gira com janela (a antiga e a nova autenticam ao mesmo tempo, e o
# app não sente nada); a do Mongo gira sem janela, com a ordem obrigatória
# servidor → arquivo → app, e o login continua funcionando nas duas.
#
# Uso:
#   scripts/infra-resilience-test.sh [--keep] [--skip-build]
#
#   --keep         não destrói o stack no fim (para depurar com docker logs)
#   --skip-build   usa a imagem já construída em vez de reconstruir
#
# Requisitos: docker com compose v2, curl e python3.
#
# Códigos de saída:
#   0  o serviço se comportou como o contrato declara em todas as etapas
#   1  alguma asserção falhou (com o trecho da resposta que a desmentiu)
#   2  pré-requisito ausente (docker parado, curl/python3 faltando)
#
# O stack vive em docker-compose.resilience.yml, com nome, porta e volumes
# próprios: parar o Redis aqui não é parar o Redis de quem está programando.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

PROJECT="micrologin-resilience"
COMPOSE_FILE="docker-compose.resilience.yml"
COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f docker-compose.resilience.direct.yml)

KEEP_STACK=0
SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --keep)       KEEP_STACK=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

# ============================================================
# LIMITES
# ============================================================
#
# Todos os prazos são generosos de propósito. O teste é sobre resiliência, e
# um prazo apertado transformaria lentidão de disco em falso negativo — o
# oposto do que se quer medir. O que não pode passar é behaviour errado, e isso
# é verificado por asserção, não por espera.
WAIT_READY_TIMEOUT="${WAIT_READY_TIMEOUT:-180}"   # stack subindo do zero
WAIT_DEGRADED_TIMEOUT=60                          # app percebendo a queda
WAIT_RECOVER_TIMEOUT="${WAIT_RECOVER_TIMEOUT:-90}" # app voltando sozinho
RESTART_TIMEOUT="${RESTART_TIMEOUT:-60}"          # encerrar + subir de novo

DASHBOARD_TOKEN="resilience-test-dashboard-token-22222"
APP_CONTAINER_ID=""

RED='\033[0.31m'
GREEN='\033[0.32m'
YELLOW='\033[1;33m'
BLUE='\033[0.34m'
NC='\033[0m'

STEP=0
TOTAL_STEPS=13

log_step()  { STEP=$((STEP + 1)); echo -e "\n${BLUE}[${STEP}/${TOTAL_STEPS}] $1${NC}"; }
log_info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_pass()  { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()      { echo -e "${RED}❌ $1${NC}"; exit 1; }

# ============================================================
# PRÉ-REQUISITOS
# ============================================================
docker info >/dev/null 2>&1 || { echo "Docker não está rodando." >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl não encontrado no host." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 não encontrado no host." >&2; exit 2; }

# A porta do host é resolvida uma vez: o Compose valida o binding no `up`, e
# descobrir isso no meio do teste (depois de construir a imagem) desperdiça
# minutos para nada.
RESILIENCE_PORT="${RESILIENCE_PORT:-3200}"
BASE_URL="http://localhost:${RESILIENCE_PORT}"
export RESILIENCE_PORT

# Par de chaves ES256 efêmero, montado em disco. Efêmero de propósito: um par
# novo a cada execução significa que nenhuma chave de teste sobrevive ao fim do
# teste. Persistente de propósito dentro da execução: o token emitido antes do
# restart do container precisa continuar verificando depois dele, senão o teste
# mediria "chave trocada" em vez de "serviço voltou".
RESILIENCE_KEYS_DIR="${RESILIENCE_KEYS_DIR:-${ROOT_DIR}/.resilience-keys}"
export RESILIENCE_KEYS_DIR
# O `kid` mora aqui, e não só no compose, porque o teste afirma no token real
# que saiu a chave deste par. Se os dois lados tivessem o valor escrito por
# conta própria, a asserção passaria para qualquer `kid` que o compose aceitasse
# — isto é, ela não provaria nada.
RESILIENCE_JWT_KID="${RESILIENCE_JWT_KID:-resilience-v1}"
export RESILIENCE_JWT_KID
KEYS_GENERATED=0

# Segredos das dependências (Fase 1.3): mesmo contrato do par de chaves — nascem
# nesta máquina, o dono é ajustado para os uids das imagens, e são apagados no
# teardown. Sem eles o stack não sobe: a validação de produção recusa dependência
# sem credencial, que é justamente o que a fase passou a exigir.
RESILIENCE_DEPS_DIR="${RESILIENCE_DEPS_DIR:-${ROOT_DIR}/.resilience-deps}"
export RESILIENCE_DEPS_DIR
DEPS_GENERATED=0

RUN_ID="$(date +%s)-$$"
USERNAME="resil-${RUN_ID}"
PASSWORD="R3sil-Test-${RUN_ID}-Aa!"

BODY_FILE="$(mktemp)"

cleanup() {
    rm -f "$BODY_FILE"
    if [ "$KEEP_STACK" -eq 1 ]; then
        log_warn "Stack mantido (--keep). Remova com:"
        echo "  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} -f docker-compose.resilience.direct.yml down -v"
        if [ "$KEYS_GENERATED" -eq 1 ]; then
            echo "  rm -rf ${RESILIENCE_KEYS_DIR}   # par ES256 do teste"
        fi
        if [ "$DEPS_GENERATED" -eq 1 ]; then
            echo "  rm -rf ${RESILIENCE_DEPS_DIR}   # senhas das dependências"
        fi
        return
    fi
    log_info "Destruindo o stack de teste..."
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    if [ "$KEYS_GENERATED" -eq 1 ]; then
        rm -rf "$RESILIENCE_KEYS_DIR"
    fi
    if [ "$DEPS_GENERATED" -eq 1 ]; then
        rm -rf "$RESILIENCE_DEPS_DIR"
    fi
}
trap cleanup EXIT

# ============================================================
# HTTP
# ============================================================
STATUS=""
BODY=""

# request <método> <caminho> [body] [bearer] [dashboard]
# `dashboard` envia o token administrativo (header X-Security-Token).
request() {
    local method="$1" path="$2" payload="${3:-}" bearer="${4:-}" dashboard="${5:-false}"
    local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}")

    [ -n "$bearer" ] && args+=(-H "Authorization: Bearer ${bearer}")
    if [ "$dashboard" = "true" ]; then
        args+=(-H "X-Security-Token: ${DASHBOARD_TOKEN}")
    fi
    if [ -n "$payload" ]; then
        args+=(-H 'Content-Type: application/json' --data "$payload")
    fi

    STATUS=$(curl --max-time 15 "${args[@]}" 2>/dev/null || echo "000")
    BODY=$(cat "$BODY_FILE" 2>/dev/null || true)
}

# Extrai um campo de topo do JSON resposta.
#
# Sai sempre com 0, mesmo quando o campo não existe: o valor ausente é
# informação ("esse campo não veio"), e quem julga é `expect_json`, que sabe
# dizer o que esperava. Um `exit 1` aqui seria engolido por `set -e` na
# substituição de comando e mataria o script sem mensagem nenhuma — o jeito
# pior de falhar um teste de resiliência.
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

expect_status() {
    local expected="$1" what="$2"
    if [ "$STATUS" != "$expected" ]; then
        fail "${what}: esperado HTTP ${expected}, recebeu ${STATUS}. Corpo: ${BODY:0:400}"
    fi
}

expect_not_status() {
    local forbidden="$1" what="$2"
    if [ "$STATUS" = "$forbidden" ]; then
        fail "${what}: não deveria ser HTTP ${forbidden}. Corpo: ${BODY:0:400}"
    fi
}

expect_json() {
    local expr="$1" expected="$2" what="$3"
    local actual
    actual=$(json_field "$BODY" "$expr")
    if [ "$actual" != "$expected" ]; then
        fail "${what}: ${expr} = '${actual}', esperado '${expected}'. Corpo: ${BODY:0:400}"
    fi
}

# expect_eq <valor> <esperado> <descrição>
expect_eq() {
    if [ "$1" != "$2" ]; then
        fail "${3}: obtido '${1}', esperado '${2}'"
    fi
}

# Lê uma claim do header de um JWT sem verificar assinatura.
# Existe para afirmar que o token REAL saiu com ES256 e o `kid` do par do
# teste: um stack de resiliência que validasse HS256 não estaria testando a
# configuração que vai para produção.
jwt_header_claim() {
    printf '%s' "$1" | python3 -c '
import base64, json, sys
token = sys.stdin.read().strip()
try:
    raw = token.split(".")[0]
    padding = "=" * (-len(raw) % 4)
    header = json.loads(base64.urlsafe_b64decode(raw + padding))
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    if not isinstance(header, dict) or key not in header:
        sys.exit(0)
    header = header[key]
print(header if header is not None else "")
' "$2" 2>/dev/null || true
}

# ============================================================
# ESPERAS
# ============================================================
#
# wait_for <segundos> <descrição> <comando...>
# A descrição entra na mensagem de falha: "esperou 90s por X" é informação útil
# quando o teste falha, "timeout" não é.
wait_for() {
    local timeout="$1" what="$2"
    shift 2
    local deadline=$((SECONDS + timeout))

    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done

    fail "esperou ${timeout}s por: ${what}"
}

# Predicados de espera -------------------------------------------------

# Prontidão: o app aceitando tráfego com Mongo respondendo.
is_ready() {
    request GET "/readiness"
    [ "$STATUS" = "200" ]
}

# O app percebeu a queda: o relatório de saúde diz que o Redis não responde.
# O `status` do relatório inteiro não serve — ele já vem "degraded" por outros
# motivos; o que interessa é o serviço nomeado.
redis_reported_degraded() {
    request GET "/health"
    [ "$STATUS" != "000" ] && [ "$(json_field "$BODY" services.redis.status)" = "degraded" ]
}

# O oposto, usado depois de religar o Redis.
redis_reported_healthy() {
    request GET "/health"
    [ "$STATUS" = "200" ] && [ "$(json_field "$BODY" services.redis.status)" = "healthy" ]
}

# O app voltou a autenticar sozinho (o sinal que importa, não o health check).
login_works() {
    request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
    [ "$STATUS" = "200" ]
}

# ============================================================
# ESTADO DO CONTAINER
# ============================================================
restart_count() {
    [ -n "$APP_CONTAINER_ID" ] || return 1
    docker inspect -f '{{.RestartCount}}' "$APP_CONTAINER_ID" 2>/dev/null || echo "?"
}

# Le um segredo de dentro do container que tem permissão para ele.
#
# Os arquivos de material são do uid 1001 (app) ou 999 (dependência), em modo
# 640/600: quem provisionou no host não é dono nem entra no grupo, e `cat` no host
# devolve "Permission denied". A leitura é feita de dentro do container que vai
# usar a credencial — que é quem precisa conseguir ler, e é o que o teste quer
# afirmar. A senha do root do Mongo só é legível no container do Mongo, que roda
# como o mesmo uid 999; no app ela é recusada (e o passo 3 mostra que é).
read_app_secret() {
    docker exec "$APP_CONTAINER_ID" cat "/run/secrets/deps/$1"
}

read_mongo_root_password() {
    docker exec micrologin-resilience-mongo cat /run/secrets/deps/mongo-root-password | tr -d '\n'
}

is_running() {
    [ -n "$APP_CONTAINER_ID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER_ID" 2>/dev/null || echo false)" = "true" ]
}

rate_limit_using_redis() {
    request GET "/security/stats" "" "" "true"
    [ "$(json_field "$BODY" rateLimit.usingRedis)" = "True" ]
}

echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE} Teste de resiliência de infraestrutura${NC}"
echo -e "${BLUE} Stack: ${PROJECT} @ ${BASE_URL}${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

# ============================================================
# 1. Stack de pé
# ============================================================
log_step "Subindo o stack de teste (build da imagem de produção inclusa)"

# Instala/limpa restos de uma execução anterior: sem isto, `up` reaproveita o
# container velho (com a imagem antiga) e o teste passa provando a versão
# errada.
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true

# O par ES256 é gerado aqui, e não versionado, porque o app em produção recusa
# subir sem ele: um diretório de chaves montado e vazio derruba o container no
# `validateConfiguration` — o teste falharia esperando um readiness que nunca
# viria, sem dizer por quê. `generate-jwt-keys.sh` recusa sobrescrever um par
# existente, então um resto de execução anterior é removido antes.
rm -rf "$RESILIENCE_KEYS_DIR"
bash "${SCRIPT_DIR}/generate-jwt-keys.sh" "$RESILIENCE_KEYS_DIR" "$RESILIENCE_JWT_KID" --for-container >/dev/null
KEYS_GENERATED=1
log_info "par ES256 efêmero gerado em ${RESILIENCE_KEYS_DIR} (kid ${RESILIENCE_JWT_KID})"

# Segredos das dependências pelo mesmo motivo das chaves: um diretório montado e
# vazio derruba o container na validação (Mongo sem credencial em produção), e a
# falha apareceria como "readiness nunca ficou pronto", longe da causa.
# `--skip-verify` porque a prova ao vivo da ACL é feita pelo próprio stack: o
# teste abaixo conecta anônimo, com senha errada e com a senha certa.
rm -rf "$RESILIENCE_DEPS_DIR"
bash "${SCRIPT_DIR}/generate-dependency-secrets.sh" "$RESILIENCE_DEPS_DIR" --for-container --skip-verify >/dev/null
DEPS_GENERATED=1
log_info "senhas das dependências geradas em ${RESILIENCE_DEPS_DIR} (Mongo e Redis autenticados)"

if [ "$SKIP_BUILD" -eq 1 ]; then
    log_info "--skip-build: usando a imagem micrologin-resilience:local existente"
    "${COMPOSE[@]}" up -d --no-build >/dev/null
else
    "${COMPOSE[@]}" build >/dev/null
    "${COMPOSE[@]}" up -d >/dev/null
fi

APP_CONTAINER_ID="$("${COMPOSE[@]}" ps -q auth-service)"
[ -n "$APP_CONTAINER_ID" ] || fail "não foi possível resolver o container do serviço auth-service"

wait_for "$WAIT_READY_TIMEOUT" "readiness 200" is_ready
log_pass "stack no ar e pronto para tráfego"

# ============================================================
# 2. Estado saudável: baseline
# ============================================================
log_step "Estado saudável: baseline"

request GET "/liveness"
expect_status 200 "liveness"
expect_json status alive "liveness sem status 'alive'"

request GET "/health"
expect_json services.redis.status healthy "Redis no health check"
expect_json services.mongodb.status healthy "MongoDB no health check"

# Registro + login: sem isto, as etapas seguintes não teriam o que observar.
request POST "/register" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 201 "registro"

request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 "login"
ACCESS_TOKEN=$(json_field "$BODY" data.accessToken)
[ -n "$ACCESS_TOKEN" ] || fail "login sem data.accessToken: ${BODY:0:300}"

# A configuração de assinatura precisa ser a que vai para produção, não uma que
# apenas funciona. Lê o header do token REAL emitido pelo container: um stack
# que assinasse HS256 passaria todas as etapas abaixo (o token verifica, o
# login funciona, o restart funciona) e não estaria testando nada de ES256.
expect_eq "$(jwt_header_claim "$ACCESS_TOKEN" alg)" "ES256" \
    "algoritmo do token emitido (o stack deveria assinar em ES256)"
expect_eq "$(jwt_header_claim "$ACCESS_TOKEN" kid)" "$RESILIENCE_JWT_KID" \
    "kid do token emitido (tem de ser a chave deste par)"
log_pass "token real saiu assinado em ES256 com o kid ${RESILIENCE_JWT_KID}"

request GET "/profile" "" "$ACCESS_TOKEN"
expect_status 200 "perfil autenticado"
log_pass "autentica de ponta a ponta com tudo no ar (usuário ${USERNAME})"

# ============================================================
# 3. As credenciais são exigidas de verdade (Fase 1.3)
# ============================================================
log_step "As dependências recusam quem não tem credencial"

# O app estar saudável não prova que o banco exige senha: ele poderia estar
# aberto, com o app autenticando por acaso. Estas perguntas vêm de fora do app,
# contra os serviços reais, com o cliente oficial de cada um.

REDIS_ANON=$(docker exec micrologin-resilience-redis \
    redis-cli --no-auth-warning ping 2>&1 || true)
case "$REDIS_ANON" in
    *NOAUTH*) ;;
    *) fail "o Redis aceitou conexão anônima (resposta: ${REDIS_ANON})" ;;
esac

REDIS_WRONG=$(printf 'AUTH auth-service senha-errada\nPING\n' \
    | docker exec -i micrologin-resilience-redis redis-cli --no-auth-warning 2>&1 || true)
case "$REDIS_WRONG" in
    *WRONGPASS*) ;;
    *) fail "o Redis não recusou a senha errada (resposta: ${REDIS_WRONG})" ;;
esac
log_pass "Redis: anônimo → NOAUTH, senha errada → WRONGPASS"

# `db.adminCommand('ping')` responderia anônimo — o ping é liberado antes da
# autenticação. Uma leitura de dado, não: é ela que prova que sem credencial
# não se chega ao conteúdo do banco.
if docker exec micrologin-resilience-mongo mongosh --quiet --host 127.0.0.1 \
    --eval 'db.getSiblingDB("auth_resilience").smoke.findOne()' >/dev/null 2>&1; then
    fail "o Mongo aceitou leitura anônima: o banco não está exigindo credencial"
fi
log_pass "Mongo: leitura anônima recusada"

# Controle positivo e negativo do isolamento dos segredos dentro do app. O
# negativo (não ler a senha do root) só significa alguma coisa se o positivo
# (ler as próprias senhas) for verdade: um bind mount que não montou nada
# também falharia em ler a do root, e passaria como se fosse isolamento.
docker exec "$APP_CONTAINER_ID" sh -c \
    'test -r /run/secrets/deps/mongo-app-password && test -r /run/secrets/deps/redis-password' \
    || fail "o app não consegue ler as senhas que deveria usar"
if docker exec "$APP_CONTAINER_ID" sh -c \
    'cat /run/secrets/deps/mongo-root-password' >/dev/null 2>&1; then
    fail "o app leu a senha do root do Mongo: o segredo do root não está isolado do processo"
fi
log_pass "app lê só as próprias senhas; a do root do Mongo fica fora do alcance dele"

# ============================================================
# 4. Rotação das senhas das dependências (Fase 1.4)
# ============================================================
log_step "Rotacionar a senha do Redis sem derrubar quem já está conectado"

# A rotação usa o mesmo script que vai para produção. O ponto não é que a senha
# nova funciona: é que a janela exista. Sem ela, trocar a senha exigiria parar o
# Redis e o app na ordem certa, e o instante em que nenhuma credencial vale
# viraria uma janela de 503.
REDIS_PASSWORD_BEFORE="$(read_app_secret redis-password)"

bash "${SCRIPT_DIR}/rotate-dependency-secrets.sh" "$RESILIENCE_DEPS_DIR" \
    --for-container --skip-verify >/dev/null

REDIS_PASSWORD_AFTER="$(read_app_secret redis-password)"
if [ "$REDIS_PASSWORD_BEFORE" = "$REDIS_PASSWORD_AFTER" ]; then
    fail "a rotação reescreveu a mesma senha do Redis: nada foi rotacionado"
fi

# O Redis só relê a ACL quando o processo sobe. O arquivo é montado como
# arquivo (mesmo inode), então o restart já enxerga a ACL nova.
"${COMPOSE[@]}" restart redis >/dev/null

# As duas credenciais têm de valer ao mesmo tempo. A antiga é a que o processo
# do app ainda está usando em memória agora — se ela parasse de valer, a rotação
# derrubaria o serviço no exato instante em que deveria ser transparente.
redis_auth_ok() {
    local password="$1" out
    out="$(printf 'AUTH auth-service %s\nPING\n' "$password" \
        | docker exec -i micrologin-resilience-redis redis-cli --no-auth-warning 2>&1 || true)"
    case "$out" in *PONG*) return 0 ;; *) return 1 ;; esac
}

redis_auth_ok "$REDIS_PASSWORD_BEFORE" \
    || fail "a senha anterior do Redis parou de valer com a janela aberta: rotacionar derrubaria o serviço"
redis_auth_ok "$REDIS_PASSWORD_AFTER" \
    || fail "a senha nova do Redis não autentica depois da rotação"
log_pass "janela aberta: senha nova e anterior autenticam no mesmo Redis"

# O app continua no ar com a credencial antiga em memória: é a prova de que a
# janela é transparente, e não só que o arquivo ficou bonito.
wait_for "$WAIT_RECOVER_TIMEOUT" "o app voltar a ver o Redis saudável" redis_reported_healthy
login_works || fail "o app deixou de autenticar logo após a rotação, ainda com a janela aberta"
log_pass "app no ar, com a senha antiga em memória, segue autenticando"

# Agora o app passa a usar a senha nova. É o passo que fecha a janela com
# segurança: a partir daqui a credencial antiga já não é mais necessária.
"${COMPOSE[@]}" restart auth-service >/dev/null
wait_for "$WAIT_READY_TIMEOUT" "readiness depois de reiniciar com a senha nova" is_ready
wait_for "$WAIT_RECOVER_TIMEOUT" "login com a senha nova do Redis" login_works
log_pass "app reiniciado autenticando com a senha nova"

# ============================================================
# 5. Rotação do Mongo e fechamento da janela
# ============================================================
log_step "Rotação da senha do Mongo e o fim da janela do Redis"

# O Mongo não aceita duas senhas por usuário: `changeUserPassword` invalida a
# anterior no mesmo instante. Por isso a ordem é obrigatória — servidor, arquivo,
# app — e o app só sobe depois que o servidor já conhece a senha nova.
MONGO_PASSWORD_BEFORE="$(read_app_secret mongo-app-password)"

bash "${SCRIPT_DIR}/rotate-dependency-secrets.sh" "$RESILIENCE_DEPS_DIR" \
    --mongo-only --for-container --skip-verify >/dev/null

MONGO_PASSWORD_AFTER="$(read_app_secret mongo-app-password)"
if [ "$MONGO_PASSWORD_BEFORE" = "$MONGO_PASSWORD_AFTER" ]; then
    fail "a senha do app no Mongo não foi rotacionada"
fi

MONGO_ROOT_PASSWORD="$(read_mongo_root_password)"

# O usuario vive no banco `admin` (e e ai que o role `readWrite` sobre o banco da
# aplicacao e concedido) — ver docker/mongo/10-app-user.sh. Sem o
# getSiblingDB, `db` apontaria para `test` e a troca falharia com "user not
# found" num banco onde o usuario nao esta.
if ! MONGO_CHANGE_OUT="$(docker exec micrologin-resilience-mongo mongosh --quiet --host 127.0.0.1 \
    --username root --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
    --eval "db.getSiblingDB('admin').changeUserPassword('auth-service', '$MONGO_PASSWORD_AFTER')" 2>&1)"; then
    echo "$MONGO_CHANGE_OUT" >&2
    fail "changeUserPassword falhou: a rotação do Mongo não chegou ao servidor"
fi

"${COMPOSE[@]}" restart auth-service >/dev/null
wait_for "$WAIT_READY_TIMEOUT" "readiness depois da rotação do Mongo" is_ready
wait_for "$WAIT_RECOVER_TIMEOUT" "login com a senha nova do Mongo" login_works
log_pass "app autenticando com a senha nova do Mongo (servidor trocado antes do app subir)"

# Fechar a janela: a senha antiga do Redis deixa de valer, e o serviço segue
# funcionando na senha nova. Se a janela fechasse tarde demais, a credencial
# antiga continuaria um caminho vivo para o cache e para a blacklist.
bash "${SCRIPT_DIR}/rotate-dependency-secrets.sh" "$RESILIENCE_DEPS_DIR" \
    --close-window --for-container --skip-verify >/dev/null
"${COMPOSE[@]}" restart redis >/dev/null

if redis_auth_ok "$REDIS_PASSWORD_BEFORE"; then
    fail "a janela fechou mas a senha anterior do Redis continua autenticando"
fi
redis_auth_ok "$REDIS_PASSWORD_AFTER" \
    || fail "a janela fechou e derrubou a senha que o app está usando"
log_pass "janela fechada: a senha antiga foi recusada e a nova continua valendo"

wait_for "$WAIT_RECOVER_TIMEOUT" "o app se recompor com a janela fechada" redis_reported_healthy
login_works || fail "o app deixou de autenticar depois do fechamento da janela"
log_pass "app autenticando de ponta a ponta depois das duas rotações"

# ============================================================
# 6. Redis cai
# ============================================================
log_step "Derrubando o Redis com a aplicação no ar"

"${COMPOSE[@]}" stop redis >/dev/null
log_info "Redis parado. O processo NÃO deve ser reiniciado: quem reconecta é a conexão."

wait_for "$WAIT_DEGRADED_TIMEOUT" "health check declarar o Redis degradado" redis_reported_degraded

RESTARTS_BEFORE=$(restart_count)
[ "$RESTARTS_BEFORE" = "0" ] || log_warn "container já tinha ${RESTARTS_BEFORE} restart(s) antes da queda"
log_pass "health check parou de dizer 'Redis disponível' com o Redis no chão"

# ============================================================
# 7. O comportamento sob Redis fora (fail-closed)
# ============================================================
log_step "Redis fora: o serviço se recusa a autenticar, e diz por quê"

# Liveness não toca em dependência: uma queda do Redis não pode reiniciar o
# container — o remédio é restaurar o Redis, e reiniciar só gastaria o
# orçamento de reinício do orquestrador.
request GET "/liveness"
expect_status 200 "liveness durante a queda do Redis"
log_pass "liveness 200 (processo intacto)"

# Readiness continua 200: o Mongo responde e o app está apto a tráfego. Tirar
# o container da rotação só trocaria indisponibilidade por indisponibilidade.
request GET "/readiness"
expect_status 200 "readiness durante a queda do Redis"
expect_json degraded True "readiness deveria reportar a degradação"
log_pass "readiness 200 e degradado (Redis fora não tira o serviço da rotação)"

# O ponto do fail-closed: sem armazenamento de revogação, não há token a emitir.
# 503 diz "a culpa é nossa, tente de novo"; 401 diria "a senha está errada" e
# faria o cliente desistir de uma conta cuja senha está certa.
request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 503 "login com revogação indisponível"
expect_json code REVOCATION_UNAVAILABLE "código do erro de login"
log_pass "login → 503 REVOCATION_UNAVAILABLE (não 401 de credencial inválida)"

# A falha anterior que este teste existe para pegar: `Error` do driver de Redis
# tratado como limite estourado. Aqui seria 429 + "violação de rate limit" na
# auditoria — o serviço acusando ataque quando o que caiu foi a dependência.
expect_not_status 429 "login com Redis fora não pode virar rate limit"
request GET "/security/stats" "" "" "true"
expect_json security.failedLogins 0 "quinze minutos de indisponibilidade não são ataque"
expect_json security.unavailableLogins 1 "recusa por infraestrutura é contada à parte"
log_pass "nenhum 429 e nenhum login contado como falha de credencial"

# Token emitido antes da queda não pode continuar sendo aceito: aceitar seria
# o fail-open que a política de produção descartou.
request GET "/profile" "" "$ACCESS_TOKEN"
expect_status 503 "perfil com token válido e revogação indisponível"
log_pass "token pré-queda não é aceito (não vira fail-open na prática)"

[ "$(restart_count)" = "$RESTARTS_BEFORE" ] \
    || fail "o container reiniciou durante a queda do Redis: o app não deveria morrer por causa de dependência"
log_pass "container não reiniciou (RestartCount segue ${RESTARTS_BEFORE})"

# ============================================================
# 8. Redis volta
# ============================================================
log_step "Religando o Redis: o app precisa voltar sozinho"

"${COMPOSE[@]}" start redis >/dev/null
log_info "Redis religado. Ninguém vai reiniciar o processo; a reconexão é do driver."

# Este é o item "reconexão Redis" do roadmap. Sem o `ready` religando a saúde e
# a estratégia sem desistir, o app continuaria devolvendo 503 até alguém
# reiniciar o container — que é o defeito que a correção elimina.
wait_for "$WAIT_RECOVER_TIMEOUT" "login voltar a funcionar sem restart do app" login_works

request GET "/health"
expect_json services.redis.status healthy "Redis no health check após religar"
log_pass "autenticação restaurada sem reiniciar o processo"

# O rate limiter tem que voltar a ser compartilhado: em memória ele vale só
# neste processo, e o limite por conta existe justamente para o atacante
# distribuído.
wait_for "$WAIT_RECOVER_TIMEOUT" "rate limiting voltar ao armazenamento compartilhado" rate_limit_using_redis
log_pass "rate limiting voltou ao Redis (limite compartilhado entre processos)"

# ============================================================
# 9. Estado restaurado
# ============================================================
log_step "Autenticação completa depois da queda"

request POST "/login" "{\"user\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 "login após recuperação"
REFRESH_TOKEN=$(json_field "$BODY" data.refreshToken)

request POST "/refresh" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}"
expect_status 200 "rotação de refresh após recuperação"

request POST "/logout" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}"
expect_status 200 "logout após recuperação"
log_pass "login, refresh e logout funcionando novamente"

# ============================================================
# 10. Restart do container
# ============================================================
log_step "Reiniciando o container da aplicação"

# O container precisa encerrar rápido. A reconexão do Redis é infinita por
# decisão de produção (ninguém desiste enquanto o processo vive), então o
# encerramento precisa cancelar o timer pendente: `quit()` num socket em
# reconexão manda um comando que ninguém atende e o processo fica preso no
# event loop. O timeout abaixo existe para transformar "o restart travou" em
# falha nomeada em vez de espera eterna.
RESTART_START=$SECONDS
if ! timeout "$RESTART_TIMEOUT" "${COMPOSE[@]}" restart auth-service >/dev/null 2>&1; then
    fail "o container não encerrou em ${RESTART_TIMEOUT}s: o shutdown ficou preso (provável timer de reconexão do Redis)"
fi
RESTART_ELAPSED=$((SECONDS - RESTART_START))
log_pass "container encerrou e subiu em ${RESTART_ELAPSED}s"

wait_for "$WAIT_READY_TIMEOUT" "readiness após restart" is_ready
log_pass "readiness 200 depois do restart"

# ============================================================
# 11. O serviço volta a autenticar
# ============================================================
log_step "O container reiniciado autentica de verdade"

# Conta nova de propósito: o registro anterior pode ter sobrevivido no Mongo,
# mas o smoke test completo é o que prova que a instância nova funciona de
# ponta a ponta (inclusive revogação, que depende do Redis reconectado no
# processo novo).
SMOKE_BASE="$BASE_URL" bash "${SCRIPT_DIR}/smoke-test.sh" "$BASE_URL" \
    || fail "smoke test falhou após o restart: o container subiu, mas não serve tráfego"
log_pass "smoke test completo passou na instância reiniciada"

# ============================================================
# 12. Segundo restart, com o Redis fora
# ============================================================
log_step "Reiniciar o container com o Redis fora não pode ser deadlock"

# A combinação que fecha o ciclo: o processo precisa conseguir encerrar
# enquanto a conexão do Redis está em reconexão. Se o encerramento dependesse
# de uma resposta do Redis, este passo seria o que trava.
"${COMPOSE[@]}" stop redis >/dev/null
RESTART_START=$SECONDS
if ! timeout "$RESTART_TIMEOUT" "${COMPOSE[@]}" restart auth-service >/dev/null 2>&1; then
    fail "o container não encerrou com o Redis fora: o shutdown depende de uma dependência indisponível"
fi
RESTART_ELAPSED=$((SECONDS - RESTART_START))
log_pass "encerrou e subiu em ${RESTART_ELAPSED}s mesmo com o Redis fora"

"${COMPOSE[@]}" start redis >/dev/null
wait_for "$WAIT_RECOVER_TIMEOUT" "o container novo reconectar sozinho ao Redis" redis_reported_healthy
log_pass "processo novo religou a saúde do Redis sozinho"

# ============================================================
# 13. Diagnóstico
# ============================================================
log_step "Diagnóstico final"

request GET "/health"
expect_json services.redis.status healthy "Redis no fim do teste"
request GET "/readiness"
expect_status 200 "readiness no fim do teste"

FINAL_RESTARTS=$(restart_count)
log_info "RestartCount acumulado do container: ${FINAL_RESTARTS}"
log_info "Logs da aplicação durante o teste:"
"${COMPOSE[@]}" logs --no-color --tail 25 auth-service 2>/dev/null | sed 's/^/    /' || true

echo -e "\n${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Resiliência de infraestrutura verificada.${NC}"
echo -e "${GREEN}   • Redis caiu: 503 REVOCATION_UNAVAILABLE, sem 429, sem fail-open${NC}"
echo -e "${GREEN}   • Redis voltou: autenticação e rate limit compartilhado restaurados${NC}"
echo -e "${GREEN}   • Container reiniciou: saiu rápido e voltou a autenticar${NC}"
echo -e "${GREEN}   • Dependências autenticadas: anônimo e senha errada recusados${NC}"
echo -e "${GREEN}   • App lê só as próprias senhas; a do root do Mongo fica fora do alcance${NC}"
echo -e "${GREEN}   • Rotação do Redis: janela com as duas senhas, depois só a nova${NC}"
echo -e "${GREEN}   • Rotação do Mongo: servidor trocado antes do app subir, sem quebrar o login${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
