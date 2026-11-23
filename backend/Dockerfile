# syntax=docker/dockerfile:1
# ReForge 后端：Go 多阶段构建（中国镜像加速，可用 --build-arg 覆盖）

ARG GOLANG_IMAGE=golang:1.27-alpine
ARG ALPINE_IMAGE=alpine:3.20
FROM ${GOLANG_IMAGE} AS builder
ARG GOPROXY=https://goproxy.cn,direct
# Alpine 镜像源（清华 TUNA，中国加速；海外可传入官方源覆盖）
ARG ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s/dl-cdn.alpinelinux.org/${ALPINE_MIRROR}/g" /etc/apk/repositories \
  && apk add --no-cache ca-certificates tzdata
ENV GOPROXY=${GOPROXY} CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/flow-backend .

FROM ${ALPINE_IMAGE}
ARG ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s/dl-cdn.alpinelinux.org/${ALPINE_MIRROR}/g" /etc/apk/repositories \
  && apk add --no-cache ca-certificates tzdata wget \
  && addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=builder /out/flow-backend /usr/local/bin/flow-backend
RUN mkdir -p /app/data && chown -R app:app /app
WORKDIR /app
USER app
ENV FLOW_ADDR=0.0.0.0:8080 TZ=Asia/Shanghai
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["flow-backend"]
