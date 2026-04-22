FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache sqlite-libs tini wget && \
    addgroup -S app && adduser -S -G app app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

RUN mkdir -p /app/data && chown -R app:app /app/data

USER app

ENV NODE_ENV=production \
    APP_PORT=3000 \
    APP_HOST=0.0.0.0 \
    APP_DATABASE_PATH=/app/data/mailsluice.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
