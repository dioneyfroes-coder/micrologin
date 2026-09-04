Área	Antes	Agora
Organização	8	8,5
Arquitetura	7	8
Segurança	5,5	7
JWT	5,5	7,5
Testes	6,5	6,5
Docker/infra	6	6,5
Documentação	6	8
Coerência interna	6	6,5
Portfólio	8	8,5
Produção	4,5	6


## Checklist dos últimos toques

- [x] **Unificar a política de senha**
	- Mínimo de 12 caracteres aplicado no validador compartilhado, middleware, domínio, modelo, rotas e documentação.
	- Validado pela suíte de testes.

- [x] **Escolher um único sistema JWT**
	- `JWTTokenService` é o único serviço usado pelo bootstrap.
	- `JWTAdapter` legado foi removido.
	- Login retorna `accessToken` e `refreshToken`.

- [x] **Corrigir o Swagger**
	- Documentados `accessToken`, `refreshToken`, `tokenType` e `expiresIn`.
	- O esquema Bearer identifica explicitamente o access token.

- [x] **Separar completamente erros de domínio dos erros HTTP**
	- Erros de domínio agora usam `DomainError`.
	- Falhas inesperadas não atravessam mais o domínio via `error.message`.
	- `HttpError` e `errorHandler` padronizam status, código, mensagem e detalhes das respostas HTTP.

- [x] **Fazer a última busca por legado**
	- Removidos arquivos sem referências da arquitetura antiga, incluindo `src/core/domain.js`, `src/models/User.js` e a antiga pasta `src/config`.
	- Nenhuma referência ativa ao `JWTAdapter` foi encontrada.

### Validação

- [x] 4 suítes executadas
- [x] 15 testes passando
- [x] Contrato do error handler coberto por testes
- [x] Corrigir os problemas preexistentes do lint geral