# ReForge — 流程再造工程收集表

流程再造工程收集表（ReForge）：面向流程再造工程的流程收集平台——可随时增加下一步、标记会签节点（内部可含多步）、为任一步骤设置"前置会签通过后执行"的依赖，并为每一步标注线上 / 线下办理方式及其属性，支持一键生成流程图；每条提交的流程自动立项为**改造项目**，由项目经理、CTO、经办按七个阶段、六个评审关卡端到端推进（见 `docs/process-management-architecture.md`）；流程定义与系统库在管理后台维护（需登录），并规划运行期的多人协作推进（见 docs/collab-architecture.md）。数据持久化于 PostgreSQL（本机 Docker 开发环境）。

## 功能特性

- **自定义步骤**：自由增加下一步、删除、上移/下移调整顺序
- **会签专用卡片（内部多步）**：勾选会签后步骤卡片切换为会签专属形态（琥珀主题 + "会签节点"徽标，主级处理方式下沉），配置多个会签部门及人员（多方并行签署）；每个会签方的**内部子步骤均完整采集属性**——线上/线下处理方式、线上系统名称、是否支持移动端、线下涉及文件与经办部门及人员；会签卡与流程图容器标题带**整体办理方式标识**（由各方内部子步骤汇总：线上 / 线下 / 线上+线下，尚无已命名子步骤时显示未标注）
- **前置会签依赖**：任一步骤可设置前置条件——等待之前某个会签流程通过后方可继续执行；可选"整个会签全部通过"或"仅某一会签方分支通过"；流程图中以带标签的虚线箭头表达
- **一键生成流程图**：编辑中可预览草稿图，已保存流程可随时生成；基于 React Flow 确定性正交布局,主干节点严格中轴对齐;会签画为主干右侧的旁路子流程容器(主干线完整直连不打断;琥珀旁路线自上一主干节点右缘直角折入容器顶边,容器内各会签方泳道并行办理、内部子步骤串联,容器底边直角折回下一主干节点右缘,全部通过后继续);设置前置会签依赖的节点带靛蓝「等待会签」门控徽章,依赖虚线从容器或具体会签方泳道右缘指出,一眼可辨哪个节点需要会签结果;**连线线型**:线上↔线下衔接、或目标步骤已标注「与上一步系统数据不互通」的连线为虚线,其余实线(会签取整体办理方式判定,泳道内子步骤衔接同理)
- **每步骤标注处理方式**：
  - **线上处理**：填写承载系统名称（如 OA / ERP），并标记是否支持移动端；与上一步均为线上且系统不同时，**必须选择两系统是否数据互通**——上一步为会签时，取各方最后一个子步骤的系统逐一比较，任一不同即必填
  - **线下处理**：登记涉及文件名称（多个）、线下经办部门及涉及人员
- **线上系统库**：管理员在后台维护可选的线上系统清单（增删），前台填写线上步骤时只需**下拉选择**；系统库为空时自动退回手动输入；既有流程中的系统名在首次启用时自动归集入库
- **用户体系（首个注册用户即管理员，之后仅管理员建号）**：`/admin` 初始开放注册——**第一个注册的用户自动成为管理员**，随后**公开注册自动关闭**（403 拦截），账号一律由管理员在后台创建（可选管理员/普通用户角色）；密码 bcrypt 加密存储；删除账号有防呆（不能删当前登录、不能删最后一名管理员）
- **管理后台（需登录）**：已提交流程移入 `/admin` 后台统一管理——搜索、查看详情、流程图、删除（二次确认,连同其项目及全部记录一并删除）、维护线上系统库、用户与岗位、阶段模板、通知渠道；登录会话 24 小时有效，未登录 401、普通用户 403 拦截
- **端到端流程管理**（架构见 `docs/process-management-architecture.md`）：流程一提交即自动立项,从**分析立项 → 需求确认 → 方案设计 → 系统改造 → 试运行 → 验收上线 → 运营优化**七个阶段推进,六个出口关卡须评审通过（必交付物未完成不能提交）;取代了原先"管理员指派单个跟进人、自评五阶段"的轻量跟进（旧数据首次启动时自动迁入项目）
  - **角色**：系统管理员;**CTO**（全局岗位,评审立项 / 方案 / 上线 / 验收,可跳过阶段、取消项目）;**项目经理**（对交付负责:拆解任务、推进阶段、提交评审、写简报）;**经办**（确认需求、执行试运行,需求基线与试运行结论由经办**会签**）;可选的开发实施与只读观察者。岗位在「后台 · 用户与岗位」里设置,项目成员由管理员 / CTO / 项目经理维护
  - **评审关卡**：或签由首位表决人决定,会签须全部通过、任一驳回即驳回;驳回退回修改后可重新提交（轮次保留）,支持撤回、回退到此前阶段、跳过阶段,全部留痕
  - **工作台 `/work`**：按角色组织——CTO / 管理员先看「待我评审」与有风险、逾期的项目;项目经理看「等我推进的项目」;经办看「待我确认」与「我的任务」
  - **流程项目 `/projects`**：按阶段分泳道的看板与列表,标出每个项目"待谁处理";**项目工作区**含概览（阶段进度、必交付物、立项信息、成员、项目状态）、计划（任务 / 交付物 / 问题 / 风险看板,指派、截止、阻塞原因、清单、依赖、按成员拆分）、评审、流程、动态五个标签
  - **流程版本与改善指标**：建项目时留存 As-Is,方案评审通过留存 To-Be 基线,验收通过留存已发布版本;并排对比流程图与步骤数、线下占比、断点数、涉及系统、移动端支持率
  - **简报与通知**：项目经理定期写四栏简报并更新健康度（有风险 / 已偏离时通知 CTO）;站内通知覆盖评审、指派、@提及、逾期、评审积压、简报到期
  - **阶段模板可配置**：后台「阶段模板」里调整每个阶段的名称、出口关卡、评审人、会签 / 或签、必交付物与默认任务,可增减阶段;**改动只影响此后新建的项目**,已立项的项目沿用立项时的模板
  - **外部通知渠道**：后台「通知渠道」把关键动态转发到企业微信 / 钉钉 / 飞书群机器人或邮箱;默认转发新流程提交、评审提交 / 通过 / 驳回 / 积压、逾期、阶段回退 / 跳过、项目状态变更;后台异步投递(同一件事群里只发一条、失败按退避重试、不回放历史),可随时发测试消息;Webhook 与密钥保存后不回显
  - **导出**：流程项目看板把当前筛选结果导出为 CSV(Excel 直接打开);项目页导出 Markdown 报告(基本信息、阶段与评审、工作项、简报、改善指标、时间线)或 JSON
  - **数据大屏**：专属路由 `/monitor`,登录即可查看,可全屏:六个核心数(累计收集 / 在途 / 待评审 / 逾期 / 完成 / 按期率与周期)、近 6 个月趋势、阶段分布、在途健康度、项目经理负载、申报部门 TOP5、线上系统涉及度、最新动态,30s 轮询,暗色玻璃
- **收集清单**：前台只负责收集提交，查看与管理在管理后台进行
- **移动端 / 折叠屏动态适配**：`viewport-fit=cover` + safe-area 避让异形屏；`100dvh` 动态视口高度随折叠展开/浏览器工具栏收展自动跟随；CSS media query 动态重排（320px 最小宽 → 360/375 外屏 → 673/744 展开态 → 平板全覆盖）；触屏输入 ≥16px 防 iOS 聚焦缩放；折叠屏分屏姿态（`vertical/horizontal-viewport-segments`）自动收窄内容避开铰链折痕区
- **iOS / iPhone Duo 专项**：hover 效果仅在支持 hover 的设备启用（`hoverOnlyWhenSupported`，消除 iOS Safari 点击后光效粘滞）；`touch-action: manipulation` 消除双击缩放延迟；关键操作 44pt 触摸目标（Apple HIG）；`appleWebApp` 主屏独立窗口 + 半透明状态栏、禁用电话号识别
- **前后端校验**：前端即时提示，Go 后端二次校验（含前置依赖合法性），中文错误信息

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 15 (App Router) + TypeScript |
| 设计系统 | Apple Liquid Glass（自研 token 系统：Regular/Clear 玻璃材质、iOS 分段控件/开关/44pt 输入、玻璃时间轨;概念稿见 `design/liquid-glass/`） |
| 流程图 | [React Flow](https://reactflow.dev/)（正交确定性布局,主干中轴对齐;会签=右侧旁路容器,分支/汇合点在主干线段中部;等待会签结果的节点带靛蓝门控徽章与依赖虚线） |
| 后端 | Go 1.27 + [pgx](https://github.com/jackc/pgx)（PostgreSQL 驱动） |
| 数据库 | PostgreSQL 16（本机 Docker，`docker compose up -d` 一键启动） |

## 快速开始

管理员由**首个注册用户**自动担任（如上方首次注册的「周琳」）；环境变量引导账号 `admin / flow123`（`FLOW_ADMIN_USER`、`FLOW_ADMIN_PASS` 可覆盖）始终可作为系统级管理员登录。

```bash
# 1. 启动开发数据库（本机 Docker）
docker compose up -d

# 2. 启动后端（端口 8080，自动建表；首次启动会自动迁移 data/processes.json 历史数据）
cd backend
go run .

# 3. 启动前端（端口 3000，另开终端）
cd frontend
pnpm install
pnpm dev
```

打开 http://localhost:3000 即可使用。

> 前端通过 Next.js rewrites 将 `/api/*` 代理到 `http://127.0.0.1:8080`，无需额外跨域配置。
> 数据库连接串可用环境变量 `DATABASE_URL` 覆盖（默认 `postgres://flow:flow@127.0.0.1:5432/flow?sslmode=disable`）；后端地址可用 `FLOW_ADDR` 覆盖。
> `FLOW_PUBLIC_URL`（选填）是站点的访问地址,例如 `http://reforge.example.internal:3000`:设置后外部通知的消息末尾会附工作台链接;`deploy.sh` 也用它做部署后的公网自检（见下文 Docker 部署）。

### 开始使用流程管理

1. 用管理员登录 `/admin` → 「用户与岗位」,为每个账号填**显示名**并设**岗位**（至少一位 CTO、若干项目经理和经办）。流程里登记的经办人员按显示名自动匹配,匹配到的人会出现在立项时的经办候选里。这里设的密码只是初始密码:用户首次登录后必须先改成自己的密码,在那之前不能使用系统。
2. 打开 `/projects`,待立项的流程点「指派项目经理」。成员按类分配:**管理员可分配全部成员**,**CTO 分配科技侧经办**(岗位为「开发实施」的人),**项目经理分配业务侧经办**(岗位为「经办」的人)。第一位项目经理到岗后项目正式启动。
3. 之后各角色从 `/work` 进入待办：项目经理完成必交付物并提交评审,CTO / 经办在「评审」里表决,通过后自动进入下一阶段。
4. 需要调整流程时,在后台「阶段模板」里改(只影响之后新建的项目);需要把动态推到群里时,在「通知渠道」里建一个机器人或邮件渠道,点「测试」确认能收到。

登录后点右上角的「个人信息」可以修改自己的显示名、部门和密码;由服务器环境变量引导的管理员没有用户记录,不在此列。

从旧版本升级：后端首次启动时会为每条存量流程建立项目,按原跟进状态与阶段落到对应位置（原跟进人成为项目经理,旧时间线迁入「动态」）。旧的 `analyze / assign / status / stage` 接口已下线。

### 测试

```bash
cd backend && go test ./...                       # 规则单元测试(不需要数据库)
TEST_DATABASE_URL='postgres://flow:flow@127.0.0.1:55432/flow_test?sslmode=disable' \
  go test ./...                                   # 另跑端到端与迁移测试(需一个名为 flow_test 的空库,会被清空)
```

端到端测试连真实 PostgreSQL、走真实路由表,用管理员 / CTO / 项目经理 / 两位经办五个账号把"提交 → 立项指派 → 六个关卡 → 完成"整条主线走一遍,并覆盖权限边界、驳回、回退、跳过、拆分、简报、定时提醒与存量迁移。
P3 另有三组连库用例:改模板后新旧项目各按自己的模板推进(含重启后)、通知渠道的投递 / 去重 / 停用 / 失败重试 / 放弃 / 删除、导出内容与删除流程后的级联清理;不连库的单元测试覆盖三种群机器人的报文与加签、SMTP 发信、渠道校验与脱敏、模板校验。
成员分配规则(管理员全部 / CTO 科技侧经办 / 项目经理业务侧经办)有单元测试与连库用例各一组;首次登录强制改密、自助修改资料与密码由连库用例覆盖。

### 数据库

`processes` 表：元数据列（id/name/description/applicant/created_at/updated_at）+ `steps JSONB`（完整步骤树，含会签方与内部子步骤、前置依赖），兼顾查询与结构灵活性。历史 JSON 文件数据在表为空时自动导入。

流程管理另有一组表（DDL 见 `docs/process-management-architecture.md` 第 7 节）：`projects`（流程项目）、`project_stages`、`project_members`、`gate_reviews` / `gate_reviewers`（评审轮次与每人一票）、`work_items` / `work_item_links`、`comments`（评论与简报）、`process_versions`（As-Is / To-Be / 已发布快照及改善指标）、`events`（只追加的事件流）、`notifications`；P3 增加 `stage_templates`（阶段模板）、`projects.template`（立项时的模板快照）、`notify_channels` / `notify_deliveries`（外部通知渠道与投递记录）。

## 安全

三轮人工审计 + Docker 攻击模拟,以及第四轮 Cloudflare security-audit 技能全流程审计(7 器手/11 发现/独立复核,全部修复)详见 `docs/security-audit.md`：请求体 1MB 上限、登录与匿名提交限流、服务器超时与安全响应头、CORS 白名单、字段数量/日期/枚举校验；公开读接口收紧为登录可读，删除仅管理员。生产部署请：后端不直接暴露端口、覆盖 `FLOW_ADMIN_PASS` 与数据库口令、按需设置 `FLOW_ALLOWED_ORIGIN`。

流程管理新增面的补充说明：外部通知渠道的 Webhook 地址、签名密钥与邮箱口令保存在数据库里（明文,仅系统管理员可配置），接口只返回脱敏值——能读到数据库的人拿得到这些凭据,请只接内部群与内部邮箱；渠道地址由管理员填写,服务器会向它发起请求。导出接口与查看范围一致（登录即可导出全部项目）；CSV 里以 `=` `+` `-` `@` 开头的单元格已加单引号前缀,防止匿名提交的名称在 Excel 里被当作公式。这部分的说明见 `docs/security-audit.md` 末尾（未经过独立审计）。

## Docker 部署（一键脚本）

```bash
bash deploy.sh          # 构建 + 启动（中国镜像加速）
bash deploy.sh --logs   # 跟踪日志
bash deploy.sh --down   # 停止（数据卷保留）
```

脚本自动完成：镜像构建（GOPROXY/npmmirror/TUNA 加速）→ 启动 PostgreSQL + 后端 + 前端 → 健康等待 → 输出访问地址 → 公网自检。前端为 Next.js standalone 生产模式，字体自托管（fontsource），构建/运行零外网请求。`.env` 生成在脚本所在目录（compose 只从那里读）。

> 公网自检：`.env` 里设置了 `FLOW_PUBLIC_URL` 时，部署结束会经该地址取回 `/` 与 `/admin`，与本机页面核对是否同一次构建。站点在 CDN 后面时这一步有用：CDN 若缓存了 HTML，部署后旧页面引用的 chunk 已不存在，用户会白屏。CDN 仍在发旧页面、或在缓存 HTML 时，脚本会给出处理办法；它没有 CDN 的 API 凭据，不会自动清缓存。页面已统一为 `no-store`，自检若提示「CDN 正在缓存 HTML」，到 CDN 关闭该路径的缓存规则即可。

> 基础镜像（golang/node/postgres/alpine）从 Docker Hub 拉取缓慢时，可先经镜像源预拉并重打标签，例如：
> `docker pull docker.m.daocloud.io/library/golang:1.27-alpine && docker tag docker.m.daocloud.io/library/golang:1.27-alpine golang:1.27-alpine`

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/processes` | 列出全部流程（新的在前） |
| `POST` | `/api/processes` | 提交流程（含校验） |
| `GET` | `/api/processes/{id}` | 获取单个流程 |
| `DELETE` | `/api/processes/{id}` | 删除流程 |
| `POST` | `/api/auth/register` | 注册（仅用于引导首个管理员；已有用户后 403 关闭） |
| `POST/DELETE` | `/api/admin/users[/{id}]` | 【需登录 admin】创建用户（显式角色）/ 删除用户（防删自己、防删最后一名管理员） |
| `POST` | `/api/auth/login` | 登录（注册用户密码登录；未命中时回退校验环境变量引导管理员） |
| `GET` | `/api/auth/status` | 注册开放状态（是否已有用户，供前端提示） |
| `GET/DELETE` | `/api/auth/me`、`/api/auth/session` | 当前身份 / 注销会话 |
| `PATCH` | `/api/auth/profile` | 用户修改自己的显示名与部门 |
| `POST` | `/api/auth/password` | 用户修改自己的密码；管理员建号的账号首次登录必须先改密码 |
| `GET` | `/api/admin/users` | 【需登录 admin】注册用户列表 |
| `GET` | `/api/admin/processes` | 【需登录】列出全部流程 |
| `GET/DELETE` | `/api/admin/processes/{id}` | 【需登录】获取 / 删除流程 |
| `GET` | `/api/systems` | 线上系统库（公开读，前台下拉用） |
| `POST` | `/api/admin/systems` | 【需登录】添加线上系统（按名称幂等） |
| `DELETE` | `/api/admin/systems/{id}` | 【需登录】移除线上系统 |
| `GET` | `/api/health` | 健康检查 |
| — | `/api/projects…`、`/api/reviews…`、`/api/items…`、`/api/notifications…`、`/api/overview` | 流程项目管理（项目、成员、阶段、评审、工作项、评论与简报、版本对比、通知、聚合）,完整列表见 `docs/process-management-architecture.md` 第 12 节 |
| `GET/PUT` | `/api/admin/stage-templates` | 【需登录 admin】阶段模板的读取与整体替换 |
| `GET/POST`、`PATCH/DELETE`、`POST` | `/api/admin/notify-channels[/{id}[/test]]` | 【需登录 admin】外部通知渠道的增删改查与测试发送 |
| `GET/POST` | `/api/projects/export.csv` | 【需登录】项目清单 CSV（GET 全部或 `?status=`;POST `{ids}` 导出所选） |
| `GET` | `/api/projects/{id}/export` | 【需登录】单项目报告,Markdown 或 `?format=json` |

## 数据模型

```jsonc
{
  "id": "…",
  "name": "采购申请审批流程",        // 流程名称（必填）
  "description": "…",
  "applicant": "张三",              // 申报人
  "steps": [
    {
      "id": "…",
      "name": "提交采购申请",        // 步骤名称（必填）
      "mode": "online",            // online=线上处理 | offline=线下办理
      "countersign": true,         // 是否会签
      "online": {
        "systemName": "OA 办公系统", // 线上：系统名称（线上时必填）
        "mobileSupported": true     // 线上：是否支持移动端
      },
      "offline": {
        "documents": ["合同正本"],   // 线下：涉及文件名称
        "handlers": [               // 线下：经办部门及涉及人员
          { "department": "行政部", "staff": ["赵六"] }
        ]
      },
      "parties": [                  // 会签方（开启会签时必填至少一方，各方并行）
        {
          "id": "…",
          "department": "法务部",
          "staff": ["李四"],
          "subSteps": [              // 会签内部多步（依次执行），与主步骤同样采集线上/线下属性
            {
              "id": "…", "name": "合规初审", "mode": "online",
              "online":  { "systemName": "合同管理系统", "mobileSupported": true },
              "offline": { "documents": [], "handlers": [] }
            },
            {
              "id": "…", "name": "用印归档", "mode": "offline",
              "online":  { "systemName": "", "mobileSupported": false },
              "offline": {
                "documents": ["用印登记簿"],
                "handlers": [{ "department": "行政部", "staff": ["王麻子"] }]
              }
            }
          ]
        },
        { "department": "财务部", "staff": ["王五", "马六"] }  // 无 subSteps 时按单步会签处理
      ],
      "waitFor": {                   // 前置会签依赖（选填）：本步骤需等待该会签通过后执行
        "stepId": "依赖的会签步骤 id",
        "partyId": "可选：仅等待该会签方分支；缺省 = 整个会签全部通过"
      },
      "remark": "…"
    }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

## 目录结构

```
reforge
├── docker-compose.yml  # PostgreSQL 16 开发数据库
├── backend/            # Go 后端(单个二进制,net/http 路由)
│   ├── main.go         # 服务器与路由表(newMux)      auth.go / users.go    # 会话、用户与岗位
│   ├── model.go        # 流程定义的数据模型与业务校验  store.go              # PostgreSQL 存储
│   ├── projects_model.go · template.go · metrics.go · perms.go
│   │                   # 流程项目的模型 / 阶段模板 / 流程改善指标 / 角色与权限矩阵
│   ├── stage_templates.go  # 阶段模板表、内置模板写入、后台读写接口
│   ├── store_project.go  # 项目相关表、建项目、存量迁移   reviews.go · reviews_http.go  # 关卡引擎与接口
│   ├── projects.go · workitems.go · comments.go · versions.go · notify.go
│   │                   # 项目 / 工作项 / 评论与简报 / 版本对比 / 通知与定时调度
│   ├── overview.go · export.go              # 组合聚合 / 清单与报告导出
│   ├── channels.go · channels_delivery.go   # 外部通知渠道的配置接口 / 发送端与后台投递
│   ├── followup.go     # 流程定义编辑(PUT),旧跟进接口已下线
│   └── *_test.go       # 规则单元测试 + 连库的端到端与迁移测试
└── frontend/           # Next.js 前端
    ├── app/            # 页面:/ 收集表单  /work 工作台  /projects 流程项目  /projects/[id] 项目工作区
    │                   #      /inbox 通知  /admin 管理后台  /monitor 数据大屏(全维度,可全屏)
    ├── components/
    │   ├── ui/         # 液态玻璃基础控件(对话框、输入、按钮、加载器)
    │   ├── shell/      # 应用外壳(导航、登录态、未读角标)   auth/  # 登录卡
    │   ├── projects/   # 工作台、项目看板、项目工作区(概览 / 计划 / 评审 / 流程 / 动态)
    │   ├── inbox/      # 通知中心       admin/  # 流程定义、系统库、用户与岗位、阶段模板、通知渠道
    │   ├── flow-builder.tsx · step-card.tsx · party-editor.tsx   # 流程收集表单
    │   ├── flow-graph.tsx · flow-chart.tsx                        # React Flow 流程图与预览弹窗
    │   └── followup/   # 流程图编辑器、表单编辑弹窗(follow-board / follow-detail 为已被取代的旧跟进界面)
    └── lib/            # types(类型) · step-checks(步骤规则) · labels(文案与配色) · auth(会话)
```
