# ReForge — 流程再造工程收集表

流程再造工程收集表（ReForge）：面向流程再造工程的流程收集平台——可随时增加下一步、标记会签节点（内部可含多步）、为任一步骤设置"前置会签通过后执行"的依赖，并为每一步标注线上 / 线下办理方式及其属性，支持一键生成流程图；提交后进入管理后台统一管理（需登录），并规划多人协作推进（见 docs/collab-architecture.md）。数据持久化于 PostgreSQL（本机 Docker 开发环境）。

## 功能特性

- **自定义步骤**：自由增加下一步、删除、上移/下移调整顺序
- **会签专用卡片（内部多步）**：勾选会签后步骤卡片切换为会签专属形态（琥珀主题 + "会签节点"徽标，主级处理方式下沉），配置多个会签部门及人员（多方并行签署）；每个会签方的**内部子步骤均完整采集属性**——线上/线下处理方式、线上系统名称、是否支持移动端、线下涉及文件与经办部门及人员
- **前置会签依赖**：任一步骤可设置前置条件——等待之前某个会签流程通过后方可继续执行；可选"整个会签全部通过"或"仅某一会签方分支通过"；流程图中以带标签的虚线箭头表达
- **一键生成流程图**：编辑中可预览草稿图，已保存流程可随时生成；基于 Mermaid 渲染，会签自动展开为菱形分叉 → 各会签方分支（内部子步骤串联）→ 汇聚 → 下一步；支持一键复制 Mermaid 源码二次编辑
- **每步骤标注处理方式**：
  - **线上处理**：填写承载系统名称（如 OA / ERP），并标记是否支持移动端
  - **线下处理**：登记涉及文件名称（多个）、线下经办部门及涉及人员
- **线上系统库**：管理员在后台维护可选的线上系统清单（增删），前台填写线上步骤时只需**下拉选择**；系统库为空时自动退回手动输入；既有流程中的系统名在首次启用时自动归集入库
- **用户注册（首个注册用户即管理员）**：`/admin` 支持注册账号——**第一个注册的用户自动成为管理员**，其后注册为普通用户；密码 bcrypt 加密存储；普通用户进入后台时提示权限引导
- **管理后台（需登录）**：已提交流程移入 `/admin` 后台统一管理——搜索、查看详情、流程图、删除、维护线上系统库、查看注册用户；登录会话 24 小时有效，未登录 401、普通用户 403 拦截
- **收集清单**：前台只负责收集提交，查看与管理在管理后台进行
- **移动端 / 折叠屏动态适配**：`viewport-fit=cover` + safe-area 避让异形屏；`100dvh` 动态视口高度随折叠展开/浏览器工具栏收展自动跟随；CSS media query 动态重排（320px 最小宽 → 360/375 外屏 → 673/744 展开态 → 平板全覆盖）；触屏输入 ≥16px 防 iOS 聚焦缩放；折叠屏分屏姿态（`vertical/horizontal-viewport-segments`）自动收窄内容避开铰链折痕区
- **iOS / iPhone Duo 专项**：hover 效果仅在支持 hover 的设备启用（`hoverOnlyWhenSupported`，消除 iOS Safari 点击后光效粘滞）；`touch-action: manipulation` 消除双击缩放延迟；关键操作 44pt 触摸目标（Apple HIG）；`appleWebApp` 主屏独立窗口 + 半透明状态栏、禁用电话号识别
- **前后端校验**：前端即时提示，Go 后端二次校验（含前置依赖合法性），中文错误信息

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 15 (App Router) + TypeScript |
| UI 组件库 | [Aceternity UI](https://ui.aceternity.com/components)（BackgroundBeams / Meteors / Input / Label / Textarea / Checkbox / ShimmerButton / HoverBorderGradient / Modal / Toast） |
| 流程图 | [Mermaid](https://mermaid.js.org/)（按需动态加载，暗色主题渲染） |
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

### 数据库

`processes` 表：元数据列（id/name/description/applicant/created_at/updated_at）+ `steps JSONB`（完整步骤树，含会签方与内部子步骤、前置依赖），兼顾查询与结构灵活性。历史 JSON 文件数据在表为空时自动导入。

## Docker 部署（一键脚本）

```bash
bash deploy.sh          # 构建 + 启动（中国镜像加速）
bash deploy.sh --logs   # 跟踪日志
bash deploy.sh --down   # 停止（数据卷保留）
```

脚本自动完成：镜像构建（GOPROXY/npmmirror/TUNA 加速）→ 启动 PostgreSQL + 后端 + 前端 → 健康等待 → 输出访问地址。前端为 Next.js standalone 生产模式，字体自托管（fontsource），构建/运行零外网请求。

> 基础镜像（golang/node/postgres/alpine）从 Docker Hub 拉取缓慢时，可先经镜像源预拉并重打标签，例如：
> `docker pull docker.m.daocloud.io/library/golang:1.27-alpine && docker tag docker.m.daocloud.io/library/golang:1.27-alpine golang:1.27-alpine`

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/processes` | 列出全部流程（新的在前） |
| `POST` | `/api/processes` | 提交流程（含校验） |
| `GET` | `/api/processes/{id}` | 获取单个流程 |
| `DELETE` | `/api/processes/{id}` | 删除流程 |
| `POST` | `/api/auth/register` | 注册账号（首个注册用户自动成为 admin，其后为 member） |
| `POST` | `/api/auth/login` | 登录（注册用户密码登录；未命中时回退校验环境变量引导管理员） |
| `GET` | `/api/auth/status` | 注册开放状态（是否已有用户，供前端提示） |
| `GET/DELETE` | `/api/auth/me`、`/api/auth/session` | 当前身份 / 注销会话 |
| `GET` | `/api/admin/users` | 【需登录 admin】注册用户列表 |
| `GET` | `/api/admin/processes` | 【需登录】列出全部流程 |
| `GET/DELETE` | `/api/admin/processes/{id}` | 【需登录】获取 / 删除流程 |
| `GET` | `/api/systems` | 线上系统库（公开读，前台下拉用） |
| `POST` | `/api/admin/systems` | 【需登录】添加线上系统（按名称幂等） |
| `DELETE` | `/api/admin/systems/{id}` | 【需登录】移除线上系统 |
| `GET` | `/api/health` | 健康检查 |

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
Flow
├── docker-compose.yml  # PostgreSQL 16 开发数据库
├── backend/            # Go 后端
│   ├── main.go         # HTTP 路由 / 校验 / CORS
│   ├── model.go        # 数据模型与业务校验规则（含前置会签依赖）
│   └── store.go        # PostgreSQL 存储（pgx）+ JSON 历史数据迁移
└── frontend/           # Next.js 前端
    ├── app/            # 页面入口（layout / page / globals.css）
    ├── components/
    │   ├── ui/         # Aceternity UI 组件（按官方组件复刻）
    │   ├── flow-builder.tsx   # 流程收集主表单
    │   ├── step-card.tsx      # 步骤卡片（线上/线下/会签配置）
    │   ├── party-editor.tsx   # 会签方编辑器（部门+人员+内部多步）
    │   ├── flow-chart.tsx     # Mermaid 流程图生成 / 渲染 / 复制
    │   ├── handler-list.tsx   # 部门+人员 编辑器（线下经办）
    │   ├── tag-input.tsx      # 多值标签输入（文件/人员）
    │   └── process-list.tsx   # 已收集流程列表 + 详情弹窗
    └── lib/            # 类型定义与工具函数
```
