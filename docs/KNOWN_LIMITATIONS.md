# Limitações Conhecidas — Micrologin 1.0.0

Este documento registra limitações, riscos aceitos e restrições intencionais para a versão 1.0.0. O objetivo é ser explícito sem prometer garantias que estão fora do escopo do projeto demonstrativo.

---

## 1. Dependência do Redis para sessão e revogação

- **Dependência crítica:** A revogação de refresh tokens, o controle de sessionVersion e partes da política de invalidação de sessões dependem do Redis. Sem acesso ao Redis, o serviço não consegue manter o estado necessário para aplicar essas verificações.
- **Perda completa do estado:** Se o volume do Redis for perdido (ex.: apagamento não planejado, falha catastrófica do datastore) e não houver backup, as informações de sessão/revogação não podem ser recuperadas. Tokens emitidos anteriormente que ainda sejam válidos pelo formato/assinatura continuarão a ser aceitos apenas se o estado correspondente não existir mais — mas o mecanismo de verificação consulta o Redis; em um estado zerado, a lista de tokens revogados ou versões de sessão é vazia.
- **Impacto:** Após perda total do Redis, sessões ativas que dependiam de bloqueio por sessionVersion/revogação perdem a capacidade de serem invalidadas por esses gatilhos até que novas sessões sejam criadas com o novo estado.
- **Recuperação:** Restaurar o dump de backup do Redis (RDB/AOF) para o ponto mais recente disponível. Se não houver backup, o estado é considerado perdido — o serviço pode ser reiniciado com Redis vazio e as sessões existentes precisarão ser invalidadas pelo fluxo normal (expiração). Consulte docs/BACKUP.md e docs/REDIS.md.
- **Mitigações existentes:** Documentação de backup/restore, testes de persistência (scripts/test-redis-persistence.sh) e scripts relacionados (scripts/backup.sh, scripts/restore.sh). Veja também docs/BACKUP.md.

---

## 2. Sem MFA (Multi-Factor Authentication)

Fora do escopo da 1.0.0. Autenticação é baseada apenas em e-mail/usuário + senha.

---

## 3. Sem OAuth/OpenID Connect

Não há integração com provedores externos nesta versão.

---

## 4. Sem recuperação de senha

Não há fluxo 'esqueci minha senha' nesta versão. A recuperação deve ser feita por meio administrativo no modelo demonstrativo.

---

## 5. Ambiente demonstrativo

Este projeto tem fins de estudo, portfólio e validação arquitetural. Não é necessariamente otimizado para todos os cenários de produção sem ajustes adicionais (observabilidade, alertas, hardening específico do ambiente, etc.).

---

## 6. Logout = invalidação de todas as sessões

Conforme definido na política de autenticação, o endpoint de logout (POST /auth/logout) invalida todas as sessões do usuário (via incremento de sessionVersion). Não existe logout por dispositivo/sessão individual nesta versão. Veja README.md e src/application/routes/authRoutes.ts.

---

## 7. Argon2 e concorrência

O Argon2 pode rejeitar requisições sob alta concorrência quando a fila atinge o limite configurado. Este é um trade-off de segurança (prevenção de DoS/brute-force) — o comportamento é intencional e testado.

---

## 8. Alinhamento de plataforma (Windows vs Linux)

Suporte local no Windows foi alinhado ao CI/Linux. As correções abaixo preservam o comportamento do CI, que segue sendo a fonte da verdade:

- **Permissões POSIX (600):** as suítes `dependency-secrets-provisioning`, `dependency-secrets-rotation` e `jwt-key-provisioning` validam o modo `0o600`/`0o644` apenas em plataformas POSIX (`process.platform !== 'win32'`). No Windows continuam validando existência e leitura; o assert de modo roda no CI/Linux.
- **Resolução de caminhos ESM:** `ddos-survival-driver` e `replica-session-driver` importam o runner via `pathToFileURL(...).href`, evitando o uso do esquema nativo `c:` no Windows.
- **Ferramentas exigidas para testes locais:** `openssl` (ex.: OpenSSL-Win64) e um `python3` real no PATH (o stub executável do WindowsApps não é válido).
- **Rate limit via Redis em teste:** `login-throttle` e `x-forwarded-for-trust` (integração) fixam `REDIS_ENABLED=false` no `beforeAll`, isolando o teste do Redis local. Não defina `REDIS_ENABLED=false` no shell de toda a suíte: `redis-config`, `redis-cache` e `security-config` esperam o Redis habilitado por padrão.
- **Clone bare em `release-pipeline`:** o repositório bare é criado como irmão único do diretório temporário do teste (`join(tmpdir(), basename + '.git')`), hermético ao working tree — um `git add -A` posterior não o captura, e ele não compartilha lixo entre execuções.

**Exclusão de execução local (requer Docker):** `tests/security/credential-theft.real-redis` (Redis/Mongo na porta 6380) e `tests/e2e/auth-http.e2e` (app na porta 27020) esperam infraestrutura `docker compose up -d`. Sem Docker, rode `tests/unit tests/integration tests/security`: resultado local é 74/75 suítes verdes.


