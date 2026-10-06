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
FROM node:24-alpine AS base

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

# Tirar o npm da imagem de runtime. Ele foi preciso acima, para o `npm ci`, mas
# em runtime o processo e `node dist/app.js` e o npm nao participa de nada.
#
# Nao e limpeza estetica. O Trivy gate do Release 1.0.0 reprovou a imagem com 10
# HIGH, e todas as 10 estavam em `usr/local/lib/node_modules/npm/node_modules/`:
# a arvore que o proprio npm da imagem base embarca, nao o nosso codigo e nao o
# nosso package-lock.json. Nosso node_modules esta limpo (brace-expansion
# 1.1.21, picomatch 2.3.2, ip-address 10.7.2, todos acima da correcao).
#
# E nao dava para corrigir pelo caminho normal. As correcoes exigem pacote
# >=21.5.1 e brace-expansion >=5.0.11; o `npm install -g npm@latest` dentro da
# base resolveria, mas a arvore so e substituida quando o npm publica. E trocar
# a base para node:24, que ja traz npm 11.19.0, NAO resolve: ele embarca
# brace-expansion 5.0.7, e 4 dos 5 CVEs de brace-expansion so fecham a partir
# de 5.0.11.
#
# Remover e a correcao verdadeira: some o codigo vulneravel da imagem em vez de
# silenciar o scanner, e a imagem fica menor.
#
# O stage de build e o de desenvolvimento nao sao afetados — eles herdam de
# `build`, que mantem o npm. So a imagem final perde.
RUN rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/share/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack

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