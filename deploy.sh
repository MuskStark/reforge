#!/usr/bin/env bash
# =============================================================
# ReForge — 流程再造工程收集表 · Ubuntu Docker 一键部署脚本
# 兼容 Ubuntu 22.04 / 24.04 / 26.04（apt 传统源与 deb822 格式均支持）
# =============================================================
# 功能：
#   1. 环境自检与自动安装（curl/git、Docker CE、Compose 插件，
#      自动配置国内 apt 源与 Docker Hub 镜像加速）
#   2. 中国地区深度优化：apt 清华源、Docker Hub 镜像加速、
#      Go/npm/Alpine 依赖国内镜像、基础镜像预拉取、ufw 防火墙放行
#   3. 构建镜像 → 启动 PostgreSQL + 后端 + 前端 → 健康等待 → 输出地址 → 公网自检
#
# 用法：
#   bash deploy.sh              # 完整部署（默认，中国镜像加速）
#   bash deploy.sh --check      # 仅环境检测/安装，不部署
#   bash deploy.sh --global     # 海外环境：全部使用官方源
#   bash deploy.sh --skip-install # 只检测不自动安装缺失组件
#   bash deploy.sh --no-cache   # 忽略构建缓存
#   bash deploy.sh --down       # 停止并移除容器（数据卷保留）
#   bash deploy.sh --logs       # 跟踪日志
#
# 镜像源可用环境变量覆盖：GOPROXY / NPM_REGISTRY / ALPINE_MIRROR /
# APT_MIRROR / DOCKER_MIRROR
# 公网自检(可选):.env 设置 FLOW_PUBLIC_URL=https://你的域名 后,部署结束会经该地址
# 取回页面与本次构建核对;CDN 仍在发旧页面或缓存了 HTML 时给出处理办法
# =============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
PROJECT="flow-prod"

# ---------- 参数解析 ----------
MODE="deploy"
CHINA=1
NO_CACHE=""
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --global) CHINA=0 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --no-cache) NO_CACHE="--no-cache" ;;
    --down) MODE="down" ;;
    --logs) MODE="logs" ;;
    --check) MODE="check" ;;
    -h|--help) MODE="help" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# ---------- 镜像源（默认中国，--global 切官方） ----------
if [ "$CHINA" = 1 ]; then
  GOPROXY_MIRROR="${GOPROXY:-https://goproxy.cn,direct}"
  NPM_MIRROR="${NPM_REGISTRY:-https://registry.npmmirror.com}"
  ALPINE_MIRROR="${ALPINE_MIRROR:-mirrors.tuna.tsinghua.edu.cn}"
  APT_MIRROR="${APT_MIRROR:-mirrors.tuna.tsinghua.edu.cn}"
  DOCKER_MIRROR="${DOCKER_MIRROR:-docker.m.daocloud.io}"
else
  GOPROXY_MIRROR="${GOPROXY:-https://proxy.golang.org,direct}"
  NPM_MIRROR="${NPM_REGISTRY:-https://registry.npmjs.org}"
  ALPINE_MIRROR="${ALPINE_MIRROR:-dl-cdn.alpinelinux.org}"
  APT_MIRROR=""
  DOCKER_MIRROR=""
fi

# ---------- 基础工具 ----------
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
run_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else $SUDO "$@"; fi
}
has_cmd() { command -v "$1" >/dev/null 2>&1; }

banner() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }

IS_UBUNTU=0
grep -qi ubuntu /etc/os-release 2>/dev/null && IS_UBUNTU=1

MODE_HELP_TEXT="$(sed -n '5,20p' "$0")"

# =============================================================
case "$MODE" in
  help) printf "%s\n" "$MODE_HELP_TEXT"; exit 0 ;;
  down)
    banner "停止并移除容器（数据卷保留）"
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down
    exit 0
    ;;
  logs)
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs -f --tail=100
    exit 0
    ;;
esac

# =============================================================
# 环境检测与安装
# =============================================================
banner "环境检测"

# 1) 系统信息
if [ -f /etc/os-release ]; then . /etc/os-release; fi
echo "系统      : ${PRETTY_NAME:-未知} $(uname -m)"
echo "中国优化   : $([ "$CHINA" = 1 ] && echo 开启 || echo 关闭)"
echo "当前用户   : $(id -un) $([ "$(id -u)" = 0 ] && echo '(root)' || echo "(sudo: $(has_cmd sudo && echo 可用 || echo 不可用))")"

# 2) apt 清华源优化（仅 Ubuntu + 中国模式；原配置自动备份 .bak）
#    24.04+ 默认为 deb822 格式（/etc/apt/sources.list.d/ubuntu.sources），
#    与传统 sources.list 同样处理；同时覆盖 cn./us. 等区域前缀主机
if [ "$CHINA" = 1 ] && has_cmd apt-get && [ "$IS_UBUNTU" = 1 ]; then
  if grep -rqs -e "archive.ubuntu.com" -e "security.ubuntu.com" \
      /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    banner "apt 源切换到清华 TUNA 镜像（原配置备份为 .bak）"
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
      [ -f "$f" ] || continue
      case "$f" in *.bak|*.save|*.distUpgrade) continue ;; esac
      if grep -qs -e "archive.ubuntu.com" -e "security.ubuntu.com" "$f"; then
        $SUDO cp -n "$f" "$f.bak" 2>/dev/null || true
        $SUDO sed -i -E \
          -e "s|https?://([a-z]+\.)*archive\.ubuntu\.com|https://${APT_MIRROR}|g" \
          -e "s|https?://([a-z]+\.)*security\.ubuntu\.com|https://${APT_MIRROR}|g" "$f"
      fi
    done
    $SUDO apt-get update -qq && echo "apt 源已更新 ✓"
  fi
fi

# 3) 基础工具（curl/git）
if ! has_cmd curl || ! has_cmd git; then
  banner "安装基础工具（curl / git / ca-certificates）"
  if has_cmd apt-get; then
    $SUDO apt-get install -y curl git ca-certificates
  else
    echo "缺少 curl/git 且系统无 apt-get，请手动安装"; exit 1
  fi
fi

# 4) Docker CE + Compose 插件
install_docker() {
  banner "安装 Docker CE（$([ "$CHINA" = 1 ] && echo '阿里云镜像源' || echo '官方源')）"
  if ! has_cmd apt-get || [ "$IS_UBUNTU" = 0 ]; then
    echo "非 Ubuntu 系统请参考官方文档安装 Docker: https://docs.docker.com/engine/install/"; exit 1
  fi
  # --global 用官方源，默认（中国模式）走阿里云镜像
  local repo="https://download.docker.com/linux/ubuntu"
  [ "$CHINA" = 1 ] && repo="https://mirrors.aliyun.com/docker-ce/linux/ubuntu"
  local codename="${VERSION_CODENAME:-$(grep VERSION_CODENAME= /etc/os-release | cut -d= -f2 | tr -d '"')}"
  # 26.04(resolute) 起主流镜像站已提供对应发行版；
  # 若所选源暂缺当前代号的 Release，回退到上一个 LTS（noble）保证可安装
  if ! curl -fsSI --max-time 10 "$repo/dists/$codename/Release" >/dev/null 2>&1; then
    echo "⚠ Docker 源暂无 $codename 发行版，回退到 noble（上一个 LTS）"
    codename="noble"
  fi
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "$repo/gpg" | $SUDO tee /etc/apt/keyrings/docker.asc >/dev/null
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
$repo $codename stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
  $SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true
  echo "已将 $(id -un) 加入 docker 组；如仍提示无权限，请重新登录后重试"
}

if has_cmd docker; then
  echo "Docker    : $(docker --version)"
else
  if [ "$SKIP_INSTALL" = 1 ]; then
    echo "未安装 Docker（--skip-install 已跳过自动安装），请先安装后重试"; exit 1
  fi
  install_docker
fi

# Docker 守护进程运行中？
if ! docker info >/dev/null 2>&1; then
  banner "启动 Docker 守护进程"
  if has_cmd systemctl; then
    $SUDO systemctl start docker 2>/dev/null || true
    sleep 2
  fi
  docker info >/dev/null 2>&1 || { echo "Docker 仍不可用，请手动启动 Docker 后重试"; exit 1; }
fi
echo "Compose   : $(docker compose version 2>/dev/null || echo '未安装')"

# 5) Compose 插件缺失补装
if ! docker compose version >/dev/null 2>&1; then
  if [ "$SKIP_INSTALL" = 1 ]; then
    echo "缺少 docker compose 插件（--skip-install 已跳过自动安装）"; exit 1
  fi
  banner "安装 docker-compose-plugin"
  if has_cmd apt-get; then
    $SUDO apt-get install -y docker-compose-plugin
  else
    echo "请手动安装 Docker Compose v2"; exit 1
  fi
fi

# 6) 中国优化：Docker Hub 镜像加速写入 daemon.json（仅 Linux + 未配置时）
if [ "$CHINA" = 1 ] && [ "$(uname -s)" = "Linux" ]; then
  if ! docker info 2>/dev/null | grep -qi "docker.m.daocloud.io"; then
    banner "配置 Docker Hub 镜像加速（daemon.json）"
    $SUDO install -m 0755 -d /etc/docker
    if [ -f /etc/docker/daemon.json ] && grep -qs "registry-mirrors" /etc/docker/daemon.json; then
      echo "已存在 registry-mirrors 配置，跳过"
    else
      $SUDO cp -n /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true
      printf '%s\n' \
        '{' \
        '  "registry-mirrors": [' \
        '    "https://docker.m.daocloud.io",' \
        '    "https://docker.1ms.run"' \
        '  ]' \
        '}' | $SUDO tee /etc/docker/daemon.json > /dev/null
      $SUDO systemctl restart docker 2>/dev/null || true
      sleep 2
      echo "已配置镜像加速并重启 Docker（如有其它运行中容器会短暂重启）"
    fi
  fi
fi

# 7) 中国优化：基础镜像经镜像源预拉取（避免 Docker Hub 直连卡死）
if [ "$CHINA" = 1 ] && [ -n "$DOCKER_MIRROR" ]; then
  banner "基础镜像预拉取（经 ${DOCKER_MIRROR}）"
  for img in golang:1.27-alpine node:22-alpine alpine:3.20 postgres:16-alpine; do
    if docker image inspect "$img" >/dev/null 2>&1; then
      echo "$img 已存在 ✓"
    else
      echo "拉取 $img ..."
      docker pull "$DOCKER_MIRROR/library/$img" 2>/dev/null \
        && docker tag "$DOCKER_MIRROR/library/$img" "$img" \
        && echo "$img ✓" \
        || echo "⚠ $img 预拉取失败，构建时将直连尝试"
    fi
  done
fi

# 8) ufw 防火墙放行前端端口
if has_cmd ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
  $SUDO ufw allow 3000/tcp >/dev/null 2>&1 || true
  echo "ufw 已放行 3000/tcp ✓"
fi

# 9) docker 权限包装（无 docker 组权限时走 sudo）
DCMD=(docker)
if ! docker info >/dev/null 2>&1 && [ -n "$SUDO" ]; then
  DCMD=($SUDO docker)
fi

banner "环境就绪"
echo "Go 模块源   : $GOPROXY_MIRROR"
echo "npm 源      : $NPM_MIRROR"
echo "Alpine 源   : $ALPINE_MIRROR"
[ -n "$DOCKER_MIRROR" ] && echo "Docker Hub 加速: $DOCKER_MIRROR"

case "$MODE" in
  check)
    banner "环境检测完成（--check 模式，未部署）"
    echo "如需继续部署，请执行: bash deploy.sh"
    exit 0
    ;;
esac

# =============================================================
# 构建与部署
# =============================================================
COMPOSE=("${DCMD[@]}" compose -p "$PROJECT" -f "$COMPOSE_FILE")

# ---------- 安全秘密引导(F04/F08):生成/补齐 .env,弱默认不再随生产生效 ----------
# .env 固定放在脚本所在目录:compose 只从编排文件所在目录读它,与当前工作目录无关
ENV_FILE="$ROOT/.env"
gen_secret() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "POSTGRES_PASSWORD=$(gen_secret)"
    echo "FLOW_ADMIN_USER=admin"
    echo "FLOW_ADMIN_PASS=$(gen_secret)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE(数据库与管理员强口令,请妥善保管,勿提交入库)"
else
  grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE" || { echo "POSTGRES_PASSWORD=$(gen_secret)" >> "$ENV_FILE"; echo "已在 .env 补齐 POSTGRES_PASSWORD"; }
  grep -q '^FLOW_ADMIN_PASS='   "$ENV_FILE" || { echo "FLOW_ADMIN_PASS=$(gen_secret)" >> "$ENV_FILE"; echo "已在 .env 补齐 FLOW_ADMIN_PASS"; }
  grep -q '^FLOW_ADMIN_USER='   "$ENV_FILE" || echo "FLOW_ADMIN_USER=admin" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ---------- F10:镜像摘要锚定(部署时解析,网络不可达则降级 tag 并告警) ----------
pin_image() {
  local img="$1" digest
  digest=$(docker buildx imagetools inspect "$img" --format '{{.Manifest.Digest}}' 2>/dev/null | head -1)
  if [ -n "$digest" ] && [[ "$digest" == sha256:* ]]; then
    echo "${img}@${digest}"
  else
    echo "[warn] 未能解析 $img 的摘要(网络受限),降级为可变 tag —— 供应链完整性未锚定" >&2
    echo "$img"
  fi
}
GOLANG_PINNED=$(pin_image golang:1.27-alpine)
ALPINE_PINNED=$(pin_image alpine:3.20)
NODE_PINNED=$(pin_image node:22-alpine)

banner "构建镜像（首次较慢，依赖走国内镜像；基础镜像已尝试摘要锚定）"
# shellcheck disable=SC2086
"${COMPOSE[@]}" build $NO_CACHE \
  --build-arg GOPROXY="$GOPROXY_MIRROR" \
  --build-arg NPM_REGISTRY="$NPM_MIRROR" \
  --build-arg ALPINE_MIRROR="$ALPINE_MIRROR" \
  --build-arg GOLANG_IMAGE="$GOLANG_PINNED" \
  --build-arg ALPINE_IMAGE="$ALPINE_PINNED" \
  --build-arg NODE_IMAGE="$NODE_PINNED"

banner "启动服务"
"${COMPOSE[@]}" up -d

# ---------- 健康等待（端到端） ----------
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
echo "管理后台     : http://localhost:3000/admin   ——凭据见 .env(FLOW_ADMIN_USER / FLOW_ADMIN_PASS)"
echo "后端 API     : 经前端 /api 代理访问（容器网络内部互访）"
echo "数据         : PostgreSQL（卷 ${PROJECT}_flow-prod-pgdata 持久化）"
echo "常用命令     : bash deploy.sh --logs ｜ --down"

# ---------- 公网自检:经 CDN 取回的页面必须是本次构建 ----------
# CDN 一旦缓存了 HTML,部署后旧 HTML 引用的 chunk 在源站已不存在,用户直接白屏。
# 脚本没有 CDN 的 API 凭据,无法自动清除缓存,这里只核对并给出处理办法。
env_file_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true; }
# 取 HTML 引用的 _next/static 资源集合,作为“哪一次构建”的指纹
build_fingerprint() { grep -o '/_next/static/[^"<> ]*' | sort -u || true; }

check_public_page() {
  # 注意:循环变量不叫 path —— zsh 下 path 与 PATH 绑定,赋值会清空命令搜索路径
  local page="$1" url="$2" dir="$3" local_fp public_fp cf code
  local_fp=$(curl -fsS -m 10 "http://127.0.0.1:3000$page" 2>/dev/null | build_fingerprint)
  if [ -z "$local_fp" ]; then
    echo "⚠ $page:本机未取到页面,跳过公网核对"
    return 0
  fi
  if ! curl -sS -m 20 -D "$dir/headers" -o "$dir/body" "$url" 2>/dev/null; then
    echo "⚠ $page:无法访问 $url,跳过公网核对"
    return 0
  fi
  # curl -D 写出的响应头是 CRLF 换行,取值前去掉 \r
  code=$(head -1 "$dir/headers" 2>/dev/null | tr -d '\r' | awk '{print $2}' || true)
  cf=$(grep -i '^cf-cache-status:' "$dir/headers" 2>/dev/null | tr -d '\r' | tail -1 | awk '{print tolower($2)}' || true)
  public_fp=$(build_fingerprint < "$dir/body" || true)
  if [ "$code" != "200" ] || [ -z "$public_fp" ]; then
    echo "⚠ $page:公网地址没有返回本站页面(HTTP ${code:-无响应}),请检查 FLOW_PUBLIC_URL"
  elif [ "$public_fp" != "$local_fp" ]; then
    echo "✗ $page:公网页面不是本次构建 —— CDN 还在发旧页面,打开会白屏"
    echo "    处理:到 Cloudflare 面板 Caching → Configuration → Purge Everything 清一次缓存"
  elif [ -n "$cf" ] && [ "$cf" != "dynamic" ] && [ "$cf" != "bypass" ]; then
    echo "✗ $page:页面已是本次构建,但 CDN 正在缓存这个页面的 HTML(cf-cache-status: $cf)"
    echo "    隐患:下次部署后又会白屏。到 Cloudflare 面板关闭该路径的 Cache Rule"
  else
    echo "✓ $page:公网页面与本次构建一致"
  fi
}

banner "公网自检"
if [ -z "${FLOW_PUBLIC_URL:-}" ]; then
  FLOW_PUBLIC_URL=$(env_file_value FLOW_PUBLIC_URL)
  # 容错 .env 里给值加的成对引号
  FLOW_PUBLIC_URL="${FLOW_PUBLIC_URL#\"}"; FLOW_PUBLIC_URL="${FLOW_PUBLIC_URL%\"}"
  FLOW_PUBLIC_URL="${FLOW_PUBLIC_URL#\'}"; FLOW_PUBLIC_URL="${FLOW_PUBLIC_URL%\'}"
fi
FLOW_PUBLIC_URL="${FLOW_PUBLIC_URL%/}"
if [ -z "$FLOW_PUBLIC_URL" ]; then
  echo "未设置 FLOW_PUBLIC_URL,跳过。在 .env 里加上 FLOW_PUBLIC_URL=https://你的域名,"
  echo "以后部署结束会自动核对公网页面是否已是本次构建。"
else
  echo "经 $FLOW_PUBLIC_URL 取回页面,与本机 127.0.0.1:3000 核对"
  tmp=$(mktemp -d)
  # 后台核对 /admin/processes 而不是 /admin:后者现在只是跳到第一个分区的重定向,
  # 没有页面内容,取不到构建指纹会被当成"本机未取到页面"而跳过核对
  for page in / /admin/processes; do
    check_public_page "$page" "$FLOW_PUBLIC_URL$page" "$tmp"
  done
  rm -rf "$tmp"
fi
