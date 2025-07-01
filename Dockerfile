# ====================================
# DOCKERFILE MULTI-STAGE OTIMIZADO
# Authentication Microservice
# ====================================

# =====================================
# STAGE 1: Base com dependências comuns
# =====================================
FROM node:22-alpine AS base

# Instalar dependências do sistema
RUN apk add --no-cache \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Criar usuário não-root
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001 -G nodejs

# Definir diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# =====================================
# STAGE 2: Build de dependências
# =====================================
FROM base AS dependencies

# Instalar todas as dependências (dev + prod)
RUN npm ci --include=dev

# Copiar código fonte
COPY . .

# Executar testes (opcional - pode ser feito no CI)
# RUN npm run test:unit:fast

# =====================================
# STAGE 3: Produção otimizada
# =====================================
FROM base AS production

# Definir variáveis de ambiente de produção
ENV NODE_ENV=production
ENV PORT=3000

# Instalar apenas dependências de produção
RUN npm ci --only=production && npm cache clean --force

# Copiar código da aplicação
COPY --from=dependencies --chown=nodeuser:nodejs /app/src ./src
COPY --from=dependencies --chown=nodeuser:nodejs /app/package*.json ./

# Criar diretórios necessários
RUN mkdir -p logs && chown -R nodeuser:nodejs logs

# Trocar para usuário não-root
USER nodeuser

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Labels para metadados
LABEL maintainer="Auth Team <auth@company.com>"
LABEL description="Authentication Microservice"
LABEL version="1.0.0"

# Comando de inicialização
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/app.js"]

# =====================================
# STAGE 4: Development
# =====================================
FROM dependencies AS development

ENV NODE_ENV=development

# Instalar nodemon globalmente
RUN npm install -g nodemon

# Trocar para usuário não-root
USER nodeuser

# Expor porta e porta de debug
EXPOSE 3000 9229

# Comando para desenvolvimento
CMD ["nodemon", "--inspect=0.0.0.0:9229", "src/app.js"]
