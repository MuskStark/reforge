# 安全审计报告(三轮,2026-11-22)

> 范围:ReForge 全部代码(backend Go / frontend Next.js / Docker 部署)。
> 方法:第 1 轮静态代码审计 → 修复 → 第 2 轮 Docker 容器化攻击模拟(16 项)→ 第 3 轮修复后全量复测 + 追加 6 项(共 22 项攻击向量)。
> 攻击工具:`docker run python:3.12-alpine`(镜像源 docker.m.daocloud.io)执行 `/tmp/reforge-attack/attack.py`,经 `host.docker.internal` 直击后端 `0.0.0.0:8080`(测试期间临时放开,测毕恢复 `127.0.0.1`)。

## 第 1 轮:静态审计发现与修复

| # | 等级 | 问题 | 修复 |
|---|---|---|---|
| S0 | **严重** | `DELETE /api/processes/{id}` **完全无鉴权**,任何人可删任意流程 | 改为 `requireAdmin`(main.go);前端本就走 `/api/admin/...`,零影响 |
| S1 | 高 | `GET /api/processes`(列表/详情)公开,泄露全部流程与人员姓名 | 收紧为登录可读(数据查看权限);前台仅需 POST 提交,不受影响 |
| S2 | 高 | 登录无限流,可口令暴破 | 新增 `rateLimiter`(security.go):按 IP+账号 15 分钟 5 次失败锁定,429 |
| S3 | 高 | 请求体无大小限制,JSON 炸弹可耗尽内存 | `decodeJSON` 统一加 `http.MaxBytesReader` 1MB;登录收紧 4KB |
| S4 | 中 | CORS `Access-Control-Allow-Origin: *` 全开放 | 改为 `FLOW_ALLOWED_ORIGIN` 白名单(默认不发送任何 CORS 头,同源代理) |
| S5 | 中 | 无服务器超时,可 slowloris | `http.Server` ReadHeader 10s/Read 30s/Write 60s/Idle 120s,头 16KB |
| S6 | 中 | 缺安全响应头 | `withSecurityHeaders`:nosniff / X-Frame-Options DENY / Referrer-Policy no-referrer;API `Cache-Control: no-store` |
| S7 | 低 | dueDate/分析枚举未校验,垃圾值入库 | `validDate`(严格 YYYY-MM-DD 日历校验)+ `normalizeLevel`(高/中/低) |
| S8 | 低 | 字段数量无上限(1MB 内可塞 5000 元素数组) | validateProcess 加上限:步骤≤200/会签方≤50/子步骤≤100/文件≤100/文本长度上限 |
| S9 | 信息 | 默认引导账号 admin/flow123 | 保留(文档化引导机制,支持环境变量覆盖);已有暴破锁定保护 |

**确认无问题项**:SQL 全参数化($n,无拼接);ID/令牌 `crypto/rand` 32hex;bcrypt(DefaultCost);Bearer 头鉴权(无 Cookie → 天然免疫 CSRF);注册在首个用户后 403 关闭;删除用户有防呆;前端无 `dangerouslySetInnerHTML`(React 自动转义 XSS);Next rewrites 同源代理。

**已知接受的限制**(记录在案):会话在内存(单实例设计,重启即登出,多实例需换集中存储);token 存 localStorage(XSS 下可被窃取——已由 React 转义 + nosniff + 无第三方脚本缓解,后续可升级 HttpOnly Cookie);限流在内存(多实例需 Redis)。

## 第 2 轮:Docker 攻击模拟(修复后,16 项)

| 攻击 | 结果 |
|---|---|
| A1/A2 SQL 注入(路径参数/正文/登录名,5 种 payload) | ✅ 全参数化,无 5xx/无数据泄露 |
| B1 无 token 访问 /api/admin/users | ✅ 401 |
| B2 伪造 token | ✅ 401 |
| B3 空 Bearer | ✅ 401 |
| B4 member 访问用户列表 | ✅ 403 |
| B5 member 调用需求分析 | ✅ 403 |
| B6 member 删除用户 | ✅ 403 |
| C1 口令暴破 30 次 | ✅ 第 6 次 429 锁定 |
| D1 12MB JSON 炸弹 | ✅ curl 实测 5ms 内 400 断流(MaxBytesReader 1MB 截断;脚本内 -1 为客户端断言误差) |
| D2 大数组载荷 | ✅ 第 2 轮 201→加上限后第 3 轮 400 |
| E1 IDOR:非指派人 PUT 他人流程 | ✅ 403 |
| F1 存储型 XSS + nosniff | ✅ nosniff 头存在;正文按纯文本返回,渲染层 React 转义 |
| G1 恶意来源 CORS | ✅ 无 ACAO 头返回 |
| H1 路径穿越(`../../etc/passwd`) | ✅ 404 |
| I1 Slowloris 半开连接 | ✅ 10.0s 被服务器断开 |

## 第 3 轮:修复后全量复测 + 追加(6 项)

第 2 轮 16 项全部复测通过(D2 由 201 变 400,上限生效),另加:

| 攻击 | 结果 |
|---|---|
| J1 状态枚举注入(`'; DROP TABLE x;--`) | ✅ 400(白名单校验) |
| K1 非法日期(`2026-13-99'; DROP`) | ✅ 400(严格日历校验) |
| L1 安全响应头完整性 | ✅ 三项头齐全 |
| M1 注销后 token 复用 | ✅ 401(会话已吊销) |
| N1 已有用户后公开注册 | ✅ 403 |
| O1 文件数超限(101>100) | ✅ 400 |

**最终:22 项攻击向量全部防护通过。**

## 附:部署面建议

- docker-compose.prod 未对外发布后端端口(仅前端 3000)✓ 正确;**保持后端不直接暴露**,一切经 Next 同源代理
- 生产建议设置 `FLOW_ALLOWED_ORIGIN`(如需直连)、强密码覆盖 `FLOW_ADMIN_PASS`、PostgreSQL 强口令(当前 flow/flow 为本机开发默认)
- 后续可加:登录验证码、审计日志持久化、HTTPS 终止(反代层)


## 第四轮:Cloudflare security-audit 技能全流程审计(2026-11-22,run-1)

七单元台账 + 7 名隔离器手 + 独立复核者,六阶段工作流;产出 `~/security-audit-skill/reforge/run-1/`(architecture/coverage-ledger/findings/REPORT,双校验器 PASS)。

**11 条 confirmed(1 critical / 3 high / 7 medium),全部已修复并回归反转:**

| # | 级别 | 发现 | 修复 |
|---|---|---|---|
| F04 | critical | 生产编排未注入管理员凭据,admin/flow123 随生产生效 | prod compose 强制 `${FLOW_ADMIN_PASS:?}`;deploy.sh 自动生成 .env 强口令(chmod 600),不再回显默认口令 |
| F01 | high | clientIP 盲信 XFF 首段,登录防爆破可逐请求绕过 | 默认只用 RemoteAddr;FLOW_TRUSTED_PROXY CIDR 门控+取最右非受信跳;新增账号维度失败计数兜底(回归:换 XFF 8 连错→第 6 次 429) |
| F02 | high | 匿名提交限流死代码(hit 零调用) | 新固定窗口限流器 allowHit 每次尝试计数(回归:第 21 次 429) |
| F03 | high | 删除用户不吊销会话,角色快照≤24h 存活 | sessionStore.revokeByUsername,删除成功即吊销(回归:旧 token /me→401) |
| F05 | medium | U+0000→500 回显 SQLSTATE 给匿名方 | sanitize 全链剥离 NUL/C0;500 通用文案+服务端日志(回归:201/400 无泄露) |
| F06 | medium | 限流表无界内存+持锁 O(n) 清理 | 键规范化截断 96B;20k 硬上限+最旧淘汰;登录用户名 2-32 预检 |
| F07 | medium | dev PG 5432 发布全部接口+flow/flow | `127.0.0.1:5432:5432` |
| F08 | medium | 生产 DB 口令明文入仓 | `${POSTGRES_PASSWORD:?}` + .env 注入 |
| F09 | medium | docker GPG 信任锚取自镜像自身 | 固定 download.docker.com 官方源 |
| F10 | medium | 基础镜像可变 tag 无摘要 | Dockerfile FROM 参数化 + deploy.sh 部署时解析 digest 注入(不可达降级并告警) |
| F11 | medium | pnpm/corepack 默认 npmmirror | 默认 registry.npmjs.org(镜像可显式覆盖) |

加固顺手项:Next HTML 安全头(XFO/nosniff/referrer,已实测生效)。
修复后 Docker 攻击套件 22 项复核:21 PASS + D1 已知客户端伪影(curl 实证 5ms/400)。


## 流程管理 P3 新增面的说明(2026-11-24,非审计结论)

以下是实现"阶段模板 / 外部通知渠道 / 导出 / 删除流程"时引入的新接口与数据,以及它们自带的控制措施。
**这一节没有经过上面四轮那样的独立审计**,下次做安全审计时请把它纳入范围。

| 新增面 | 风险 | 现有控制 |
|---|---|---|
| 通知渠道的 Webhook 地址、签名密钥、邮箱口令 | 凭据以明文存在 `notify_channels`;能读库即可拿到 | 仅系统管理员可配置(`requireAdmin`);接口只返回脱敏值(`key=****`、只返回"是否已设置"),不留日志;文档建议只接内部群与内部邮箱 |
| 服务器按管理员填写的地址发起请求(Webhook / SMTP) | 管理员可让服务器请求任意 http / https 地址与任意主机端口(内网探测面) | 属于管理员既有权限范围内的功能;类型与地址格式有校验,超时 8 秒(邮件各步 10–15 秒)。没有做内网地址黑名单——本项目按内网部署,机器人网关可能就在内网 |
| 后台异步投递 | 外部服务被反复请求、消息重复或被篡改后冒充 | 一个渠道对一条逻辑通知只处理一次(主键);失败最多 6 次按退避重试;校验机器人应答码,拒绝即记为失败 |
| 导出接口(清单 CSV、单项目报告) | 数据外带面扩大;匿名提交的流程名 / 申报人进入 CSV,可能在 Excel 里被当作公式执行(CSV 注入) | 与查看范围一致(登录即可);CSV 单元格以 `=` `+` `-` `@` 或制表 / 回车开头时加单引号前缀,Excel 按文本处理(连库用例覆盖:提交名为 `=HYPERLINK(…)` 的流程后导出) |
| 删除流程改为级联删除 | 误删会连带项目的全部记录 | 仍仅管理员;界面二次确认并写明后果;后端在一个事务里删,失败整体回滚 |
| 阶段模板可配置 | 配错模板影响之后新建的项目 | 保存前整体校验(关卡必须有评审人与表决方式、标识唯一、数量上限);改动不影响已立项的项目 |

未做:渠道配置的操作审计日志(事件表只记项目内的事)、导出的访问日志、机器人应答的签名验证(应答走 HTTPS)。
