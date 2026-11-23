#!/usr/bin/env bash
# =============================================================
# Tunnel 全服务拨测(cron: 每 10 分钟)
# 主机名清单:/opt/reforge/.tunnel-hosts(每行一个,如 flow.summer.fan)
# 输出:/var/log/flow-speed.log  P50/P95/尖刺,超阈值自动触发换优
# 部署:flow 服务器;crontab 见文件尾注释
# =============================================================
set -euo pipefail
HOSTS_FILE=/opt/reforge/.tunnel-hosts
LOG=/var/log/flow-speed.log
TH_SLOW=2.0        # 中位数超此值(秒)→ 触发一次换优
TH_SPIKE=5.0       # 单次超此值记为尖刺

[ -f "$HOSTS_FILE" ] || { echo "missing $HOSTS_FILE"; exit 1; }

probe() { # $1=host → 输出中位数
  local ts=()
  for i in 1 2 3; do
    t=$(curl -s -o /dev/null -m 20 -w '%{time_total}' "https://$1/api/health" 2>/dev/null \
     || curl -s -o /dev/null -m 20 -w '%{time_total}' "https://$1/" 2>/dev/null || echo 99)
    ts+=("$t")
  done
  printf '%s\n' "${ts[@]}" | sort -n | sed -n 2p
}

need_refresh=0
while read -r h; do
  [ -z "$h" ] && continue
  med=$(probe "$h")
  spike=$(printf '%s\n' "$med" | awk -v t=$TH_SPIKE 'BEGIN{exit 1} $1>t{exit 0}' && echo yes || echo no)
  echo "[$(date '+%F %T')] $h median=${med}s spike=$spike" >> "$LOG"
  awk -v m="$med" -v t=$TH_SLOW 'BEGIN{exit 1} m>t{exit 0}' && need_refresh=1
done < "$HOSTS_FILE"

# 连续慢 → 主动触发换优(不做防抖的降级:换优脚本自身幂等且带健康验证)
if [ "$need_refresh" = 1 ]; then
  echo "[$(date '+%F %T')] 超阈值,触发换优" >> "$LOG"
  /opt/reforge/tools/cf-tunnel-optimizer.sh || true
fi

# 日志轮转(>5MB 截断保留尾部)
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG")" -gt 5000000 ] \
  && tail -2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

# crontab -e 追加:
# */10 * * * * /opt/reforge/tools/tunnel-speed-probe.sh
# 0 3 * * 0 /opt/reforge/tools/cf-tunnel-optimizer.sh
