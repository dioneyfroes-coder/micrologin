# =====================================
# DOCKERFILE MULTI-STAGE
# Authentication Microservice (TypeScript)
#
# O stage final (default) é PRODUCTION:
#   docker build -t auth-service .          # -> imagem de produção (dist/)
# Para desenvolvimento local (com compose):
#   docker compose build                     # usa --target development
# =====================================

# =====================================
# STAGE 1: Base
# =====================================
FROM node:22-alpine AS base

# Dependências do sistema (dumb-init como PID 1 + curl para healthcheck)
RUN apk add --no-cache \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Usuário não-root
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001 -G nodejs

WORKDIR /app

COPY package*.json ./

# =====================================
# STAGE 2: Build (deps completas + tsc)
# =====================================
FROM base AS build

# Instalar dependências (dev + prod) necessárias para compilar
RUN npm ci --include=dev

# Copiar fonte e compilar com tsc (gera dist/)
COPY . .
RUN npm run build

# =====================================
# STAGE 3: Desenvolvimento (tsx watch + hot reload)
# =====================================
FROM build AS development

ENV NODE_ENV=development

USER nodeuser

EXPOSE 3000

CMD ["npm", "run", "dev"]

# =====================================
# STAGE 4: Produção (apenas dist/ + deps prod) — stage final/default
# =====================================
FROM base AS production

ENV NODE_ENV=production
ENV PORT=3000

# Somente dependências de produção
RUN npm ci --omit=dev && npm cache clean --force

# Artefatos compilados (não copiamos src/ — só dist/)
COPY --from=build --chown=nodeuser:nodejs /app/dist ./dist

RUN mkdir -p logs && chown -R nodeuser:nodejs logs

USER nodeuser

EXPOSE 3000

# Readiness, não /health: o relatório completo responde 503 quando a memória
# passa do limiar, o que marcaria o container como unhealthy sem que ele tenha
# deixado de conseguir atender tráfego.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/readiness || exit 1

LABEL maintainer="Auth Team <auth@company.com>"
LABEL description="Authentication Microservice"
LABEL version="1.0.0"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/app.js"]