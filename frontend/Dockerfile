# syntax=docker/dockerfile:1
# ReForge 前端：Next.js standalone 多阶段构建（中国镜像加速，可用 --build-arg 覆盖）

ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
# corepack 走 npmmirror 下载 pnpm
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN npm config set registry ${NPM_REGISTRY} \
  && corepack enable \
  && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
# BACKEND_ORIGIN 会在构建期被编译进 rewrites（routes-manifest），必须构建时注入
ARG BACKEND_ORIGIN=http://backend:8080
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    BACKEND_ORIGIN=${BACKEND_ORIGIN}
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runner
# BACKEND_ORIGIN：容器内经 Next.js rewrites 代理到后端服务
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Shanghai \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BACKEND_ORIGIN=http://backend:8080
WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
