# 🔐 Microserviço de Autenticação

Um microserviço de autenticação **enterprise-grade** construído com Node.js, Express e JWT. Inclui clustering, cache Redis, métricas Prometheus e documentação Swagger completa.

## 🎯 **Características Principais**

### **🚀 Performance & Escalabilidade**
- **Clustering automático** - utiliza todos os cores da CPU
- **Load balancing** interno do Node.js
- **Cache Redis** para tokens JWT
- **Rate limiting** avançado
- **Compression** habilitada

### **🔒 Segurança**
- **JWT** com expiração configurável
- **Bcrypt** para hash de senhas
- **HTTPS** obrigatório
- **Rate limiting** por IP
- **Validação** rigorosa de entrada

### **📊 Observabilidade**
- **Métricas Prometheus** completas
- **Logs estruturados** por worker
- **Health monitoring** integrado
- **Request tracing** detalhado

### **🛠️ Operacional**
- **Graceful shutdown** implementado
- **Error handling** robusto
- **Hot reload** com PM2

### **🚢 CI/CD & DevOps**
- **Pipeline GitHub Actions** completo
- **Docker multi-stage** build otimizado
- **Testes automatizados** (unitários, integração, carga)
- **Security scanning** com Trivy
- **Deploy blue-green** para staging/production
- **Backup/restore** automatizado
- **Performance testing** integrado
- **Docker ready**


```env
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRES=6h

# Database
URI_MONGODB=mongodb://admin:password@localhost:27017/auth?authSource=admin

# Redis Cache
REDIS_HOST=localhost
REDIS_PORT=6379

# Server
PORT=3000
NODE_ENV=production

# Rate Limiting
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX=50
LOGIN_LIMIT_MAX=5
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

## 🏗️ **Arquitetura**

### **🗂️ Estrutura do Projeto**

```
src/
├── app.js                 # Aplicação principal + clustering
├── config/                # Configurações
│   ├── cache.js          # Redis setup
│   ├── database.js       # MongoDB connection
│   ├── passport.js       # Authentication strategy
│   ├── rateLimiting.js   # Rate limiting config
│   └── swagger.js        # API documentation
├── controllers/          # Business logic
│   └── authController.js # Auth operations
├── middleware/           # Express middlewares
│   ├── auth.js          # JWT verification
│   ├── requestLogger.js # Request logging
│   └── validation.js    # Input validation
├── models/              # Database models
│   └── User.js         # User schema
├── routes/             # API routes
│   └── authRoutes.js  # Authentication routes
└── utils/             # Utilities
    ├── errorHandler.js # Error handling
    └── metrics.js     # Prometheus metrics
```

### **⚖️ Load Balancing**

O Node.js Cluster distribui automaticamente as requisições:

```javascript
// 4 CPU cores = 4 workers
Worker 1: Handles requests 1, 5, 9, 13...
Worker 2: Handles requests 2, 6, 10, 14...
Worker 3: Handles requests 3, 7, 11, 15...
Worker 4: Handles requests 4, 8, 12, 16...
```

---

## 📊 **Monitoramento**

### **🎯 Métricas Prometheus**

Acesse: https://localhost:3000/metrics

```prometheus
# Métricas do sistema
nodejs_eventloop_lag_seconds          # Event loop lag
nodejs_process_cpu_seconds_total      # CPU usage
nodejs_process_resident_memory_bytes  # Memory usage

# Métricas da aplicação
http_requests_total                   # Total requests
http_request_duration_seconds         # Request duration
app_start_time_seconds               # Application uptime
```

### **📊 Observabilidade**
- **Métricas Prometheus** completas
- **Logs estruturados** por worker  
- **Health check endpoint** (`/health`) ✅
- **Dependency monitoring** (MongoDB, Redis)
- **Resource monitoring** (CPU, Memory, Uptime)
- **Request tracing** detalhado


### **📊 Logs Estruturados**

```bash
# PM2 logs em tempo real
pm2 logs autenticacao --lines 100

# Exemplo de log
📥 Worker 12345 processou: POST /login
📊 Métrica registrada: POST /login 200
✅ Login bem-sucedido. Token gerado: eyJ...
```

## 🙏 **Agradecimentos**

- **Express.js** - Framework web
- **Passport.js** - Estratégias de autenticação
- **Prometheus** - Sistema de métricas
- **MongoDB** - Banco de dados NoSQL
- **Redis** - Cache em memória

---
