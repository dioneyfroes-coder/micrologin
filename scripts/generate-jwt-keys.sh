#!/usr/bin/env bash
# ===================================================================
# Gera um par de chaves ES256 (ECDSA P-256) para assinatura de JWT
# ===================================================================
# Por que ECDSA e nao RSA: a chave de assinatura do micro login e curta, o par
# nasce rapido e a assinatura e barata. Isso importa no caminho de login, que e
# exatamente o que a sobrevivencia a DDoS precisa escalar.
#
# Uso:
#   scripts/generate-jwt-keys.sh <diretorio-de-saida> [kid] [--for-container]
#
# Exemplo:
#   scripts/generate-jwt-keys.sh /run/secrets 2026-q3 --for-container
#
# Gera:
#   <saida>/jwt-es256-private.pem   (modo 600, NUNCA versionar)
#   <saida>/jwt-es256-public.pem    (pode ser distribuída)
#
# A variável de ambiente JWT_ES256_KID identifica a chave no header do token.
# Guarde-a junto com a chave: sem o mesmo par nomeado, o token não verifica.
#
# --for-container ajusta o dono do material para o usuário que roda a aplicação
# dentro da imagem (uid 1001, o `nodeuser` do Dockerfile). Necessário sempre que
# o diretório for montado por bind mount: o container enxerga o dono do host, e
# um par em modo 600 do usuário que provisionou vira arquivo ilegível lá dentro —
# o app então recusa arrancar dizendo que a chave "é obrigatória", quando na
# verdade ela está ali e ele não tem permissão de lê-la. Em KMS/secret manager o
# problema não aparece porque o material é entregue já no dono certo.
# ===================================================================
set -euo pipefail

OUT_DIR="${1:-./keys}"
KID="${2:-v1}"

FOR_CONTAINER=0
for arg in "$@"; do
    case "$arg" in
        --for-container) FOR_CONTAINER=1 ;;
        -*) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
    esac
done

# uid do `nodeuser` no Dockerfile. Ajuste aqui se a imagem mudar de uid — é o
# mesmo número que o compose precisa montar legível.
APP_UID="${JWT_KEYS_APP_UID:-1001}"
CHOWN_IMAGE="${JWT_KEYS_CHOWN_IMAGE:-node:24-alpine}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERRO: openssl nao encontrado. Instale openssl para gerar chaves ES256." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
PRIVATE_KEY="$OUT_DIR/jwt-es256-private.pem"
PUBLIC_KEY="$OUT_DIR/jwt-es256-public.pem"

if [ -e "$PRIVATE_KEY" ]; then
    echo "ERRO: $PRIVATE_KEY ja existe." >&2
    echo "Rotacionar uma chave e um ato deliberado: apague a chave antiga apos" >&2
    echo "confirmar que a janela de rotacao (JWT_ES256_PREVIOUS_*) pode encerrar." >&2
    exit 1
fi

# P-256 e o unico curve compativel com o header `alg: ES256`.
#
# `genpkey` (PKCS#8, "BEGIN PRIVATE KEY") e nao `ecparam -genkey` (SEC1, "BEGIN
# EC PRIVATE KEY"). As duas produzem a mesma chave, em formatos de PEM
# diferentes — e o consumidor exige PKCS#8: a biblioteca `jose` recusa SEC1 com
# "must be PKCS#8 formatted string". A falha era silenciosa e atrasada: o par
# passava pela conferência do script, o container subia, e o primeiro login
# respondia 401 de credencial invalida porque a assinatura tinha falhado.
# Um par no formato que o app nao le e um par que so quebra no login.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$PRIVATE_KEY" 2>/dev/null
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" 2>/dev/null

chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"

# Confere o par: chave publica derivada da privada. Um par quebrado passaria
# no STARTUP e so falharia no primeiro login em producao.
if ! openssl pkey -in "$PRIVATE_KEY" -pubout 2>/dev/null | diff -q - "$PUBLIC_KEY" >/dev/null; then
    echo "ERRO: o par gerado nao confere. Nao use esse material." >&2
    rm -f "$PRIVATE_KEY" "$PUBLIC_KEY"
    exit 1
fi

# Confere o formato: o par acima está correto e ainda assim inútil se a
# privada saiu em SEC1, que é o que `openssl ecparam -genkey` produz. A
# assinatura quebra no primeiro login, longe de quem provisionou a chave.
if ! grep -q "BEGIN PRIVATE KEY" "$PRIVATE_KEY"; then
    echo "ERRO: a chave privada nao esta em PKCS#8 (BEGIN PRIVATE KEY)." >&2
    echo "O app importa com jose/importPKCS8 e recusa o formato SEC1. Regere com:" >&2
    echo "  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256" >&2
    rm -f "$PRIVATE_KEY" "$PUBLIC_KEY"
    exit 1
fi

echo "Par ES256 verificado."
echo "  kid:  $KID"
echo "  chave privada: $PRIVATE_KEY (modo 600, mantenha fora do repositorio)"
echo "  chave publica:  $PUBLIC_KEY"

# O chown acontece por um container descartável, e não por `sudo chown` no host:
# exigir privilégio de root para gerar chave tornaria o passo opcional em
# obrigatório na prática, e quem provisiona num CI não tem sudo. O modo 600 é
# preservado — o que muda é o dono, não a exposição.
if [ "$FOR_CONTAINER" -eq 1 ]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERRO: --for-container precisa de docker para ajustar o dono do material." >&2
        exit 2
    fi

    ABS_OUT_DIR="$(cd "$OUT_DIR" && pwd)"
    docker run --rm -v "${ABS_OUT_DIR}:/keys" "$CHOWN_IMAGE" sh -c \
        "chown ${APP_UID}:${APP_UID} /keys/jwt-es256-private.pem /keys/jwt-es256-public.pem \
         && chmod 600 /keys/jwt-es256-private.pem \
         && chmod 644 /keys/jwt-es256-public.pem"

    # Confere o dono de verdade. Um chown que não surtiu efeito (imagem sem
    #Permissions, bind mount de outra origem) só falharia no primeiro login do
    # container, em produção.
    if [ "$(stat -c '%u' "$PRIVATE_KEY")" != "$APP_UID" ]; then
        echo "ERRO: o dono da chave privada continua sendo $(stat -c '%u' "$PRIVATE_KEY"), esperado ${APP_UID}." >&2
        echo "O container não vai conseguir ler a chave. Verifique o bind mount." >&2
        exit 1
    fi

    echo "  dono ajustado para uid ${APP_UID} (o nodeuser da imagem) — legível no container, ainda em modo 600"
fi
echo
echo "Configure o container com os caminhos (a chave privada nao vira texto de config):"
echo "  JWT_ES256_KID=$KID"
echo "  JWT_ES256_PRIVATE_KEY_PATH=$PRIVATE_KEY"
echo "  JWT_ES256_PUBLIC_KEY_PATH=$PUBLIC_KEY"
echo
echo "Para rotacionar sem derrubar quem esta logado, gere o par novo e mantenha"
echo "o anterior na janela:"
echo "  JWT_ES256_KID=$KID"
echo "  JWT_ES256_PREVIOUS_KID=<kid-anterior>"
echo "  JWT_ES256_PREVIOUS_PUBLIC_KEY_PATH=<caminho-da-publica-anterior>"
echo "Depois de expirar os tokens da chave antiga, remova as variaveis PREVIOUS."
