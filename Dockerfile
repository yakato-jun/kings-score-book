# Next.js 15 (standalone) → Cloud Run 用イメージ。
# 機密(.env.local / private/)は .dockerignore で除外＝イメージに焼き込まない。
# 実行時の秘密(MONGODB_URI/ANTHROPIC_API_KEY/SITE_PASSWORD)は Cloud Run の Secret Manager 注入で渡す。

# ---- deps: 依存だけ先に入れてキャッシュ ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: next build（output:standalone）----
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# ビルドは DB/API に接続しない(getDb は request 時 lazy)ので秘密は不要。
RUN npm run build

# ---- runner: standalone 出力だけを載せた最小イメージ ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run は $PORT を注入(既定 8080)。standalone の server.js は PORT/HOSTNAME を尊重。
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
RUN groupadd -r nodejs && useradd -r -g nodejs -m nextjs
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
