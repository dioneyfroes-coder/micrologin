#!/usr/bin/env bash
# ===================================================================
# Gera um par de chaves ES256 (ECDSA P-256) para assinatura de JWT
# ===================================================================
# Por que ECDSA e nao RSA: a chave de assinatura do micro login e curta, o par
# nasce rapido e a assinatura e barata. Isso importa no caminho de login, que e
# exatamente o que a sobrevivencia a DDoS precisa escalar.
#
# Uso:
#   scripts/generate-jwt-keys.sh <diretorio-de-saida> [kid]
#
# Exemplo:
#   scripts/generate-jwt-keys.sh /run/secrets 2026-q3
#
# Gera:
#   <saida>/jwt-es256-private.pem   (modo 600, NUNCA versionar)
#   <saida>/jwt-es256-public.pem    (pode ser distribuída)
#
# A variável de ambiente JWT_ES256_KID identifica a chave no header do token.
# Guarde-a junto da chave: sem o mesmo par nomeado, o token não verifica.
# ===================================================================
set -euo pipefail

OUT_DIR="${1:-./keys}"
KID="${2:-v1}"

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
openssl ecparam -name prime256v1 -genkey -noout -out "$PRIVATE_KEY"
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

echo "Par ES256 verificado."
echo "  kid:  $KID"
echo "  chave privada: $PRIVATE_KEY (modo 600, mantenha fora do repositorio)"
echo "  chave publica:  $PUBLIC_KEY"
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
