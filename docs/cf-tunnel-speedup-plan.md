# Cloudflare Tunnel 大陆访问优化 · 详细实施计划

> 目标:坚持 Tunnel 架构(零暴露、零入站),在免费套餐内把大陆访问从 1.1~13s 压到 0.5~1.0s。
> 环境:2 个 cloudflared 连接器(Windows ×1、Linux ×1);域名 flow.summer.fan;源站 10.5.20.90(内网)。

## 0. 已测得的事实基线(2026-11-22,办公宽带)

| 指标 | 数值 |
|---|---|
| 当前命中机房 | **LAX(洛杉矶)**,TCP 250~290ms |
| 完整请求 | 中位数 2.6s,劣化时 7~13s(国际链路丢包主导) |
| 全量 IP 扫描(5955 个 CF IP) | 本网络最优 ~**157ms(FRA)/176ms(HKG)**,无 <150ms 的 IP |
| 优选 HKG IP(172.67.197.142)实测 | 中位数 **1.63s vs 默认 2.59s(↓37%)**,最快 1.31s |
| 优选 HKG IP(104.26.1.215)下载 | 3.45MB/s |

**结论**:优选 IP 确定有效(约 4 成改善),但本网络国际出口质量一般,免费套餐物理上限就在这;HTTP/3(QUIC)抗丢包是第二杠杆;两连接器调优是第三杠杆。

## 1. CF 面板开关(你操作 2 分钟,或给我 API Token 代做)

登录 dash.cloudflare.com → 选择 summer.fan 域:

| 位置 | 开关 | 值 |
|---|---|---|
| Speed → Optimization → Protocol Optimization | HTTP/3 (with QUIC) | ✅ 开 |
| Speed → Optimization → Protocol Optimization | 0-RTT Connection Resumption | ✅ 开 |
| Speed → Optimization → Content Optimization | Brotli / Early Hints | ✅ 开(默认已开则不动) |
| SSL/TLS → Edge Certificates | TLS 1.3 | ✅ 开 |
| SSL/TLS → Edge Certificates | Minimum TLS | 1.2(勿设 1.3,老安卓会挂) |
| Caching → Cache Rules | 新建规则 `缓存静态资源` | 匹配 URI Path `/_next/static/*` → Eligible for cache,Edge TTL 1 month |

> Cache Rule 是隐藏大头:Next 的静态 JS/CSS/字体带哈希 immutable,命中后 CF 边缘直接回,不进隧道——首屏二次加载提速显著。

## 2. 优选 IP 落地(我来做)

**选型**:AdGuard Home 跑在 flow 服务器(Docker,不新增机器),全内网统一生效。

1. 部署:`10.5.20.90` 上 Docker 起 AdGuard Home(端口 53/3001 管理)
2. 重写规则:`flow.summer.fan A → 172.67.197.142`(HKG,176ms);备份 `104.26.1.215`(HKG,3.4MB/s)
3. 路由器 DHCP:DNS 下发 `10.5.20.90`(或加为首选 DNS)
4. **周期复测自动换优**:launchd 每周日 03:00 在 Mac 跑 cfst → 取 HKG/最优 → 通过 AdGuard API 自动更新重写(脚本我写好)
5. 个人设备立即可用(不等 DNS 改造):
   - macOS:`sudo sh -c 'echo "172.67.197.142 flow.summer.fan" >> /etc/hosts'`
   - Windows(管理员):`Add-Content C:\Windows\System32\drivers\etc\hosts "172.67.197.142 flow.summer.fan"`
   - 手机蜂窝网络:建议先实测——运营商 5G 到 CF 常比办公宽带好得多,可能根本不慢

## 3. 双连接器调优(Windows + Linux 各一套清单)

**第 3.1 步 · 诊断现状(先做,别跳)**:在两台连接器上分别看当前协议:

```
Windows(PowerShell 管理员): cloudflared tunnel info <隧道名>
                             Get-Service cloudflared; cloudflared --version
Linux:                      journalctl -u cloudflared | grep -E "Registered|protocol" | tail -5
                             cloudflared --version
```
日志里 `Registered tunnel connection ... protocol=quic|http2` 即当前协议。

**第 3.2 步 · A/B 实验(各 24h)**:

| 天 | Windows 连接器 | Linux 连接器 |
|---|---|---|
| D1-D2 | 默认(auto/quic) | `--protocol http2` |
| D3-D4 | `--protocol http2` | 默认(quic) |

切换方法:
- **Linux**(systemd):`sudo systemctl edit cloudflared` →
  `[Service]`
  `ExecStart=`
  `ExecStart=/usr/bin/cloudflared --no-autoupdate --protocol http2 tunnel run --token <TOKEN>`(保留原有 token 参数)
  `sudo systemctl daemon-reload && sudo systemctl restart cloudflared`
  *若是 config.yml 方式:在 yml 顶层加 `protocol: http2` 后重启。*
- **Windows**(服务):`cloudflared service uninstall` → 用相同参数 + `--protocol http2` 重新 `cloudflared service install <TOKEN>`;或改 `%SystemDrive%\ProgramData\cloudflared\config.yml` 顶层加 `protocol: http2` 后 `Restart-Service cloudflared`

**观测指标**(每台机器):`cloudflared tunnel info <隧道名>` 里的连接数/丢包重连;两台各留同一协议者胜出。经验:国内对 UDP 7844(QUIC)限速/丢包严重的网络,http2 常更稳;反之亦然——以你网络实测为准。

**第 3.3 步 · 版本与健壮性**:
- 两台都升级到最新 `cloudflared`(老版本 QUIC 实现差)
- 保持 2 连接器并行(HA),可一台 quic 一台 http2 做协议互备
- `--edge-ip-version 4` 固定走 IPv4(若 v6 国际路由差)

## 4. 验证口径(改完全部用同一把尺)

```bash
# 中位数对比(本机)
for i in $(seq 5); do curl -s -o /dev/null -m 20 -w "%{time_total}\n" https://flow.summer.fan/api/health; done | sort -n | sed -n 3p
# 命中机房确认
curl -s https://flow.summer.fan/cdn-cgi/trace | grep colo   # 目标:HKG
# 手机蜂窝 + 公司 WiFi 各测一轮
```
**达标线**:首开中位数 ≤1.0s、页面内 API 往返(复用连接)≤300ms、无 5s+ 尖刺。

## 5. 预期管理(重要)

本网络对**所有** CF IP 都 ≥157ms 且丢包明显——免费套餐 + 优选 + QUIC 的现实上限约 **0.6~1.0s 首开**。要进 <100ms 档,只有路线二(国内 VPS + frp,同样是主动外连隧道,安全模型与本方案完全一致),两者可并存:国内走 frp、海外走 CF。

## 分工汇总

| 步骤 | 谁做 | 何时 |
|---|---|---|
| 1 CF 面板开关 | 你(2 分钟)或给我 API Token | 立即 |
| 2.1-2.4 AdGuard 部署+重写+路由 DHCP | 我(SSH 到 10.5.20.90)+ 你在路由器改 DHCP | 今天 |
| 2.5 周期复测脚本 | 我 | 今天 |
| 3.1 连接器诊断 | 你提供两台的访问方式(SSH/向日葵/按清单自跑) | 今天 |
| 3.2-3.3 A/B 与升级 | 我(拿到访问方式后)或按清单自跑 | 4 天 |
| 4 验证 | 我 | 每步后 |
