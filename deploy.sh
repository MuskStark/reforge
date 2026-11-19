#!/usr/bin/env bash
# =============================================================
# ReForge — 流程再造工程收集表 · Docker 一键部署脚本
# 中国环境友好：Go / npm / Alpine 依赖默认走国内镜像
#   覆盖方式：环境变量 GOPROXY / NPM_REGISTRY / ALPINE_MIRROR
# 用法：
#   bash deploy.sh            # 构建镜像并启动（首次/更新）
#   bash deploy.sh --no-cache # 忽略缓存重新构建
#   bash deploy.sh --down     # 停止并移除容器（数据卷保留）
#   bash deploy.sh --logs     # 跟踪日志
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
PROJECT="flow-prod"

# —— 中国镜像（可用环境变量覆盖为官方源）——
GOPROXY_MIRROR="${GOPROXY:-https://goproxy.cn,direct}"
NPM_MIRROR="${NPM_REGISTRY:-https://registry.npmmirror.com}"
ALPINE_MIRROR="${ALPINE_MIRROR:-mirrors.tuna.tsinghua.edu.cn}"

COMPOSE=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")
NO_CACHE=""
MODE="deploy"

for arg in "$@"; do
  case "$arg" in
    --down) MODE="down" ;;
    --logs) MODE="logs" ;;
    --no-cache) NO_CACHE="--no-cache" ;;
    -h|--help) MODE="help" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

banner() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }

case "$MODE" in
  help)
    sed -n '2,14p' "$0"
    exit 0
    ;;
  down)
    banner "停止并移除容器（数据卷保留）"
    "${COMPOSE[@]}" down
    exit 0
    ;;
  logs)
    "${COMPOSE[@]}" logs -f --tail=100
    exit 0
    ;;
esac

# ---- 前置检查 ----
command -v docker >/dev/null 2>&1 || { echo "未检测到 docker，请先安装并启动 Docker"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 未运行，请启动 Docker Desktop / 守护进程"; exit 1; }

banner "环境信息（中国镜像加速）"
echo "GOPROXY      : $GOPROXY_MIRROR"
echo "NPM registry : $NPM_MIRROR"
echo "Alpine mirror: $ALPINE_MIRROR"
echo "提示：若拉取 golang/node/postgres 基础镜像缓慢，请在 Docker 守护进程"
echo "      配置 registry-mirrors（如 https://docker.m.daocloud.io）后重试。"

# ---- 构建并启动 ----
banner "构建镜像（首次较慢，依赖走国内镜像）"
# shellcheck disable=SC2086
"${COMPOSE[@]}" build $NO_CACHE \
  --build-arg GOPROXY="$GOPROXY_MIRROR" \
  --build-arg NPM_REGISTRY="$NPM_MIRROR" \
  --build-arg ALPINE_MIRROR="$ALPINE_MIRROR"

banner "启动服务"
"${COMPOSE[@]}" up -d

# ---- 健康等待 ----
banner "等待服务就绪"
wait_url() {
  local url="$1" name="$2" i=0 max=60
  until curl -sf -o /dev/null "$url"; do
    i=$((i + 1))
    if [ "$i" -ge "$max" ]; then
      echo "$name 未在 ${max}x2s 内就绪，请执行 bash deploy.sh --logs 排查"
      exit 1
    fi
    sleep 2
    printf "."
  done
  echo ""
  echo "$name 就绪 ✓"
}

wait_url "http://127.0.0.1:3000/" "前端页面"
wait_url "http://127.0.0.1:3000/api/health" "后端连通（经前端代理，端到端）"

banner "部署完成"
echo "前台收集页   : http://localhost:3000"
echo "管理后台     : http://localhost:3000/admin   （默认 admin / flow123）"
echo "后端 API     : http://127.0.0.1:8080/api/health （容器网络内部互访）"
echo "数据         : PostgreSQL（卷 flow-prod-pgdata 持久化）"
echo "常用命令     : bash deploy.sh --logs ｜ --down"
