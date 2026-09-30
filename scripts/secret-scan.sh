#!/usr/bin/env bash
# ===================================================================
# Verifica que material de segredo nao entrou no repositorio
# ===================================================================
# Duas checagens, porque elas falham de jeitos diferentes:
#
#   1. gitleaks acha segredo pelo FORMATO, mesmo dentro de um arquivo que
#      ninguem achou que fosse material (um `.env.example` preenchido "so para
#      testar", um log de debug, um script de deploy). Ele varre o historico
#      inteiro, entao tambem acha o que foi commitado e depois apagado — que e
#      o caso que mais dói, porque apagar o arquivo não apaga o blob.
#
#   2. A lista de arquivos RASTREADOS pega o caso opaco: um `.pem` de chave
#      privada, um `redis-app.acl`, um dump de `docker inspect`. Aqui não há
#      formato a reconhecer: o arquivo simplesmente não deveria estar no
#      índice do git, e o `.gitignore` sozinho não impede `git add -f`.
#
# O `.gitignore` é a primeira linha de defesa, não a prova: ele não protege
# contra `git add -f`, contra quem usa outro cliente, nem contra o material que
# entrou antes dele existir. Por isso a verificação é um passo de CI.
# ===================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITLEAKS_VERSION="${GITLEAKS_VERSION:-v8.24.0}"
GITLEAKS_IMAGE="ghcr.io/gitleaks/gitleaks:${GITLEAKS_VERSION}"

cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# Arquivos de exemplo são a parte legítima de `.env*`: precisam existir, mas só
# podem conter placeholders. Qualquer outro `.env*` rastreado é material.
ALLOWED_ENV_FILES='^(\.env\.example|\.env\.prod\.example)$'

log_step() { echo -e "${YELLOW}$1${NC}"; }
log_pass() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }

# ------------------------------------------------------------------
echo -e "${YELLOW}══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW} Varredura de segredo${NC}"
echo -e "${YELLOW}══════════════════════════════════════════════════════${NC}"

# ------------------------------------------------------------------
log_step "1/3 · gitleaks no conteúdo e no histórico"

if [ "${SECRET_SCAN_SKIP_GITLEAKS:-0}" = "1" ]; then
    log_warn "SECRET_SCAN_SKIP_GITLEAKS=1: conteúdo e histórico não foram varridos"
    log_warn "  (as checagens de arquivo e de .env versionado continuam valendo)"
elif has_cmd gitleaks; then
    gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
    log_pass "gitleaks: nenhum segredo no conteúdo nem no histórico"
elif has_cmd docker; then
    # A mesma imagem do CI, então o resultado local e o do pipeline não divergem
    # por versão. O repo entra só para leitura, e o `--config` é explícito
    # porque o gitleaks procura a configuração no diretório de trabalho: sem ele,
    # a varredura local usaria a allowlist padrão e acusaria os placeholders de
    # teste, ou seja, um resultado diferente do que o CI decide.
    docker run --rm -v "${REPO_ROOT}:/repo" -w /repo "$GITLEAKS_IMAGE" \
        detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner
    log_pass "gitleaks (${GITLEAKS_IMAGE}): nenhum segredo no conteúdo nem no histórico"
else
    # Sem gitleaks e sem docker não dá para afirmar nada sobre o conteúdo. A
    # prova aqui é a checagem de arquivos, e ela roda mesmo assim — mas quem
    # roda isso em CI precisa saber que o gitleaks não cobriu o histórico.
    log_warn "gitleaks e docker ausentes: a varredura de conteúdo e histórico foi PULADA"
    log_warn "  (instale o gitleaks ou rode com docker; o CI usa ${GITLEAKS_IMAGE})"
fi

# ------------------------------------------------------------------
log_step "2/3 · arquivos de material rastreados pelo git"

# `git ls-files`, e não `ls`: o que interessa é o índice, não o disco. O diretório
# de chaves pode existir localmente (e precisa existir para o app rodar) sem que
# isso seja um problema — o problema é ele estar versionado.
TRACKED_SUSPECTS="$(git ls-files \
    | grep -Ei '(^|/)(keys?|secrets?|\.resilience-(keys|deps))(/|$)|\.pem$|\.key$|\.crt$|\.p12$|\.jks$|id_(rsa|ed25519)$|\.acl$' \
    || true)"

if [ -n "$TRACKED_SUSPECTS" ]; then
    echo -e "${RED}Estes arquivos de material estão versionados:${NC}" >&2
    echo "$TRACKED_SUSPECTS" >&2
    fail "remova do índice (git rm --cached <arquivo>) e rotacione o segredo: ele está no histórico"
fi
log_pass "nenhuma chave, certificado, ACL ou diretório de segredo está versionado"

# ------------------------------------------------------------------
# ------------------------------------------------------------------
log_step "3/3 · nenhuma credencial real nos .env* versionados"

# Um exemplo é legítimo por nome, então a checagem de arquivos não pega o jeito
# mais comum de vazar: alguém cola a chave de verdade no `.env.example` e segue
# a vida. A pergunta aqui é estreita de propósito — só variável cujo NOME é de
# credencial (SECRET, PASSWORD, TOKEN, PEPPER, KEY, CREDENTIAL) pode conter
# valor. `PORT=3000` e `CLUSTER_WORKERS=4` não são segredo e não têm por que
# se disfarçar de um.
#
# Valores aceitos: vazio (o app recusa subir, é o placeholder mais honesto),
# caminho de arquivo (`*_PATH=/run/secrets/...` — o segredo não está no .env, está
# no arquivo montado) e os placeholders da casa.
TRACKED_ENVS="$(git ls-files | grep -E '(^|/)\.env' || true)"

# Primeiro o estrutural: nenhum `.env*` além dos dois exemplos.
UNEXPECTED_ENVS="$(echo "$TRACKED_ENVS" | grep -Ev "$ALLOWED_ENV_FILES" || true)"
if [ -n "$UNEXPECTED_ENVS" ]; then
    echo -e "${RED}Estes arquivos .env* estão versionados e não são exemplo:${NC}" >&2
    echo "$UNEXPECTED_ENVS" >&2
    fail "um .env versionado leva segredo para o histórico do repositório"
fi
log_pass "só .env.example e .env.prod.example estão versionados"

# O texto de um placeholder da casa. Vazio entra: o app recusa subir sem pepper
# nem token, e isso é o certo.
is_placeholder() {
    case "$1" in
        '') return 0 ;;
        troque-*|your-*|seu-*|sua-*|SEU-*|SUA-*|CHANGE*|TODO*|exemplo*|example*|x??*|'...'*|'*'|'<'*'>'|'$'*) return 0 ;;
    esac
    return 1
}

# Agora o de conteúdo: valor de credencial que não é placeholder nem caminho.
# A varredura é linha a linha em shell, e não `grep -nE`, por um motivo concreto:
# o `-n` prefixa `148:` na linha e quebra qualquer âncora `^` — o resultado era
# uma verificação que não achava nada e portanto nunca falhava. Portão que não
# fecha é pior que portão nenhum, porque passa a impressão de que fecha.
CREDENTIAL_SUSPECTS=""
while IFS= read -r file; do
    [ -n "$file" ] || continue
    lineno=0
    while IFS= read -r raw || [ -n "$raw" ]; do
        lineno=$((lineno + 1))
        # Comentário ou linha sem atribuição: fora.
        case "$raw" in
            [A-Z0-9_]*=*) ;;
            *) continue ;;
        esac

        var="${raw%%=*}"
        value="${raw#*=}"

        # Só o NOME decide se a variável é de credencial. `PORT` e
        # `CLUSTER_WORKERS` não têm por que se disfarçar de segredo.
        case "$var" in
            *SECRET*|*PASSWORD*|*TOKEN*|*PEPPER*|*PRIVATE*|*API_KEY*|*CREDENTIAL*|*KEY*) ;;
            *) continue ;;
        esac

        # `*_PATH` aponta para o material montado: o arquivo `.env` carrega o
        # caminho, não o segredo. `*_VERSION` é metadado do envelope (`p1`,
        # `p2`), não credencial — e um `p1` não abre nenhum hash.
        case "$var" in
            *_PATH|*_DIR|*_VERSION) continue ;;
        esac

        if ! is_placeholder "$value"; then
            CREDENTIAL_SUSPECTS="${CREDENTIAL_SUSPECTS}${file}:${lineno}: ${var}=${value}"$'\n'
        fi
    done < "$file"
done <<< "$TRACKED_ENVS"

if [ -n "$CREDENTIAL_SUSPECTS" ]; then
    echo -e "${RED}Valor de credencial sem placeholder em arquivo versionado:${NC}" >&2
    echo "$CREDENTIAL_SUSPECTS" >&2
    fail "ou é segredo de verdade (rotacione), ou é exemplo que precisa dizer que é exemplo"
fi
log_pass "toda credencial dos exemplos está vazia, é caminho de arquivo ou placeholder"

echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN} Nenhum segredo versionado.${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
