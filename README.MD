# 🔐 Microserviço de Autenticação

Olá! 👋 Sou **Dioney Froes**, desenvolvedor fullstack, e este é meu projeto de um microserviço de autenticação enterprise construído com Node.js. 

Este projeto foi desenvolvido entre **Junho e julho de 2025** com a valiosa assistência da IA do GitHub Copilot, demonstrando como a colaboração entre humanos e IA pode criar soluções robustas e escaláveis.

**O que você encontrará aqui:**
- Sistema de autenticação JWT completo e seguro
- Arquitetura hexagonal bem estruturada  
- Clustering automático para alta performance
- Sistema de segurança avançado com monitoramento de ameaças
- Testes automatizados abrangentes
- Documentação completa e prática

## 🎯 **Por que Este Projeto?**

Como desenvolvedor fullstack, sempre busquei criar soluções que não apenas funcionem, mas que sejam **verdadeiramente prontas para produção**. Este microserviço nasceu da necessidade de ter um sistema de autenticação que pudesse:

- Escalar automaticamente conforme a demanda
- Resistir a ataques e tentativas de invasão
- Ser facilmente mantido e expandido
- Fornecer observabilidade completa para troubleshooting

### **🚀 Performance & Escalabilidade**
- **Clustering automático** - aproveita todos os cores da CPU disponíveis
- **Load balancing** nativo do Node.js entre workers
- **Cache Redis** para tokens JWT (com fallback em memória)
- **Rate limiting** inteligente que se adapta à carga
- **Compressão** de resposta para reduzir latência

### **🔒 Segurança que Funciona de Verdade**
Não é só sobre JWT e bcrypt. Implementei um sistema completo que:
- **Monitora ameaças** em tempo real (XSS, SQLi, DDoS, path traversal)
- **Bloqueia IPs suspeitos** automaticamente
- **Sanitiza todas as entradas** recursivamente
- **Auditoria completa** de eventos de segurança
- **Dashboard próprio** para monitoramento (/security/*)
- **Headers de segurança** otimizados com Helmet

### **📊 Observabilidade que Salva Vidas**
Quando algo dá errado (e sempre dá), você precisa saber **exatamente** o que aconteceu:
- **Métricas Prometheus** detalhadas de performance
- **Logs estruturados** com contexto por worker
- **Health check** inteligente que testa dependências
- **Tracing** completo de requisições para debug

### **🛠️ Arquitetura que Faz Sentido**
Apliquei **arquitetura hexagonal** (ports & adapters) porque acredito que código bom é código que você consegue entender 6 meses depois:
- **Core isolado** com lógica de negócio pura
- **Dependency Injection** real, não gambiarra
- **Configuração centralizada** que não te deixa louco
- **Graceful shutdown** porque aplicação que trava é dor de cabeça

### **⚡ Ferramentas de Desenvolvimento**
- **Hot reload** com PM2 (salva tempo de desenvolvimento)
- **ESLint** configurado (mantém o código limpo)
- **Docker** pronto para usar (funciona na minha máquina E na sua)
- **Testes automatizados** que realmente testam coisas importantes


## ⚙️ **Configuração Rápida**

```bash
# 1. Clone o repositório
git clone https://github.com/dioney/microservices-auth.git
cd microservices-auth

# 2. Instale as dependências  
npm install

# 3. Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas configurações

# 4. Inicie os serviços (MongoDB + Redis)
docker-compose up -d

# 5. Rode em desenvolvimento
npm run dev

# 6. Acesse a documentação
# https://localhost:3000/api-docs
```

### **📋 Variáveis de Ambiente Essenciais**

```env
# JWT Configuration (OBRIGATÓRIO)
JWT_SECRET=your-super-secret-jwt-key-here-minimum-32-chars
JWT_EXPIRES=6h

# Database (OBRIGATÓRIO)  
URI_MONGODB=mongodb://admin:password@localhost:27017/auth?authSource=admin

# Redis Cache (OPCIONAL - tem fallback em memória)
REDIS_HOST=localhost
REDIS_PORT=6379

# Server
PORT=3000
NODE_ENV=development

# Rate Limiting (OPCIONAL - tem valores padrão)
RATE_LIMIT_IP_POINTS=100
RATE_LIMIT_LOGIN_POINTS=5
```

## 📖 **API Documentation**

### **📍 Endpoints Disponíveis**

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| `POST` | `/login` | Autenticação do usuário | ❌ |
| `POST` | `/register` | Registro de novo usuário | ❌ |
| `GET` | `/profile` | Dados do usuário logado | ✅ |
| `PUT` | `/update` | Atualizar perfil | ✅ |
| `DELETE` | `/delete` | Remover conta | ✅ |
| `GET` | `/metrics` | Métricas Prometheus | ❌ |
| `GET` | `/health` | Health check do serviço | ❌ |

```bash
# 1. Login
curl -X POST https://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"user": "admin", "password": "senha123"}' \
  -k
```

### **📚 Swagger UI**

Acesse a documentação interativa completa:
- **Desenvolvimento:** https://localhost:3000/api-docs
- **Produção:** https://your-domain.com/api-docs

### **📝 Exemplos de Request/Response**

<details>
<summary><strong>POST /register</strong></summary>

```javascript
// Request
{
  "user": "novo_usuario",
  "password": "senhaSegura123"
}

// Response 201
{
  "message": "Usuário registrado com sucesso"
}

// Response 409 (Conflict)
{
  "message": "Usuário já existe."
}
```

## 🏗️ **Como Está Organizado**

Passei um tempo pensando na estrutura porque acredito que projeto bem organizado é projeto que escala. Aqui está o que você vai encontrar:

```
src/
├── 🚀 app.js                    # Ponto de entrada + clustering
├── 🧠 core/                     # Coração da aplicação
│   ├── domain.js               # Entidades e regras de negócio
│   ├── bootstrap.js            # DI container e configuração  
│   └── ServiceContainer.js     # Gerenciamento de dependências
├── 🔌 adapters/                 # Implementações de infraestrutura
│   └── index.js                # Adapters para crypto, tokens, logs
├── 🌐 web/                      # Camada de apresentação HTTP
│   ├── AuthController.js       # Controllers HTTP
│   └── AuthMiddleware.js       # Middleware de autenticação
├── ⚙️  config/                  # Configurações centralizadas
│   ├── appConfig.js            # Configuração principal
│   ├── env.js                  # Validação de ambiente
│   ├── cache.js                # Setup Redis
│   ├── passport.js             # Estratégia de autenticação
│   └── swagger.js              # Documentação API
├── 🛡️  middleware/              # Middlewares de segurança
│   ├── securityMonitoring.js   # Detecção de ameaças
│   ├── securityAudit.js        # Auditoria de eventos
│   ├── advancetRateLimit.js    # Rate limiting inteligente
│   └── sanitization.js         # Limpeza de entrada
├── 📊 models/                   # Modelos de dados
│   └── User.js                 # Schema do usuário
├── 🛤️  routes/                  # Definição de rotas
│   ├── authRoutes.js           # Rotas de autenticação
│   └── securityRoutes.js       # Dashboard de segurança
└── 🔧 utils/                    # Utilitários
    ├── metrics.js              # Métricas Prometheus
    ├── healthCheck.js          # Verificação de saúde
    └── errorHandler.js         # Tratamento de erros
```

### **🤔 Por que Arquitetura Hexagonal?**

Porque já cansei de ver projetos onde você não consegue testar nada sem subir o banco inteiro. Aqui:
- **Core** não sabe que HTTP existe (pode virar CLI amanhã)
- **Adapters** fazem a ponte com o mundo externo
- **Testes** são rápidos porque mockam apenas as bordas
- **Mudanças** de infraestrutura não quebram a lógica de negócio

### **⚖️ Como Funciona o Load Balancing**

O Node.js faz isso automaticamente com cluster, mas é legal entender:

```javascript
// Com 4 cores = 4 workers rodando em paralelo
Worker 1: Processa requisições 1, 5, 9, 13...
Worker 2: Processa requisições 2, 6, 10, 14...  
Worker 3: Processa requisições 3, 7, 11, 15...
Worker 4: Processa requisições 4, 8, 12, 16...

// Resultado: 4x mais requisições simultâneas! 🚀
```

## 📊 **Monitoramento na Prática**

### **🎯 Métricas que Realmente Importam**

Acesse `https://localhost:3000/metrics` e você vai ver:

```prometheus
# Saúde do sistema
nodejs_eventloop_lag_seconds          # Se estiver alto, tem problema
nodejs_process_cpu_seconds_total      # Uso de CPU
nodejs_process_resident_memory_bytes  # Memória consumida

# Performance da aplicação  
http_requests_total                   # Quantas requests por segundo
http_request_duration_seconds         # Tempo médio de resposta
auth_failed_logins_total              # Tentativas de invasão
```

### **� Dashboard de Segurança (Meu Orgulho)**

Construí endpoints próprios porque as ferramentas prontas nunca fazem exatamente o que você precisa:

- `GET /security/stats` - Estatísticas em tempo real
- `GET /security/report` - Relatório detalhado com recomendações  
- `GET /security/events` - Últimos eventos de segurança
- `GET /security/threats` - Análise de ameaças ativas
- `GET /security/health` - Status dos sistemas de segurança

### **� Logs que Fazem Sentido**

```bash
# Acompanhar em tempo real
pm2 logs autenticacao --lines 100

# Exemplo do que você vai ver:
📥 [Worker 12345] POST /login processado em 45ms
� [Security] IP 192.168.1.100 bloqueado - tentativas de SQLi
✅ [Auth] Login bem-sucedido para usuário: admin
📊 [Metrics] Request rate: 250/min, Error rate: 0.2%
```

## 🧪 **Testes que Funcionam**

Acredito que teste bom é teste que falha quando deve falhar. Aqui temos:

### **📋 O que Está Coberto**

**Testes Unitários (50 testes)**
- Lógica de negócio isolada
- Validações de entrada  
- Transformações de dados
- Casos extremos e edge cases

**Testes de Integração (16 testes)**
- Fluxo completo de autenticação
- Integração com banco de dados
- Segurança de endpoints
- Validação de headers

**Testes de Carga (Artillery)**
- 4.000+ logins simultâneos
- Distribuição entre workers
- Comportamento sob stress
- Rate limiting real

### **🚀 Como Executar**

```bash
# Executar tudo (minha preferência para CI)
npm run test:all

# Apenas unitários (rápido para desenvolvimento)  
npm run test:unit

# Apenas integração (quando mudo APIs)
npm run test:integration

# Teste de carga (final de sprint)
npm run test:load

# Cobertura de código (para ver o que falta)
npm run test:coverage
```

### **💡 Dica Importante**
Os testes rodam com `NODE_ENV=test` e usam MongoDB em memória. Ou seja, não vão bagunçar seu ambiente de desenvolvimento.

## ✅ **STATUS DO PROJETO**

### **🎯 Sistema Pronto para Produção**
- ✅ **66 testes automatizados** (100% passando)
  - 50 testes unitários
  - 16 testes de integração  
  - Testes de carga (4.000+ requisições simultâneas)
- ✅ **Arquitetura hexagonal** implementada
- ✅ **Segurança corporativa** avançada
- ✅ **Clustering** com 4 workers
- ✅ **Monitoramento** completo
- ✅ **Documentação** Swagger

### **📊 Métricas de Performance**
```
✅ Core isolado com DI
✅ Adapters implementados  
✅ Bootstrap funcional
✅ Configuração centralizada
✅ Zero dependências circulares
✅ Rate limiting: IP + Login + Global
✅ Detecção de ameaças: XSS, SQLi, DDoS
✅ Dashboard: 6 endpoints REST
```

---

## 🤝 **Contribuindo**

Encontrou um bug? Tem uma sugestão? Abra uma issue ou faça um pull request. Feedback é sempre bem-vindo!

## 📄 **Licença**

MIT License - sinta-se livre para usar este código em seus projetos.

---

**Desenvolvido por Dioney Froes** | Junho - Julho 2025 | Com GitHub Copilot  
🚀 *Transformando ideias em código que funciona*
