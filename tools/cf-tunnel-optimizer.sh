#!/usr/bin/env bash
# =============================================================
# CF Tunnel 全服务优选 IP 自动换优(cron: 周日 03:00)
# 依赖:cfst(CloudflareSpeedTest)+ AdGuard Home API
# 泛化:更新单条通配符重写 *.summer.fan → 全部 tunnel 服务同时切换
# 部署:flow 服务器 /opt/reforge/tools/(凭据经 /opt/reforge/.adguard.env)
# =============================================================
set -euo pipefail

ADGUARD_URL="${ADGUARD_URL:-http://10.5.20.14}"
. /opt/reforge/.adguard.env          # ADGUARD_USER= / ADGUARD_PASS=
ZONE_DOMAINS="${ZONE_DOMAINS:-summer.fan infinia.fyi}"   # 通配符重写的域(空格分隔,全 tunnel 服务)
CFST_DIR="${CFST_DIR:-/opt/cfst}"
LOG="/var/log/cfst-optimize.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 1) 复测(延迟上限 220ms 兜底,按均值选优,HKG 优先)
cd "$CFST_DIR"
./cfst -tl 220 -t 4 -dn 5 -dt 4 -p 8 -o /tmp/cfst-result.csv -f ip.txt >> "$LOG" 2>&1
BEST=$(awk -F, 'NR>1 && $5>0 {print $1"|"$5"|"$7}' /tmp/cfst-result.csv \
  | sort -t'|' -k2 -n | awk -F'|' '$3=="HKG"{print $1; exit} END{}' )
[ -z "$BEST" ] && BEST=$(awk -F, 'NR>1 && $5>0 {print $1"|"$5}' /tmp/cfst-result.csv | sort -t'|' -k2 -n | head -1 | cut -d'|' -f1)
[ -z "$BEST" ] && { log "无可用 IP,保持现状"; exit 0; }

# 2) 健壮性验证:优选 IP 必须真的能服务本 zone(经 SNI 直连任一 tunnel 域名)
PROBE_HOST=$(grep '^TUNNEL_PROBE_HOST=' /opt/reforge/.adguard.env 2>/dev/null | cut -d= -f2 || echo "flow.${ZONE_DOMAIN}")
if ! curl -s -o /dev/null -m 10 --resolve "$PROBE_HOST:443:$BEST" "https://$PROBE_HOST/api/health" \
   && ! curl -s -o /dev/null -m 10 --resolve "$PROBE_HOST:443:$BEST" "https://$PROBE_HOST/"; then
  log "候选 $BEST 无法服务本 zone,放弃更换"; exit 0
fi

# 3) 更新 AdGuard 各域通配符重写(先删旧再添新,幂等)
AUTH=(-u "$ADGUARD_USER:$ADGUARD_PASS")
for ZONE_DOMAIN in $ZONE_DOMAINS; do
  curl -s "${AUTH[@]}" -X POST "$ADGUARD_URL/control/rewrite/delete" \
    -H 'Content-Type: application/json' -d "{\"domain\":\"*.$ZONE_DOMAIN\"}" >/dev/null || true
  curl -s "${AUTH[@]}" -X POST "$ADGUARD_URL/control/rewrite/add" \
    -H 'Content-Type: application/json' -d "{\"domain\":\"*.$ZONE_DOMAIN\",\"answer\":\"$BEST\"}" >/dev/null
  log "已切换 *.${ZONE_DOMAIN} → $BEST"
done
echo "$BEST" > /tmp/cfst-current-ip
