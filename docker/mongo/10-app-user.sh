# ===================================================================
# Cria o usuario da aplicacao no MongoDB, com papel de menor privilegio
# ===================================================================
# Roda uma unica vez, na primeira inicializacao do volume, pelo entrypoint
# oficial do Mongo: e ele que cria o root e depois executa o que esta em
# /docker-entrypoint-initdb.d/ com `.` (source), nao como processo separado.
#
# Dois fatos do entrypoint que mudam este script:
#
#   1. quem executa este arquivo e o `mongodb` (uid 999), nao o root. O entrypoint
#      re-executa a si mesmo com esse uid logo no comeco, para nao rodar o
#      servidor como root. Logo, a senha precisa estar legivel por 999.
#   2. o source significa que `set -euo pipefail` aqui continuaria valendo no
#      entrypoint depois deste arquivo. Com `-u`, o `pidfile="$TMPDIR/..."` do
#      proprio entrypoint aborta num container sem TMPDIR, e o banco fica
#      parado na metade do arranque. Por isso: sem `set`, e com `|| exit 1` em
#      cada passo que importa.
#
# O mongod temporario que sobe para a inicializacao roda SEM --auth (o
# entrypoint remove a flag de proposito, senao o proprio root ainda nao
# existiria), entao este script conecta sem credencial.
#
# Por que nao usar o proprio root: o entrypoint cria o root com papel `root`,
# e `root` no Mongo pode ler qualquer banco, criar usuario e desligar o
# servidor. Se o servico usasse essa credencial, um dump do processo do
# auth-service - ou uma conexao vazada de qualquer outro processo do host -
# entregaria controle total do banco. O usuario daqui recebe `readWrite`
# apenas sobre o banco da aplicacao, e a senha vive em arquivo, nao no .env.
#
# As variaveis chegam pelo compose:
#   MONGO_APP_DB             banco onde o usuario pode ler e escrever
#   MONGO_APP_USER           nome do usuario da aplicacao
#   MONGO_APP_PASSWORD_PATH  arquivo com a senha (montado como secret)
#
# A senha entra por variavel de ambiente do shell, e nao na linha de comando:
# argumento de processo aparece em `ps` para qualquer usuario da maquina.
# ===================================================================

APP_DB="${MONGO_APP_DB:-auth}"
APP_USER="${MONGO_APP_USER:-auth-service}"
APP_PASSWORD_PATH="${MONGO_APP_PASSWORD_PATH:-/run/secrets-deps/mongo-app-password}"

if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ] || [ -z "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then
    echo "ERRO: o root do Mongo nao foi criado (faltam MONGO_INITDB_ROOT_USERNAME/PASSWORD)." >&2
    echo "Sem o root este script nao roda e o servico ficaria sem usuario de aplicacao." >&2
    exit 1
fi

if [ ! -r "$APP_PASSWORD_PATH" ]; then
    echo "ERRO: a senha do usuario da aplicacao nao esta legivel em $APP_PASSWORD_PATH." >&2
    echo "Gere os segredos com scripts/generate-dependency-secrets.sh <dir> --for-container" >&2
    echo "e monte esse diretorio no container." >&2
    exit 1
fi

APP_PASSWORD="$(cat "$APP_PASSWORD_PATH")" || exit 1

if [ -z "$APP_PASSWORD" ]; then
    echo "ERRO: a senha em $APP_PASSWORD_PATH esta vazia." >&2
    exit 1
fi

MONGO_SHELL="mongosh"
if ! command -v "$MONGO_SHELL" >/dev/null 2>&1; then
    MONGO_SHELL="mongo"
fi

# `authSource=admin`: a credencial vive no banco `admin`, que e onde o Mongo
# guarda a conta, e e o que o app precisa declarar em MONGODB_AUTH_SOURCE.
# Criar o usuario no banco da aplicacao tambem funciona, mas ai quem enxerga
# aquele banco enxerga a conta - e a lista de usuarios e justamente onde se
# descobre quem tem acesso.
#
# O `if` em vez de `createUser` direto: rodar este script duas vezes (volume
# recriado, imagem reconstruida) nao pode derrubar o banco por causa de um
# "user already exists" que sai depois de o root ja ter sido criado.
MONGO_APP_DB="$APP_DB" \
MONGO_APP_USER="$APP_USER" \
MONGO_APP_PASSWORD="$APP_PASSWORD" \
"$MONGO_SHELL" --quiet --host 127.0.0.1 --port 27017 admin --eval '
    const user = process.env.MONGO_APP_USER;
    const appDb = process.env.MONGO_APP_DB;
    const password = process.env.MONGO_APP_PASSWORD;
    const admin = db.getSiblingDB("admin");

    if (admin.getUser(user)) {
        print("usuario " + user + " ja existe em admin: senha nao alterada");
    } else {
        admin.createUser({
            user: user,
            pwd: password,
            roles: [{ role: "readWrite", db: appDb }]
        });
        print("usuario " + user + " criado em admin com readWrite sobre " + appDb);
    }
' || exit 1

echo "Mongo: usuario da aplicacao pronto (${APP_USER}@admin, readWrite sobre ${APP_DB})."
