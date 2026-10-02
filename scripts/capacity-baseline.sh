#!/usr/bin/env bash
# ===================================================================
# Baseline de capacidade (Fase 3.1) e varredura de workers (Fase 3.2)
# ===================================================================
# Mede p50/p95/p99, taxa de falha e memoria por corrida de k6, e monta a
# tabela "quanto um worker aguenta" que o roadmap pede.
#
# Por que um driver e nao apenas o script k6:
#
#   - O numero de workers so muda reiniciando o servico, e o rate limit de
#     producao (5 logins/15 min por usuario, 100/min por IP) barra a medicao
#     em menos de um segundo. O driver sobe o servico com
#     `docker-compose.capacity.yml`, roda a matriz e devolve o container ao
#     `.env.prod` no teardown.
#   - A memoria precisa ser amostrada DURANTE a carga. `/observability` responde
#     pelo processo que o kernel escolheu naquele accept, entao o driver amostra
#     varias vezes e separa por pid no consolidado.
#   - O teardown limpa os contadores `rl_*` do Redis. Sem isso o orcamento
#     inflado da medicao continua valendo depois que o limite volta ao valor de
#     producao, e o proximo teste real toma 429 sem motivo.
#
# Uso:
#   scripts/capacity-baseline.sh
#   scripts/capacity-baseline.sh --vus 100,200,400 --duration 60s
#   scripts/capacity-baseline.sh --workers 1,2 --endpoints health,login
#
# Saida: <OUT_DIR>/summary.md, <OUT_DIR>/k6_*.json, <OUT_DIR>/mem_*.csv
# ===================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_PROD="docker-compose.prod.yml"
COMPOSE_CAPACITY="docker-compose.capacity.yml"
ENV_FILE=".env.prod"
SERVICE="auth-service"
K6_IMAGE="${K6_IMAGE:-grafana/k6:latest}"
SEED_PASSWORD="K6#Bench2026Pass"

WORKERS_LIST="1"
VUS_LIST="100,200,400"
ENDPOINTS_LIST="health,login,refresh,register"
DURATION="60s"
RAMP_UP="15s"
RAMP_DOWN="10s"
REGISTER_ITERATIONS="5"
SAMPLE_INTERVAL="2"
OUT_DIR="artifacts/capacity"
KEEP_STACK=0
GC_TRACE=1
MAX_IN_FLIGHT="1024"

while [ $# -gt 0 ]; do
    case "$1" in
        --workers)      WORKERS_LIST="$2"; shift 2 ;;
        --vus)          VUS_LIST="$2"; shift 2 ;;
        --endpoints)    ENDPOINTS_LIST="$2"; shift 2 ;;
        --duration)     DURATION="$2"; shift 2 ;;
        --ramp-up)      RAMP_UP="$2"; shift 2 ;;
        --ramp-down)    RAMP_DOWN="$2"; shift 2 ;;
        --iterations)   REGISTER_ITERATIONS="$2"; shift 2 ;;
        --sample-every) SAMPLE_INTERVAL="$2"; shift 2 ;;
        --max-in-flight)
            # 1024 e o default do servico e o teto em que a medicao o deixou
            # transparente (docs/metricas.md 5). Abaixo disso o limitador
            # segura rajada, mas paga caro em vazao.
            MAX_IN_FLIGHT="$2"; shift 2 ;;
        --out)          OUT_DIR="$2"; shift 2 ;;
        --keep-stack)   KEEP_STACK=1; shift ;;
        # Sem o rastro de GC o processo roda com o comando de producao. A
        # medicao de latencia nao precisa dele; a de heap/GC (Fase 3.2) precisa,
        # e e o unico jeito de contar quantas coletadas houve e quanto tempo
        # elas tiraram do event loop -- `/observability` so da heap Used/Total.
        --no-gc-trace)  GC_TRACE=0; shift ;;
        -h|--help)      sed -n '2,28p' "$0"; exit 0 ;;
        *) echo -e "${RED}Opcao desconhecida: $1${NC}" >&2; exit 1 ;;
    esac
done

log_step() { echo -e "${YELLOW}$1${NC}"; }
log_pass() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------
echo -e "${YELLOW}══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW} Baseline de capacidade (Fase 3.1)${NC}"
echo -e "${YELLOW}══════════════════════════════════════════════════════${NC}"

[ -f "$ENV_FILE" ] || fail "$ENV_FILE nao existe: rode o deploy local antes"
[ -f "$COMPOSE_PROD" ] || fail "$COMPOSE_PROD nao encontrado"
[ -f "$COMPOSE_CAPACITY" ] || fail "$COMPOSE_CAPACITY nao encontrado"
has_cmd docker || fail "docker nao encontrado"
has_cmd jq || fail "jq nao encontrado"
has_cmd curl || fail "curl nao encontrado"
has_cmd python3 || fail "python3 nao encontrado (consolidado da tabela)"

# O token e o mesmo que o servico exige em /observability. Sem ele o
# manifesto responde 401 e nao ha amostra de memoria: a corrida de latencia
# ainda valeria, a de memoria nao.
METRICS_TOKEN="$(grep -E '^METRICS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
[ -n "$METRICS_TOKEN" ] || fail "METRICS_TOKEN ausente em $ENV_FILE"

APP_PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
APP_PORT="${APP_PORT:-3000}"
# A medicao fala com o container do Node pela porta que o override de medicao
# publica direto no host (ver `docker-compose.capacity.yml`), e nao pelo
# `auth-proxy`: o nginx de producao exige certificado TLS e entra em
# crash-loop sem ele, levando a medicao junto. CAPACITY_PORT permite escolher
# outra porta para nao colidir com o proxy de quem esta medindo.
CAPACITY_PORT="${CAPACITY_PORT:-$APP_PORT}"
BASE_URL="http://localhost:${CAPACITY_PORT}"
export CAPACITY_PORT

RUN_ID="$(date +%s | tail -c 7)"
USER_COUNT="$(echo "$VUS_LIST" | tr ',' '\n' | sort -n | tail -1)"
mkdir -p "$OUT_DIR"

# Com `--trace-gc` o Node escreve uma linha por coleta no stdout, que e o log do
# container. Sem isso a Fase 3.2 fica sem dado de GC: `/observability` so
# expoe heap Used/Total, que mostra o dente de serra mas nao diz quantas
# coletadas houve nem quanto tempo elas tiraram do event loop -- e pause de GC
# e o que aparece no p99.
if [ "$GC_TRACE" = "1" ]; then
    CAPACITY_COMMAND="${CAPACITY_COMMAND:-node --trace-gc dist/app.js}"
fi
export CAPACITY_COMMAND="${CAPACITY_COMMAND:-}"

log_step "run_id=${RUN_ID}  workers=${WORKERS_LIST}  vus=${VUS_LIST}  endpoints=${ENDPOINTS_LIST}  max_in_flight=${MAX_IN_FLIGHT}"
log_step "duracao=${DURATION} (rampa ${RAMP_UP} + ${RAMP_DOWN})  alvo=${BASE_URL}"
log_step "comando no container: ${CAPACITY_COMMAND:-<command da imagem>}"

# ------------------------------------------------------------------
# Helpers de compose e coleta

compose() {
    local workers="$1"; shift
    local enabled=false
    [ "$workers" -gt 1 ] && enabled=true
    # `environment` do override vence `env_file`, entao o orcamento de rate
    # limit de medicao nao encosta no .env.prod.
    CAPACITY_WORKERS="$workers" \
    CAPACITY_CLUSTER_ENABLED="$enabled" \
    CAPACITY_MAX_IN_FLIGHT="$MAX_IN_FLIGHT" \
    docker compose --env-file "$ENV_FILE" \
        -f "$COMPOSE_PROD" -f "$COMPOSE_CAPACITY" "$@"
}

compose_plain() {
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_PROD" "$@"
}

# Instante de inicio da janela de carga, em UTC, no formato que o
# `docker logs --since` entende.
#
# Por que carimbo de tempo e nao "quantas linhas o log ja tinha": o log do
# container ROTACIONA (`logging.max-size: 10m`, `max-file: 3`, em
# `docker-compose.prod.yml`). Numa corrida de 400 VUs o container escreve
# dezenas de milhares de linhas e o arquivo mais antigo some de dentro do
# `docker logs` -- o daemon devolve so o que ainda existe. O offset por
# contagem apontava entao para uma linha que ja nao existia, e o recorte
# devolvia vazio: a corrida era registrada como "zero coleta" quando o
# processo tinha coletado milhares de vezes. Com `--since` quem filtra e o
# daemon, por timestamp de cada linha, e nao por posicao.
gc_window_since() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

# Recorta o log da janela e deixa so as linhas de coleta. O arquivo fica em
# cru: quem interpreta (e agrupa por pid, separa Scavenge de Mark-Compact)
# e o `scripts/capacity-summary.py`.
capture_gc_log() {
    local cid="$1" since="$2" out="$3"
    : > "$out"
    docker logs --since "$since" "$cid" 2>&1 \
        | grep -aE 'ms: (Scavenge|Mark-sweep|Mark-Compact)' > "$out" || true
    if [ -s "$out" ]; then
        echo "$(wc -l < "$out" | tr -d ' ') coleta(s) em $(basename "$out")"
    else
        rm -f "$out"
        echo "NENHUMA linha de GC na janela desde $since -- trate como medicao perdida"
        echo "  (com --trace-gc ligado, uma janela de 85 s TEM linhas; se chegou aqui,"
        echo "   o log do container rotacionou ou o processo nao subiu com o comando esperado)"
    fi
}

sample_memory() {
    local csv="$1"
    echo "ts,pid,rss_mb,heap_used_mb,heap_total_mb,external_mb" > "$csv"
    while :; do
        curl -s -m 5 -H "x-metrics-token: ${METRICS_TOKEN}" "${BASE_URL}/observability" 2>/dev/null \
            | jq -r --arg ts "$(date -Is)" '
                if .service then
                  [ $ts, .service.pid, .service.memory.rss_mb,
                    .service.memory.heap_used_mb, .service.memory.heap_total_mb,
                    .service.memory.external_mb ] | @csv
                else empty end' >> "$csv" 2>/dev/null || true
        sleep "$SAMPLE_INTERVAL"
    done
}

sample_docker_stats() {
    local file="$1" cid="$2"
    # Separador interno `|`: nenhum campo do `docker stats` contem virgula
    # (`.MemUsage` vem como `75.27MiB / 1GiB`), entao trocar `|` por `,` na
    # escrita produz CSV de 5 colunas de verdade.
    echo "ts,cpu_pct,mem_usage,mem_pct,pids" > "$file"
    while :; do
        local line
        line="$(docker stats --no-stream \
            --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' "$cid" 2>/dev/null || true)"
        if [ -n "$line" ]; then
            printf '%s,%s\n' "$(date -Is)" "$(printf '%s' "$line" | tr '|' ',')" >> "$file"
        fi
        sleep "$SAMPLE_INTERVAL"
    done
}

wait_ready() {
    local cid="$1" tries=60
    while [ "$tries" -gt 0 ]; do
        if curl -fsS -m 5 "${BASE_URL}/readiness" >/dev/null 2>&1; then
            return 0
        fi
        tries=$((tries - 1))
        sleep 2
    done
    docker logs --tail=30 "$cid" 2>&1 || true
    return 1
}

node_processes() {
    local cid="$1" n
    # `grep -c` imprime 0 E devolve status 1 quando nao casa; com `|| echo "?"`
    # o log dizia "0?" -- dois numeros para a mesma pergunta. O `?` e para o
    # caso de o proprio `docker exec` falhar, que e o que a medicao precisa
    # distinguir de "zero processo".
    #
    # O `.*` antes de `dist/app.js` e obrigatorio: com o rastro de GC o
    # processo e `node --trace-gc dist/app.js`, e o padrao `node dist/app.js`
    # (ou `node .*app.js`, que casaria `node src/app.ts` do ambiente de dev)
    # contava zero e a medicao seguia publicando "1 processo" sem ter contado.
    #
    # O `^node` e o que exclui o dumb-init: o ENTRYPOINT da imagem e
    # `dumb-init -- node ...`, que aparece na mesma `ps` e casaria o padrao,
    # fazendo a medicao anunciar o dobro de processos.
    n="$(docker exec "$cid" sh -c \
        'ps -o args 2>/dev/null | grep -cE "^node .*dist/app\.js"' 2>/dev/null)" || n=""
    if ! printf '%s' "$n" | grep -qE '^[0-9]+$'; then
        echo "?"
    else
        echo "$n"
    fi
}

purge_rate_limits() {
    local cid keys key
    cid="$(compose_plain ps -q redis || true)"
    [ -n "$cid" ] || return 0
    # A senha e lida DENTRO do container, como no healthcheck do compose. O
    # arquivo em `secrets/deps` pertence ao uid 1001 (--for-container) e o
    # usuario do host nao o abre - e nao precisa: quem roda a medicao nao tem
    # que ler a senha do Redis para limpar um contador.
    # SCAN, nunca KEYS: KEYS bloqueia o servidor durante a varredura.
    keys="$(redis_cli "$cid" --scan --pattern 'rl_*')"
    [ -n "$keys" ] || return 0
    printf '%s\n' "$keys" | while read -r key; do
        [ -n "$key" ] || continue
        redis_cli "$cid" UNLINK "$key" >/dev/null 2>&1 || true
    done
    log_pass "chaves rl_* removidas do Redis (o limite de producao voltou ao normal)"
}

# Cliente redis-cli autenticado, com a senha lida de dentro do container.
#
# `--pass` em vez de REDISCLI_AUTH: o redis-cli 7 IGNORA a variavel de ambiente
# quando `--user` tambem esta setado, e responde NOAUTH. Esse bug era invisivel
# aqui porque o `2>/dev/null` engolia o erro e o cleanup "passava" sem apagar
# nada -- o que deixava o orcamento de rate limit inflado sobrevivendo a
# medicao. A senha continua vindo de dentro do container, e nao do host.
#
# `-n 1`: o ACL do Redis da aplicacao so autoriza o db 1.
redis_cli() {
    local cid="$1"; shift
    docker exec "$cid" sh -c '
        exec redis-cli --no-auth-warning --user auth-service \
            -a "$(cat /run/secrets/redis-password)" -n 1 "$@"' _ "$@" 2>/dev/null
}

purge_test_users() {
    local cid
    cid="$(compose_plain ps -q mongodb || true)"
    [ -n "$cid" ] || return 0
    # Mesma razao do Redis: as credenciais ficam dentro do container do Mongo,
    # e o RUN_ID vai por ambiente para nao passar pela linha de comando.
    docker exec -e "K6_RUN_ID=$RUN_ID" "$cid" sh -c '
        mongosh --quiet --host 127.0.0.1 \
            --username "$MONGO_APP_USER" \
            --password "$(cat "$MONGO_APP_PASSWORD_PATH")" \
            --authenticationDatabase admin "$MONGO_APP_DB" \
            --eval "db.users.deleteMany({ username: { \$regex: \"^k6(user|reg)_\" + process.env.K6_RUN_ID } }).deletedCount"' \
        2>/dev/null || true
}

teardown() {
    local code=$?
    if [ "$KEEP_STACK" = "1" ]; then
        log_warn "--keep-stack: o servico fica com o orcamento de medicao ativo"
        log_warn "  devolva com: docker compose --env-file $ENV_FILE -f $COMPOSE_PROD up -d $SERVICE"
        return "$code"
    fi
    log_step "Teardown: devolvendo o container ao .env.prod"
    purge_rate_limits || log_warn "nao foi possivel limpar as chaves rl_* do Redis"
    compose_plain up -d --force-recreate "$SERVICE" >/dev/null 2>&1 || true
    return "$code"
}

# ------------------------------------------------------------------
log_step "1/4 · Subindo o servico com o orcamento de medicao"

# O trap entra ANTES do primeiro `compose up`, e nao depois da readiness. O
# motivo e concreto: se o container nao sobe ou nao fica pronto -- um
# `NODE_OPTIONS` invalido, por exemplo -- o `fail` sai antes de um trap
# instalado mais abaixo, e o servico fica parado no orcamento de medicao, ou
# em crash-loop, ate alguem lembrar de rodar o teardown a mao. A medicao nao
# pode custar ao ambiente o estado de producao.
trap teardown EXIT

FIRST_WORKERS="${WORKERS_LIST%%,*}"
compose "$FIRST_WORKERS" up -d --force-recreate "$SERVICE" >/dev/null
CID="$(compose "$FIRST_WORKERS" ps -q "$SERVICE")"
[ -n "$CID" ] || fail "o container do $SERVICE nao subiu"
wait_ready "$CID" || fail "$SERVICE nao ficou pronto"
log_pass "$(node_processes "$CID") processo(s) node, /readiness 200"

# ------------------------------------------------------------------
log_step "2/4 · Semeando o pool de login (${USER_COUNT} usuarios, fora de medicao)"

seeded=0
for i in $(seq 0 $((USER_COUNT - 1))); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
        -H 'Content-Type: application/json' \
        -X POST "${BASE_URL}/register" \
        -d "{\"user\":\"k6user_${RUN_ID}_${i}\",\"password\":\"${SEED_PASSWORD}\"}")"
    [ "$code" = "201" ] && seeded=$((seeded + 1))
done
log_pass "${seeded}/${USER_COUNT} usuarios semeados"

# ------------------------------------------------------------------
log_step "3/4 · Matriz de carga"

for workers in ${WORKERS_LIST//,/ }; do
    if [ "$workers" != "$FIRST_WORKERS" ] || [ "${WORKERS_LIST//,/ }" != "$FIRST_WORKERS" ]; then
        compose "$workers" up -d --force-recreate "$SERVICE" >/dev/null
        CID="$(compose "$workers" ps -q "$SERVICE")"
        wait_ready "$CID" || fail "$SERVICE nao ficou pronto (workers=$workers)"
        log_pass "workers=${workers}: $(node_processes "$CID") processo(s) node, /readiness 200"
    fi

    case_seq=0
    for endpoint in ${ENDPOINTS_LIST//,/ }; do
        for vus in ${VUS_LIST//,/ }; do
            # Um CASE_ID por invocacao: o nome do usuario de /register precisa
            # ser unico dentro do RUN_ID, senao o nivel de VUs seguinte
            # refaz o cadastro anterior e a metade das respostas vira 400.
            case_seq=$((case_seq + 1))
            stamp="$(date +%Y%m%d_%H%M%S)"
            # O teto entra no nome: sem ele, uma corrida com disjuntor e outra
            # sem ele escrevem no mesmo arquivo e a tabela mostra a ultima.
            tag="w${workers}_${endpoint}_v${vus}_if${MAX_IN_FLIGHT}_${stamp}"
            log_file="${OUT_DIR}/k6_${tag}.log"

            echo
            log_step "  workers=${workers} endpoint=/${endpoint} vus=${vus}"

            gc_since="$(gc_window_since)"
            sample_memory "${OUT_DIR}/mem_${tag}.csv" &
            mem_pid=$!
            sample_docker_stats "${OUT_DIR}/stats_${tag}.csv" "$CID" &
            stats_pid=$!

            # `--user` com o uid do host: a imagem do k6 roda como usuario
            # proprio e nao escreveria o `k6_*.json` num bind mount do host.
            docker run --rm --network host \
                --user "$(id -u):$(id -g)" \
                -v "${REPO_ROOT}/k6:/k6:ro" \
                -v "${REPO_ROOT}/${OUT_DIR}:/out" \
                -e "BASE_URL=${BASE_URL}" \
                -e "ENDPOINTS=${endpoint}" \
                -e "VUS=${vus}" \
                -e "DURATION=${DURATION}" \
                -e "RAMP_UP=${RAMP_UP}" \
                -e "RAMP_DOWN=${RAMP_DOWN}" \
                -e "REGISTER_ITERATIONS=${REGISTER_ITERATIONS}" \
                -e "RUN_ID=${RUN_ID}" \
                -e "CASE_ID=${case_seq}" \
                -e "USER_COUNT=${USER_COUNT}" \
                -e "METRICS_TOKEN=${METRICS_TOKEN}" \
                -e "SUMMARY_JSON=/out/k6_${tag}.json" \
                -e "K6_SUMMARY_TREND_STATS=avg,min,med,max,p(90),p(95),p(99)" \
                -e "K6_NO_COLOR=true" \
                "$K6_IMAGE" run "/k6/capacity-baseline.js" > "$log_file" 2>&1 || true

            kill "$mem_pid" "$stats_pid" 2>/dev/null || true
            wait "$mem_pid" "$stats_pid" 2>/dev/null || true
            capture_gc_log "$CID" "$gc_since" "${OUT_DIR}/gc_${tag}.log" | sed 's/^/   /'

            if [ -f "${OUT_DIR}/k6_${tag}.json" ]; then
                tail -n 2 "$log_file" | head -1 | sed 's/^/   /'
            else
                log_warn "k6 nao produziu resumo; ultimas linhas de ${log_file}"
                tail -n 15 "$log_file" || true
            fi
        done
    done
done

# ------------------------------------------------------------------
log_step "4/4 · Consolidando"

python3 "$REPO_ROOT/scripts/capacity-summary.py" "$OUT_DIR" > "${OUT_DIR}/summary.md"
log_pass "tabela crua em ${OUT_DIR}/summary.md"
log_pass "resumo k6 por corrida em ${OUT_DIR}/k6_*.json"

purge_test_users
log_pass "usuarios de teste removidos do Mongo"

echo
log_pass "matriz concluida"
