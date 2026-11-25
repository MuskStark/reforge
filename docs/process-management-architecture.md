# 端到端流程管理 — 架构设计（v1）

> 状态：**P0–P3 已实现（2026-11-24）**；**需求承接已实现（2026-11-26，第 21 节）**；P4（运行期实例引擎）未实施。实现与本文的出入见第 19 节"实现对照"。
> 范围：流程收集完成之后，为**每一个流程**建立一条从分析立项、需求确认、方案设计、系统改造、试运行，
> 到验收上线、运营优化的端到端管理主线，由**PM、CTO、BH（业务经办）**等角色协作推进。
> 岗位与项目角色在界面上一律用英文缩写：PMO 项目管理办公室、CTO、PM 项目经理、BH 业务经办、TH 科技经办（2026-11-25 起，见 4.1）。
> 关系：取代 `followup-plan.md` 的改造期跟进（旧数据自动迁入，旧接口已下线）；与 `collab-architecture.md`
> （运行期实例引擎，未实施）共用同一套用户/成员/事件/任务内核——本文管"改造期"，那份管"运行期"。

---

## 1. 目标与现状差距

**目标**

1. 流程一提交就自动进入标准治理主线，不再依赖管理员逐个手工指派单个跟进人。
2. PM / CTO / BH 职责边界清晰，各有自己的工作入口；评审有记录、交付有基线、进度有度量。
3. 复用并保留既有能力：流程定义与流程图、表单与流程图编辑器、时间线、看板、大屏、液态玻璃设计系统。

**现状（`followup-plan.md` P1+P2）与差距**

| 维度 | 现状 | 目标 |
|---|---|---|
| 管理对象 | 跟进字段内嵌 `processes`，1 流程 = 1 工单 | 独立的"流程项目"，带成员、阶段、关卡、工作项 |
| 角色 | 仅 `admin` + 单个"跟进人" | 项目角色 PM / BH / TH（+ 只读 PMO）× 全局岗位 CTO × 系统管理员 |
| 阶段 | 跟进人自评 5 阶段，无准入准出 | 7 阶段 + 6 个评审关卡，必交付物校验，评审留痕 |
| 分析立项 | 管理员填价值/复杂度/优先级三个等级 | PM 出分析报告（含流程量化指标），CTO 做立项决策 |
| 任务 | 无 | 工作项（任务/交付物/问题/风险），指派、截止、阻塞、依赖 |
| 沟通 | 无 | 评论、@提及、项目简报、通知中心 |
| 流程定义 | 原地覆盖编辑，As-Is 基线易丢 | 版本化：As-Is / To-Be / 已发布 |
| 度量 | 4 个计数 | 阶段漏斗、周期时间、逾期/阻塞、评审积压、流程改善指标 |

---

## 2. 调研结论

> 调研日期 2026-11-23 至 24。方法：检索 + 直读官方文档（BPM / 审批部分另有一轮子任务通读了官方文档源文件）；
> 只写核实过的内容，读到原文与仅见摘要的分别标注。这是一次面向设计的调研，不是多产品横向评测；未覆盖的对象列在 2.4。

### 2.1 看了什么

| 类别 | 对象 | 关注点 |
|---|---|---|
| SaaS | Linear、Jira、Asana、Basecamp | 项目更新与健康度、权限模型、项目角色 |
| 开源 | Plane、OpenProject、Wekan、Leantime、Kanboard、Vikunja、DooTask、Huly | 体量、技术栈、许可证、活跃度 |
| BPM / 审批 | Camunda 8、飞书审批 | 人工任务的指派语义、会签/或签、转交/加签/回退 |
| 方法论 | RACI、BPM 生命周期（Dumas 等） | 角色职责划分、阶段划分 |

**热门开源多人项目管理项目**（GitHub API，2026-11-23 查询）

| 项目 | Stars | 主语言 | 许可证 | 最近提交 |
|---|---|---|---|---|
| Plane | 63,023 | TypeScript | AGPL-3.0 | 2026-11-23 |
| Wekan | 21,175 | JavaScript | MIT | 2026-11-22 |
| OpenProject | 17,656 | Ruby | GPL-3.0 | 2026-11-23 |
| Leantime | 12,139 | PHP | AGPL-3.0 | 2026-11-23 |
| Kanboard | 9,975 | PHP | MIT | 2026-11-23 |
| Vikunja | 6,154 | Go | AGPL-3.0 | 2026-11-23 |
| DooTask | 5,616 | PHP | AGPL-3.0 | 2026-10-29 |
| Huly（selfhost 仓库） | 3,602 | Shell | EPL-2.0 | 2026-09-29 |

### 2.2 对设计有直接影响的发现

| # | 发现 | 来源与核实程度 | 落到本架构 |
|---|---|---|---|
| 1 | 项目健康度（On track / At risk / Off track）**挂在每次"项目更新"上**，不是独立字段；最新一次更新的健康度显示在项目概览，并向上汇总 | Linear、Plane 官方文档，读到原文 | 第 10 节项目简报：写简报时同时更新 `health` |
| 2 | 权限 = **角色 × 权限方案**；角色按空间/项目授予并由项目管理员维护成员；方案可跨项目复用 | Jira Cloud 官方文档，读到原文 | 简化为"固定权限矩阵（第 8 节）× 项目角色"，不做可配置方案 |
| 3 | 人工任务有三种指派：`assignee`（指定人）、`candidateUsers` / `candidateGroups`（候选人 / 组）；名单在任务激活时求值并定格。**多实例**（并行 / 串行）对集合里每个元素生成一个实例，`completionCondition` 每完成一个实例求值一次，为真即终止其余实例。定时器"不会早触发，但可能晚触发"，分提醒（不改变流程）与升级 / 自动处理（改变流程）两种 | Camunda 8 官方文档（用户任务、多实例、定时器、任务授权页），读到原文 | 关卡评审 = 并行多实例 + 完成条件 all / any，用 `gate_reviewers` 逐人一行实现，提交时定格评审人名单；提醒（逾期 / 积压）只发通知不改状态，不上引擎 |
| 4 | 多人审批的三种口径是**会签**（全部同意）/ **或签**（任一同意）/ **依次审批**；或签"由第一个操作人决定，同意即通过，拒绝则终止"。审批人为空时有兜底规则（自动通过 / 转管理员等）。通用干预操作：转交、前加签 / 后加签 / 并加签、减签、回退、撤回。审批人为空 / 同一人的兜底、超时规则、版本"变更只影响其后新发起的实例" | 飞书审批帮助中心（管理员设计流程、审批人异常流转、转交加减签回退、超时规则、修改规则）、宜搭文档（审批人节点、自动审批规则、超时处理、流程版本），读到原文；钉钉仅见摘要 | 或签语义取"首位表决人决定"；每人一票天然表达会签 / 或签；"依次审批"、转交、加签本期不做（第 19 节）；版本快照不影响已通过的评审记录 |
| 5 | RACI：每项活动/交付物**有且只有一个 Accountable** | 维基百科及多个项目管理站点，读到摘要 | 工作项单一负责人；每个关卡由一种角色承担 A |
| 6 | BPM 生命周期六阶段：识别 → 发现 → 分析 → 重构 → 实施 → 监控 | 教材《Fundamentals of Business Process Management》检索摘要 | 第 5 节七阶段是其落地：收集 = 发现，分析立项 = 识别 + 分析，需求确认与方案设计 = 重构，系统改造与试运行 = 实施，验收上线与运营优化 = 监控与持续改进 |
| 7 | 定期的"自动签到"式提问（如每周计划）取代状态会议 | Basecamp 官方功能页，读到摘要 | 项目简报到期提醒（第 11 节） |
| 8 | 开源项目体量大（Rails / PHP / 多服务），许可证以 AGPL / GPL 为主 | GitHub API 数据 | 不整体引入，自研轻量模块 |

### 2.3 取舍

**借鉴**：角色化的工作入口；健康度随简报更新；模板化立项（阶段 + 必交付物一次生成）；
工作项单一负责人；会签/或签的完成条件；不可变事件流做时间线；逾期与评审积压的主动提醒。

**不做**：自定义字段引擎、可配置工作流状态机、可配置权限方案、甘特图、工时统计、
论坛/Wiki/聊天、组织架构同步、内嵌 BPM 引擎。这些要么与目标无关，要么是上面这些开源项目
上万行代码的主要来源。

### 2.4 未核实与未覆盖

- 未调研：monday.com、ClickUp、Notion、Trello、Wrike、Airflow 类工具，以及国内的钉钉、企业微信、Teambition、TAPD、Worktile。
- 未取到数据：Taiga、Focalboard 的仓库地址已迁移。
- Asana 的四种项目角色未找到官方帮助页，仅见社区指南。
- 钉钉审批的帮助页需登录，企业微信审批只读到接口文档层面的节点类型与状态；两者的超时规则细节未核实。
- 方法论部分只核实了 RACI 与 BPM 生命周期；Stage-Gate、PMBOK、ITIL 4、TOGAF、ISO 9001 未单独核实。
- Workflow Patterns、Temporal、jBPM、Flowable 未深入（Flowable 页面加载失败）。

---

## 3. 设计原则

| # | 原则 | 说明 |
|---|---|---|
| A1 | **PostgreSQL 单一事实源，单事务状态迁移** | 沿用 `collab-architecture.md` D2；关卡提交/表决、阶段推进在同一事务内完成，项目行锁串行化 |
| A2 | **模板驱动，立项即实例化** | 阶段、必交付物、评审规则由"阶段模板"定义；项目创建时一次生成，不必逐项目配置 |
| A3 | **责任唯一** | 每个工作项只有一个负责人；需要多人各自完成的拆成多条（与收集表"会签 = 多方并行"的语义一致，D3） |
| A4 | **两层角色** | 系统角色管系统，项目角色按项目授予；用户岗位角色作为默认值 |
| A5 | **事件流是审计与时间线的唯一来源** | 沿用 D5 / F2；一切写操作追加不可变事件 |
| A6 | **关卡即审批，会签/或签语义明确** | 与收集表已采集的"会签（全部通过）"概念对齐，不另造词 |
| A7 | **按角色组织界面** | 每个角色登录后先看到"待我处理"，而不是项目全貌 |
| A8 | **渐进实时** | 站内通知先轮询，SSE 后置（D6） |
| A9 | **不引入 BPM 引擎、微服务、Redis** | 概念与 BPMN 对齐（便于将来导出/迁移），实现用显式状态表 + Go 事务 |

---

## 4. 角色模型

### 4.1 三层概念

```
系统角色  users.role       admin | member          ——只管系统管理（用户、模板、系统库、兜底）
岗位角色  users.job_role   cto | pm | handler | dev | viewer ——全局岗位
项目角色  project_members.role   pm | handler | dev | viewer ——按项目授予，一人可兼多个

显示名（界面、导出、时间线一律用英文缩写）  cto→CTO  pm→PM  handler→BH 业务经办  dev→TH 科技经办  viewer→PMO 项目管理办公室
```

**显示名与存储代码不是字面对应**：2026-11-25 岗位统一改叫 GM / CTO / PM / 业务经办 / 科技经办，并要求一律用英文缩写；
同日用户要求把 GM 改成 PMO，原"观察者"的显示名随改为 PMO（中文全称：项目管理办公室）。
库里已经存着 `handler / dev / viewer` 这些代码，没有做数据迁移，只换了显示名；对照表在前端 `lib/labels.ts` 与后端
`export.go`、`template.go` 的 `jobRoleLabel`，两处要一起改。PMO 沿用原"观察者"的权限：全局岗位本身不带写权限，
所有人本来就能查看全部项目，所以 PMO 能看全部、不能改；被管理员加进某个项目后仍是只读成员。

**2026-11-26 起 PMO 多了三项岗位职责**（需求承接，见第 21 节）：给新流程做初级分析、指派 PM、对方案做终审。
这三件事是岗位自带的，不需要被加进项目；项目里其余的内容对 PMO 仍然只读。

有效权限 = f(系统角色, 岗位角色, 该用户在本项目的项目角色集合)
```

**CTO 是全局岗位**：所有 `job_role = cto` 的用户自动拥有每一个项目的 CTO 权限，不需要逐个项目添加——
CTO 评审的是全公司的技术方案，本来就跨越所有项目。PM、BH、TH、PMO 则按项目授予。

### 4.2 角色定义

| 角色 | 定位 | 核心职责 | 关键权限 |
|---|---|---|---|
| **PM（项目经理）** | 对项目交付负责（Accountable） | 分析评估、制定计划、拆解任务、推进阶段、提交评审、组织试运行、写简报 | 分配 BH、创建与指派工作项、推进阶段、提交评审、修改流程 |
| **CTO（技术负责人）** | 全局岗位，技术决策与关卡审批 | 立项 / 方案 / 上线准备 / 验收评审；技术风险裁决；必要时代管项目 | 查看全部项目、关卡表决、驳回、分配 TH、取消项目、跳过阶段、修改流程 |
| **BH（业务经办）** | 业务侧执行与确认 | 确认现状与需求、提供材料、执行试运行、反馈问题 | 需求基线 / 试运行结论关卡表决、完成被指派任务、评论、修改流程 |
| **TH（科技经办，可选）** | 承接系统改造任务 | 开发、配置、联调、测试 | 完成被指派任务、评论、修改流程 |
| **PMO（项目管理办公室）** | 需求承接的把关人（21 节） | 新流程的初级分析、指派 PM、终审；查看全部项目与数据大屏 | 初级分析、指派 / 更换 PM 与主负责、终审；其余只读 |
| 系统管理员 | 系统配置与兜底 | 用户与岗位、阶段模板、系统库；评审人缺位时代行；强制流转 | 全部 |

**成员分配按类划分**（`caps.canAssign`）：管理员分配全部——PM、BH、TH、PMO；**PMO 指派 PM**（含指定主负责）；CTO 分配 TH；PM 分配 BH。

**"修改流程"放开到节点上的人**（`caps.editFlow`）：流程定义是项目的 To-Be 工作副本，节点上的经办人最清楚流程实际
怎么走，所以项目里的 PM、BH、TH 都能改（表单与流程图两个编辑器），管理员与 CTO 照旧；PMO 成员与项目外的人不能改。
它和"计划与推进"（`caps.manage`，仍是管理员 / CTO / PM）是两项独立的能力。入口有三处：项目页头的「修改流程」
（直接打开流程图编辑器）、「流程」标签里的「编辑表单 / 编辑流程图」、后台「流程定义」列表的「编辑」（管理员）。
每次保存都写入时间线（`edited_form` / `edited_chart`），版本快照仍由关卡触发。

**"BH 是多人"**：一个流程里每一步的经办部门/人员可能不同。立项时从"流程中出现的经办人员 ∪ 申报人"
按姓名匹配用户，勾选成为项目的 BH 成员；需求基线、试运行结论两个关卡由他们**会签**。

### 4.3 RACI 矩阵（R 负责 · A 问责 · C 咨询 · I 知会）

| 活动 | PM | CTO | BH | 管理员 |
|---|---|---|---|---|
| 分析评估（价值/复杂度/优先级/量化指标） | **A/R** | C | C | — |
| G1 立项决策 | R（提交） | **A** | I | I |
| 指派 PM、组建团队 | R（BH） | R（TH） | — | **A/R**（PM、PMO 及全部） |
| 需求确认（现状核对、痛点、KPI 基线） | **A/R** | C | R | — |
| G2 需求基线 | R（提交） | C | **A**（会签确认） | — |
| 方案设计（To-Be 流程、系统/接口/移动端方案、计划） | **A/R** | C | C | — |
| G3 方案评审 | R（提交） | **A** | C | — |
| 系统改造（任务拆解、开发、联调、测试） | **A** | C | C | — |
| G4 上线准备 | R（提交） | **A** | C | — |
| 试运行（UAT） | **A**（组织） | C | R（执行） | — |
| G5 试运行结论 | R（提交） | C | **A**（会签通过） | — |
| G6 验收与发布 | R（提交） | **A** | I | I |
| 运营监控与周期复盘 | R | I | C（反馈） | — |

**阶段 1「分析立项」内部是一条需求承接的小闭环**（21 节），其中三件事的问责人是 PMO：

| 活动 | PMO | PM | CTO | 管理员 |
|---|---|---|---|---|
| 初级分析（价值 / 复杂度 / 优先级 / 流程是否完整） | **A/R** | — | — | 兜底 |
| 指派 PM（一名或多名，其中一名主负责） | **A/R** | — | — | 兜底 |
| 三条推进线的原因与解决方案 | I | **A/R**（可把一条线交给 BH / TH 负责） | 应邀协助 | — |
| 技术可行性评估（逐个技术点） | I | R（提交） | **A** | 裁决 |
| 终审 | **A/R** | R（按意见整改） | I | 兜底 |

---

## 5. 端到端生命周期

### 5.1 主线

```
收集 ─▶ ①分析立项 ─▶ ②需求确认 ─▶ ③方案设计 ─▶ ④系统改造 ─▶ ⑤试运行 ─▶ ⑥验收上线 ─▶ ⑦运营优化
            │G1           │G2           │G3           │G4          │G5          │G6          │周期复盘(非门禁)
          CTO或签       经办会签       CTO会签       CTO或签      经办会签      CTO会签
```

②–⑥ 就是现有的五个改造阶段（需求确认 / 方案设计 / 系统改造 / 试运行 / 验收），前后各加一段：
前面补"分析立项"（把现有"需求分析 + 指派"并入并升级为 CTO 决策的门），后面补"运营优化"（上线不是终点）。

阶段 1 内部另有一条需求承接的小闭环（21 节）：PMO 初级分析 → 指派 PM → PM 按优先级推进 → CTO 逐个技术点评估技术可行性
→ PMO 终审。终审通过时 G1 才算通过、进入阶段 2；终审退回则回到 PM 推进，重提后另起一轮评估。

### 5.2 默认阶段模板

| 序 | 阶段 | 出口关卡 | 评审人 | 表决 | 必交付物（提交评审前须完成） | 默认任务 |
|---|---|---|---|---|---|---|
| 1 | 分析立项 | G1 立项评审 | CTO | 或签 | 分析报告 | 现状分析、价值/复杂度/优先级、初步方案与收益、指派 PM 与经办 |
| 2 | 需求确认 | G2 需求基线 | 经办 | 会签 | 现状核对记录、需求清单、KPI 基线 | 现状走查、痛点与需求、KPI 基线 |
| 3 | 方案设计 | G3 方案评审 | CTO | 会签 | To-Be 流程（基线版本）、系统改造方案、实施计划 | To-Be 流程设计、接口/数据互通方案、移动端方案、计划与资源 |
| 4 | 系统改造 | G4 上线准备 | CTO | 或签 | 测试报告、上线与回滚方案、培训材料 | 开发/配置、联调、测试、培训 |
| 5 | 试运行 | G5 试运行结论 | 经办 | 会签 | UAT 结果、问题清单（闭环） | UAT 执行、问题跟踪 |
| 6 | 验收上线 | G6 验收 | CTO | 会签 | 验收报告、已发布流程版本 | 验收、发布、复盘 |
| 7 | 运营优化 | — | — | — | 运营指标记录 | 指标跟踪、优化项（可再次立项） |

规则：
- **评审人集合**：CTO 关卡 = 全部 CTO 岗位用户；经办关卡 = 项目内的经办成员；为空时回退系统管理员（流程不会因缺人而卡死）。
- **或签**：首位表决人决定——通过即过、驳回即驳回，其余待决票作废。**会签**：全部通过才过，任一驳回即驳回。
- **驳回**：阶段退回"进行中"，PM 修改后可再次提交（评审轮次 +1），历史轮次全部保留。
- **阶段模板可在后台配置**（`stage_templates` 表；内置的七阶段模板在首次启动时写入）。模板只在**立项时**生效：建项目时把当时的模板快照进 `projects.template`，此后阶段名、评审规则、版本快照时机、完成前置条件一律读项目自己的快照——所以改模板只影响此后新建的项目，已立项的项目不受影响。
- **阶段标识（`key`）不可改，且三个标识带语义**：`design` 的关卡通过时留存 To-Be 基线；`accept` 的关卡通过时留存已发布版本，且通过后才可标记项目完成（没有 `accept` 时取最后一个带关卡的阶段）；`intake` **排在第一位时**这个阶段按需求承接走（21 节），排在别处或不出现时不生效，项目仍按普通关卡走。

### 5.3 状态模型

```
项目状态   active（在途） | on_hold（搁置） | cancelled（已取消） | done（已完成）
阶段状态   pending ─▶ in_progress ─▶ in_review ─▶ approved ─▶ (下一阶段 in_progress)
                 ▲           ▲            │
                 └── skipped ┘ ◀── 驳回 ───┘
评审单     pending ─▶ approved | rejected | withdrawn（PM 撤回）
```

**"待谁处理"（派生字段 `pending_on`）**——界面与通知都靠它：

| 条件 | pending_on |
|---|---|
| 阶段 1 且未指派 PM | `admin`（待指派） |
| 阶段 `in_progress` | `pm` |
| 承接阶段、还没有 PM（模板第一阶段是承接阶段） | `pmo`（待初级分析或指派） |
| 技术可行性评估已通过、等 PMO 终审 | `pmo`（待终审） |
| 阶段 `in_review` | 该关卡的评审角色（`cto` / `handler`） |
| 项目 `on_hold` / `cancelled` / `done` | 空 |

### 5.4 与现有跟进状态的映射（迁移用）

| 现 `follow_status` + `stage` | 新项目状态 + 当前阶段 |
|---|---|
| `analyzing` / `unassigned` | active，阶段 1（未指派 PM 时阶段为 pending） |
| `following` + stage 0–5 | active，阶段 = stage + 1（0 记为 1） |
| `review` | active，阶段 6 `in_review` |
| `done` | done，阶段 6 `approved` |
| `shelved` | on_hold，阶段按原 `stage` 推算 |

---

## 6. 领域模型

```
Process（流程定义，已有）
 ├─ ProcessVersion ── As-Is / To-Be / Published（steps 快照，不可变）
 └─ ProcessProject ── 流程项目（1 流程同时只有 1 个在途项目；运营优化后可再次立项）
     ├─ ProjectMember ── user × role（pm / handler / dev / viewer；CTO 为全局岗位）
     ├─ ProjectStage ─── 7 行（seq 1..7，status，entered/exited，due_date）
     │    └─ GateReview ─ 一轮评审（round，summary，status）
     │         └─ GateReviewer ─ 每位评审人一行（decision，comment）
     ├─ WorkItem ─────── 任务 / 交付物 / 问题 / 风险 / 变更（归属阶段，单一负责人）
     │    ├─ WorkItemLink ── blocks / relates
     │    └─ Comment ───── 评论、@提及
     ├─ Comment(kind=update) ─ 项目简报（周报）
     ├─ Event ────────── 不可变事件流（时间线 / 审计）
     └─ Notification ── 站内通知（幂等键去重）
```

---

## 7. 数据模型（PostgreSQL 增量）

ID 沿用 32 位十六进制 `TEXT`；全部 `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，幂等。

```sql
-- 用户：补显示名、部门、岗位角色（系统角色 role 不变）
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS department   TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role     TEXT NOT NULL DEFAULT 'handler';

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  process_id    TEXT NOT NULL REFERENCES processes(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',    -- active | on_hold | cancelled | done
  current_stage SMALLINT NOT NULL DEFAULT 1,       -- 1..7
  priority      TEXT NOT NULL DEFAULT 'medium',    -- high | medium | low
  value         TEXT NOT NULL DEFAULT '',          -- 改造价值:高/中/低
  complexity    TEXT NOT NULL DEFAULT '',          -- 复杂度:高/中/低
  analysis      JSONB NOT NULL DEFAULT '{}',       -- 分析报告(原 processes.analysis 迁入并扩展)
  health        TEXT NOT NULL DEFAULT 'on_track',  -- on_track | at_risk | off_track(PM 简报时评估)
  due_date      DATE,
  started_at    TIMESTAMPTZ,                       -- 指派 PM 的时间
  completed_at  TIMESTAMPTZ,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);
-- 一个流程同时只有一个在途项目
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active ON projects (process_id)
  WHERE status IN ('active', 'on_hold');

CREATE TABLE project_stages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq        SMALLINT NOT NULL,                    -- 1..7
  status     TEXT NOT NULL DEFAULT 'pending',      -- pending | in_progress | in_review | approved | skipped
  entered_at TIMESTAMPTZ,
  exited_at  TIMESTAMPTZ,
  due_date   DATE,
  UNIQUE (project_id, seq)
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,                        -- pm | handler | dev | viewer（CTO 是全局岗位，不在此表）
  added_by   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, user_id, role)
);

CREATE TABLE gate_reviews (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  stage_seq    SMALLINT NOT NULL,
  round        SMALLINT NOT NULL DEFAULT 1,        -- 第几轮提交
  status       TEXT NOT NULL,                      -- pending | approved | rejected | withdrawn
  summary      TEXT NOT NULL DEFAULT '',           -- PM 提交说明
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reviews_pending ON gate_reviews (project_id, stage_seq, round DESC);

CREATE TABLE gate_reviewers (
  review_id  TEXT NOT NULL REFERENCES gate_reviews(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,                        -- 以何角色评审
  decision   TEXT NOT NULL DEFAULT 'pending',      -- pending | approve | reject
  comment    TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  PRIMARY KEY (review_id, user_id)
);

CREATE TABLE work_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  stage_seq   SMALLINT,
  type        TEXT NOT NULL DEFAULT 'task',        -- task | deliverable | issue | risk | change
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo',        -- todo | in_progress | blocked | in_review | done | cancelled
  priority    TEXT NOT NULL DEFAULT 'medium',
  assignee_id TEXT REFERENCES users(id),           -- 单一负责人
  parent_id   TEXT REFERENCES work_items(id),      -- 子任务
  due_date    DATE,
  block_reason TEXT NOT NULL DEFAULT '',           -- 转 blocked 时必填
  labels      JSONB NOT NULL DEFAULT '[]',
  checklist   JSONB NOT NULL DEFAULT '[]',         -- [{id,text,done}]
  required    BOOLEAN NOT NULL DEFAULT false,      -- 阶段必交付物(计入关卡准入)
  done_at     TIMESTAMPTZ,
  sort_key    BIGINT NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_items_project ON work_items (project_id, stage_seq, status);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON work_items (assignee_id, status);

CREATE TABLE work_item_links (
  from_id TEXT NOT NULL REFERENCES work_items(id),
  to_id   TEXT NOT NULL REFERENCES work_items(id),
  kind    TEXT NOT NULL,                           -- blocks | relates
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  item_id    TEXT REFERENCES work_items(id),       -- 空 = 项目级
  review_id  TEXT REFERENCES gate_reviews(id),     -- 评审意见
  kind       TEXT NOT NULL DEFAULT 'comment',      -- comment | update(项目简报)
  body       TEXT NOT NULL,
  structured JSONB NOT NULL DEFAULT '{}',          -- 简报的四栏:{progress,next,risks,help}
  mentions   JSONB NOT NULL DEFAULT '[]',          -- 被提及的 user_id
  author_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments (project_id, created_at DESC);

CREATE TABLE process_versions (
  id         TEXT PRIMARY KEY,
  process_id TEXT NOT NULL REFERENCES processes(id),
  project_id TEXT REFERENCES projects(id),
  version    INTEGER NOT NULL,
  kind       TEXT NOT NULL,                        -- as_is | to_be | published
  steps      JSONB NOT NULL,
  metrics    JSONB NOT NULL DEFAULT '{}',          -- 第 15 节的流程改善指标,存快照时刻的值
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (process_id, version)
);
-- 快照时机由关卡引擎自动触发:建项目时 as_is;G3 通过时 to_be;G6 通过时 published。
-- processes.steps 始终是"当前工作副本"(To-Be 草稿),现有表单/流程图编辑器照常编辑它。

-- 统一事件流（followup_events 的升级版，旧表数据迁入）
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  source_id  TEXT UNIQUE,                          -- 迁入的旧事件 ID(幂等,防重复导入)
  project_id TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'project',      -- project | stage | review | item | member | process
  target_id  TEXT NOT NULL DEFAULT '',
  actor_id   TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id, id DESC);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  project_id TEXT,
  item_id    TEXT,
  review_id  TEXT,
  title      TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,                        -- 幂等:如 overdue:{item}:{date}
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);

-- P3:阶段模板(后台可改)与项目上的模板快照(立项时写入,见 5.2)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template JSONB NOT NULL DEFAULT '[]';
CREATE TABLE stage_templates (
  seq           SMALLINT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,              -- 阶段标识,不可改;design / accept 带语义
  name          TEXT NOT NULL,
  gate          TEXT NOT NULL DEFAULT '',          -- 空 = 无门禁
  reviewer_role TEXT NOT NULL DEFAULT '',          -- cto | handler
  mode          TEXT NOT NULL DEFAULT '',          -- all = 会签;any = 或签
  required      JSONB NOT NULL DEFAULT '[]',       -- 必交付物
  tasks         JSONB NOT NULL DEFAULT '[]',       -- 默认任务
  updated_at    TIMESTAMPTZ NOT NULL
);

-- P3:外部通知渠道与投递记录(见第 11 节)
CREATE TABLE notify_channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,                      -- wecom | dingtalk | feishu | email
  webhook      TEXT NOT NULL DEFAULT '',           -- 机器人地址(本身即凭据)
  secret       TEXT NOT NULL DEFAULT '',           -- 加签 / 签名校验密钥
  smtp_host    TEXT NOT NULL DEFAULT '',
  smtp_port    INTEGER  NOT NULL DEFAULT 465,
  smtp_user    TEXT NOT NULL DEFAULT '',
  smtp_pass    TEXT NOT NULL DEFAULT '',
  smtp_from    TEXT NOT NULL DEFAULT '',
  recipients   TEXT NOT NULL DEFAULT '',           -- 收件邮箱,逗号分隔
  kinds        JSONB   NOT NULL DEFAULT '[]',      -- 转发的通知类型;空 = 默认集合
  enabled      BOOLEAN NOT NULL DEFAULT true,
  kinds_since  TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01',  -- 当前转发范围的生效时间
  last_error   TEXT NOT NULL DEFAULT '',
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
CREATE TABLE notify_deliveries (                   -- 每个渠道对一条逻辑通知只处理一次
  channel_id      TEXT NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  project_id      TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  day             TEXT NOT NULL DEFAULT '',        -- 按天重复的提醒带日期
  sent_at         TIMESTAMPTZ,                     -- 发送时间;NULL = 未发出
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,                     -- 下次重试时间;未发出且为空 = 已放弃
  last_error      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel_id, kind, project_id, title, day)
);

-- 需求承接(见第 21 节)。projects 加五列:
--   lead_pm_id 主负责 PM | triage_done_at / triage_by 初级分析 | final_status / final_review_id 等终审 | cto_support CTO 协助现状(JSON)
--   intake_passed_at 终审通过、承接完成的时间(为空 = 没走完过承接,见 21.8)
CREATE TABLE intake_reviews (                    -- 流程是否完整、综合方案总述(每个项目一行)
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  completeness      TEXT NOT NULL DEFAULT '',   -- complete | gaps
  completeness_note TEXT NOT NULL DEFAULT '',
  summary           TEXT NOT NULL DEFAULT '',
  updated_by        TEXT NOT NULL DEFAULT '',
  updated_at        TIMESTAMPTZ NOT NULL
);
CREATE TABLE intake_lines (                      -- 三条推进线:原因、解决方案、负责人
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL,                      -- offline | interop | mobile
  reason     TEXT NOT NULL DEFAULT '',
  solution   TEXT NOT NULL DEFAULT '',
  owner_id   TEXT NOT NULL DEFAULT '',           -- 负责人(项目成员)
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, line_key)
);
CREATE TABLE intake_node_plans (                 -- 每个节点的处理状态与说明
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL,
  node_key   TEXT NOT NULL,                      -- 自动诊断给出的节点标识
  status     TEXT NOT NULL DEFAULT 'pending',    -- pending | planned | na
  note       TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, line_key, node_key)
);
CREATE TABLE intake_points (                     -- 送 CTO 评估的技术点
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  sort_key   BIGINT NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE intake_assessments (                -- 每一轮评审、每位评审人对每个技术点的结论;历史全部保留
  review_id  TEXT NOT NULL REFERENCES gate_reviews(id) ON DELETE CASCADE,
  point_id   TEXT NOT NULL REFERENCES intake_points(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  verdict    TEXT NOT NULL,                      -- feasible | conditional | infeasible
  note       TEXT NOT NULL DEFAULT '',           -- 附条件的条件,或不可行时的替代方案
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (review_id, point_id, user_id)
);
CREATE TABLE intake_finals (                     -- PMO 历次终审结论
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_id  TEXT NOT NULL DEFAULT '',           -- 终审对象:哪一轮技术可行性评估
  round      SMALLINT NOT NULL DEFAULT 0,
  decision   TEXT NOT NULL,                      -- passed | passed_with_notes | returned
  note       TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ NOT NULL
);
```

**明确不建的东西**：自定义字段引擎、可配置工作流状态机、组织架构表、附件表（P3 再评估）。

### 7.1 存量迁移

1. 每条 `processes` 按 5.4 的映射生成 1 个 `projects` + 7 行 `project_stages`；`analysis/value/complexity/due_date` 迁入。
2. 原 `assignee_id` → `project_members(role='pm')`；管理员建号时补 `job_role`（存量默认 `handler`，由管理员批量改一次）。
3. `followup_events` 全量写入 `events`（`scope='process'`），旧表保留只读一个版本后删除。
4. `processes.steps` 当前内容存为 `process_versions(kind='as_is', version=1)`。
   注意：存量流程若已被原地编辑过（存在 `edited_*` 事件），这份"As-Is"可能已含改动，迁移时在 `note` 标注。
5. `processes` 上的跟进列停止写入，保留两个版本后删除；`follow_status` 等对外字段由项目数据派生，前端类型同步调整。
6. 启动时自动为"还没有项目"的流程补建项目（幂等）；旧的 `analyze / assign / status / stage` 接口随旧看板下线，由项目接口取代。

---

## 8. 权限矩阵（服务端逐请求校验，前端只做显隐）

| 动作 | PM | CTO | BH | TH | PMO | 管理员 |
|---|---|---|---|---|---|---|
| 查看项目、阶段、工作项、时间线 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 查看项目（非成员，已登录） | ✓（默认透明，见待决策 4） | | | | | ✓ |
| 指派 / 更换 PM、指定主负责、增删 PMO | — | — | — | — | ✓（PM） | ✓ |
| 分配 BH | ✓ | — | — | — | — | ✓ |
| 分配 TH | — | ✓ | — | — | — | ✓ |
| 修改优先级、截止日、健康度、简报 | ✓ | ✓ | — | — | — | ✓ |
| 推进阶段、提交评审、撤回评审 | ✓ | ✓ | — | — | — | ✓ |
| 关卡表决（通过 / 驳回） | — | ✓（CTO 关卡） | ✓（BH 关卡） | — | — | ✓ |
| 搁置 / 恢复 | ✓ | ✓ | — | — | — | ✓ |
| 取消项目 | — | ✓ | — | — | — | ✓ |
| 创建 / 编辑 / 指派工作项 | ✓ | ✓ | 自己创建的 | 自己创建的 | — | ✓ |
| 完成被指派的工作项 | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| 评论、@提及 | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| 修改流程定义（To-Be 工作副本：表单与流程图） | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| 需求承接（21 节）：初级分析 | — | — | — | — | ✓（指派第一位 PM 前） | ✓ |
| 需求承接：三条推进线的原因 / 方案 / 节点状态 | ✓ | ✓ | 仅自己负责的那条 | 仅自己负责的那条 | — | ✓ |
| 需求承接：更换推进线负责人、申请 CTO 协助 | ✓ | ✓ | — | — | — | ✓ |
| 需求承接：响应 CTO 协助（加入） | — | ✓ | — | — | — | ✓ |
| 需求承接：技术点逐项评估并表决 | 提交 | ✓ | — | — | — | 裁决 |
| 需求承接：终审（通过 / 有保留通过 / 退回整改） | — | — | — | — | ✓ | ✓ |

口径与现状一致：**登录即可读**；写权限按上表；每个处理函数开头统一调用 `requireProject(sd, action, projectID)`，拒绝返回 403。

---

## 9. 关卡引擎

### 9.1 规则

1. 进入阶段 N 的条件：阶段 N-1 为 `approved`（N=1 无条件，但未指派 PM 时保持 `pending`）。
2. 提交评审（PM）：校验该阶段所有 `required` 工作项已 `done`，否则返回缺失清单。
3. 提交即生成评审单：`gate_reviews(round+1)` + 按"阶段模板的评审角色 × 表决规则"为每位评审人生成 `gate_reviewers`。
4. 表决：评审人只能投一次（主键 `(review_id, user_id)` 天然幂等）。
   - 或签：首个 `approve` → 评审单 `approved`，其余票作废；
   - 会签：全部 `approve` → `approved`；任一 `reject` → 立即 `rejected`。
5. `approved` → 阶段 `approved`、写 `exited_at`，**同事务自动进入下一阶段**并写事件、通知全体成员。
6. `rejected` → 阶段回到 `in_progress`，驳回意见进入时间线并通知 PM。
7. 阶段 7 无门禁；项目 `done` 由 PM 在复盘后手动关闭，或保持 `active` 持续运营。
8. 版本快照随关卡自动发生：建项目时存 As-Is；G3 通过时存 To-Be 基线；G6 通过时存已发布版。
9. 回退：PM / CTO / 管理员可把项目退回到任一已通过的阶段重做（须填原因），其后的阶段重置为待开始，已通过的评审记录保留。
   跳过：CTO / 管理员可把某阶段标记为跳过并继续（须填原因），用于流程很轻、不需要完整评审的小改造。
10. **承接阶段的评审是技术可行性评估**（21 节），复用同一张评审单，差别有三：提交的准入条件换成"承接方案齐备"（模板里的必交付物在提交时一并记为完成）；
    表决时对每个技术点给结论，全部有了结论才能通过；通过后阶段**不立即前进**——`final_status = 'pending'` 等 PMO 终审，
    这期间阶段状态在数据上仍是 `in_review`（方案继续锁定），终审通过才走第 5 条的自动进入下一阶段。

### 9.2 并发

所有项目级写操作走同一事务骨架（沿用 `collab-architecture.md` 4.2 的思路）：

```
BEGIN
  SELECT * FROM projects WHERE id=$1 FOR UPDATE          -- 项目行锁,串行化同一项目的动作
  校验调用者权限 + 当前阶段/评审单状态合法性
  写业务行 + INSERT events + INSERT notifications(幂等键)
  UPDATE projects SET version = version + 1
COMMIT
```

两名 CTO 同时表决同一会签关卡：行锁串行化，后者看到最新票数后判定，不会重复触发"通过"事件。
PM 提交与 CTO 表决同时到达：按锁先后决定先后，结果确定且可由事件流还原。

---

## 10. 工作项、评论与简报

- **类型**：`task` 任务、`deliverable` 交付物、`issue` 问题、`risk` 风险、`change` 变更。
  五类共用一张表与同一套状态，用类型和标签区分——不按类型拆表（避免过度建模）。
- **状态**：`todo → in_progress → in_review → done`，任一在途态可转 `blocked`（须填阻塞原因）或 `cancelled`。
- **单一负责人**；需要多人各自完成时由 PM 一键"按成员拆分"生成 N 条。
- **依赖**：`blocks` 关系用于时间线视图与"被阻塞"提示，不做强校验（可先完成被阻塞项，仅提示）。
- **必交付物**：模板生成的 `deliverable` 且 `required=true`，是关卡准入条件（9.1 第 2 条）。
- **评论**：项目级、工作项级、评审级三处；正文解析 `@显示名` 生成 `mentions` 并发通知。
- **项目简报**（`comments.kind='update'`）：PM 定期填写固定四栏——本期进展、下期计划、风险与阻塞、需要的支持，
  同时更新 `health`。CTO 在组合视图按健康度扫一眼就知道哪些项目要介入。

---

## 11. 通知与调度

**触发规则**

| 事件 | 接收人 | 时机 |
|---|---|---|
| 提交评审 | 本轮评审人 | 即时 |
| 评审通过 / 驳回 | PM、全体成员 | 即时 |
| 指派或更换 PM | 新 PM、CTO | 即时 |
| 加入项目 | 新成员 | 即时 |
| 工作项指派 / 改期 | 负责人 | 即时 |
| @提及、被评论 | 被提及人、工作项负责人 | 即时 |
| 进入新阶段 | 全体成员 | 即时 |
| 工作项逾期、阶段逾期 | 负责人 / PM（阶段逾期抄送 CTO） | 每日一次 |
| 评审等待超过 N 天 | 评审人，抄送管理员 | 每日一次 |
| 简报到期未写 | PM | 每周一次 |

**实现**：单进程 `scheduler.go`，每分钟一次 tick，扫描到期/逾期/评审积压，写 `notifications`（`dedupe_key` 保证不重复）。
站内通知前端轮询（30s，沿用大屏的做法）。

**外部通知渠道**（`channels.go`、`channels_delivery.go`，P3）：管理员在后台配置渠道（企业微信 / 钉钉 / 飞书群机器人、SMTP 邮件），
每种渠道实现同一个 `notifier` 接口（`Send(ctx, lines)`），接入新渠道只需实现它并在 `notifierFor` 登记。

- **不在业务事务里做网络调用**：站内通知照常写 `notifications`；后台任务每 15 秒把各启用渠道此刻该转发的通知发出去。外部服务不可用不影响业务写入。
- **一条逻辑通知只发一次**：同一件事会给每个相关的人各写一条站内通知，转发时按（类型、项目、标题）归并，群里只出现一行；`notify_deliveries` 的主键挡住重复投递。
- **不回放历史**：新建渠道、或修改转发范围之后，只转发此后新产生的通知（取渠道创建时间与范围生效时间中较晚者）。
- **失败重试**：发送失败记下错误，按 1 分钟 → 5 分钟 → 15 分钟 → 1 小时 → 3 小时退避，第 6 次失败后放弃并留在投递记录里；渠道卡片显示最近一次错误，可随时发测试消息。
- **默认转发范围**：新流程提交、评审提交 / 通过 / 驳回 / 积压、逾期、阶段回退 / 跳过、项目状态变更。任务指派、@提及、评论这类个人向的通知默认不进群，可在渠道里勾选。
- **按天重复的提醒**（逾期 / 评审积压 / 简报到期）在外部渠道同样每天只提醒一次。
- **凭据**：Webhook 地址（key / token 就在里面）、签名密钥、邮箱口令存在 `notify_channels`；接口只返回脱敏值，修改时传回脱敏值或留空都表示"不改"。
- 消息以「ReForge 流程再造」开头（机器人用关键词校验时把关键词设为它即可）；设置了 `FLOW_PUBLIC_URL` 时末尾附工作台链接。
多实例部署时用 PostgreSQL 咨询锁保证只有一个调度器生效。

---

## 12. API（增量，均走既有 `/api` 前缀与会话鉴权）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/projects` | 登录 | `view=mine` 只看自己参与；`pending=cto\|handler\|pm\|pmo\|admin` 按"待谁处理"筛选；`status`、`q` 按状态与名称筛选 |
| GET | `/api/projects/{id}` | 登录 | 项目 + 阶段 + 成员 + 当前评审 + 工作项统计 + 改善指标 + 经办候选 + 我的能力 |
| PATCH | `/api/projects/{id}` | PM / CTO / 管理员 | 优先级、改造价值、复杂度、目标完成日、分析报告 |
| POST | `/api/projects/{id}/status` | 见下 | `{status, note}`：搁置 / 恢复 / 完成（PM / CTO / 管理员）、取消（CTO / 管理员，须填原因，待决评审一并作废） |
| PUT | `/api/projects/{id}/members` | 见第 8 节 | `{userId, role, action, lead?}`；管理员分配全部，PMO 指派 PM（`lead: true` 指定主负责），CTO 分配 TH（`dev`），PM 分配 BH（`handler`）；第一位 PM 到岗时阶段 1 启动 |
| PATCH | `/api/auth/profile` | 登录 | `{displayName?, department?}` 改自己的显示名与部门；岗位与系统角色仍由管理员维护 |
| POST | `/api/auth/password` | 登录 | `{oldPassword, newPassword}` 改自己的密码，改完吊销该账号的其他会话。管理员建号的账号首次登录必须先走这里，此前除身份、改资料、改密码、注销外的接口一律 403 `PASSWORD_CHANGE_REQUIRED` |
| POST | `/api/projects/{id}/stages/{seq}/enter` | PM / CTO / 管理员 | 回退到某阶段（须填原因），其后阶段重置 |
| POST | `/api/projects/{id}/stages/{seq}/skip` | CTO / 管理员 | 跳过当前阶段（须填原因） |
| GET | `/api/projects/{id}/reviews` | 登录 | 历次评审轮次（新到旧，含每人一票） |
| POST | `/api/projects/{id}/reviews` | PM / CTO / 管理员 | `{summary}` 提交当前阶段评审 |
| POST | `/api/reviews/{id}/decide` | 本轮评审人（或补票、管理员裁决） | `{decision: approve\|reject, comment, points?}`，驳回必须填意见；`points` 是承接阶段对技术点的结论 `[{pointId, verdict, note}]`，通过前每个技术点都要有结论 |
| POST | `/api/reviews/{id}/withdraw` | PM / CTO / 管理员 | 撤回待决评审 |
| GET | `/api/projects/{id}/intake` | 登录 | 需求承接的完整视图（21 节）：环节、诊断、三条推进线、技术点与各轮结论、终审记录、缺项、我的能力 |
| PUT | `/api/projects/{id}/intake/triage` | PMO / 管理员 | `{value, complexity, priority, dueDate, conclusion, completeness, completenessNote, done}` 初级分析；`done` 要求必填项齐备 |
| PUT | `/api/projects/{id}/intake/solution` | PM / CTO / 管理员；某条线的负责人只能改自己那条 | `{completeness?, completenessNote?, summary?, lines:[{key, reason?, solution?, ownerId?}], nodes:[{line, key, status, note?}]}` 只传要改的部分；只能在 PM 推进时改 |
| POST | `/api/projects/{id}/intake/points`、PATCH / DELETE `/api/intake/points/{id}` | 同上 | 技术点的增、改（`{title?, line?, note?}`）、删；评估进行中不能改 |
| PUT | `/api/reviews/{id}/assessment` | 本轮评审人 | `{points:[{pointId, verdict, note}]}` 存结论草稿（可以先存一部分） |
| POST | `/api/projects/{id}/intake/cto-support` | 见请求体 | `{action: request\|withdraw\|join\|release, note?}`：申请（PM 等，须写事项）/ 撤回 / 加入（CTO）/ 结束 |
| POST | `/api/projects/{id}/intake/final` | PMO / 管理员 | `{decision: passed\|passed_with_notes\|returned, note}` 终审；后两种必须写意见 |
| GET | `/api/reviews/pending` | 登录 | 我还能表决的待决评审 |
| GET / POST | `/api/projects/{id}/items` | 见第 8 节 | 工作项（父子结构 + 关系）/ 创建 |
| PATCH / DELETE | `/api/items/{id}` | 见第 8 节 | 改字段与状态（带 `version` 做乐观并发）/ 删除（必交付物不可删） |
| POST / DELETE | `/api/items/{id}/links` | 项目成员 | `{toId, kind: blocks\|relates}` / `?toId=&kind=` |
| POST | `/api/items/{id}/split` | PM / CTO / 管理员 | `{userIds}` 按成员拆分，原条目成为汇总父项 |
| GET | `/api/me/items` | 登录 | 我的未完成任务 |
| GET / POST | `/api/projects/{id}/comments` | 项目成员 | 评论与简报列表 / 发评论（解析 @提及） |
| POST | `/api/projects/{id}/updates` | PM / CTO / 管理员 | 简报：`{progress, next, risks, help, health}` |
| GET | `/api/projects/{id}/versions`、`…/versions/{version}` | 登录 | 版本列表（含改善指标）/ 某版本完整步骤 |
| GET | `/api/projects/{id}/compare` | 登录 | As-Is 版本与当前工作副本的指标 |
| GET | `/api/projects/{id}/events` | 登录 | 时间线（最近 300 条） |
| GET | `/api/notifications`、POST `/api/notifications/read` | 登录 | 我的通知（`unread=1`）/ 标记已读 |
| GET | `/api/users` | 登录 | 用户目录（指派、选成员用；不含系统角色与口令） |
| PATCH | `/api/admin/users/{id}` | 管理员 | 显示名 / 部门 / 岗位 |
| PUT | `/api/admin/processes/{id}` | 项目成员（PM / BH / TH）/ CTO / 管理员 | 修改当前流程定义（To-Be 工作副本）；`?via=chart` 记为改流程图，否则记为改表单。还没挂到项目上的流程只有 CTO / 管理员能改 |
| GET / PUT | `/api/admin/stage-templates` | 管理员 | 当前阶段模板 / 整体替换 `{templates:[{key,name,gate,reviewerRole,mode,required,tasks}]}`；`?builtin=1` 取内置模板 |
| GET / POST | `/api/admin/notify-channels` | 管理员 | 外部通知渠道列表（凭据脱敏，附可转发的通知类型目录）/ 新建 |
| PATCH / DELETE | `/api/admin/notify-channels/{id}` | 管理员 | 修改（没传的字段不变）/ 删除（投递记录一并删除） |
| POST | `/api/admin/notify-channels/{id}/test` | 管理员 | 发一条测试消息，同步返回结果 |
| GET / POST | `/api/projects/export.csv` | 登录 | 项目清单 CSV（带 BOM，Excel 直接打开）；GET 导出全部或 `?status=`，POST `{ids}` 导出所选且顺序一致 |
| GET | `/api/projects/{id}/export` | 登录 | 单个项目的完整报告：Markdown（默认）或 `?format=json` |
| GET | `/api/overview`、`/api/admin/overview` | 登录 | 组合聚合（后者沿用旧大屏路径）；`full=1` 时附加趋势、PM 负载、申报部门、系统涉及度、最新动态、需求承接（全池诊断与承接积压） |

约定：权限不足 403、状态不允许 400、冲突 409；权限校验先于状态校验（无权的人拿不到项目状态信息）。
删除流程（`DELETE /api/processes/{id}`、`/api/admin/processes/{id}`，仅管理员，两条路由共用一个处理函数）会连同它的流程项目及全部关联记录一并删除，界面必须二次确认。删掉的东西在库里不留痕，所以成败各在后端日志里写一行（谁删了哪条，或失败原因）；失败时不再把内部错误原文返回给浏览器。
后端的访问日志、审计与浏览器上报汇总在第 20 节。
JSON 列表字段永远返回数组（Go 侧显式初始化空切片），不返回 `null`。

---

## 13. 后端模块结构

保持单体 `package main` + `net/http`，不引入框架，只按领域拆文件：

```
backend/
  main.go               服务器、newMux() 路由表、提交流程后自动立项
  auth.go · users.go    会话（带用户 ID）、登录 / 注册、用户目录、岗位修改
  perms.go              actor、caps、权限矩阵、currentActor()
  projects_model.go     Project / Stage / Review / WorkItem / Comment / Version / Event 等模型与 API 视图
  template.go           内置阶段模板、项目模板快照的取值方法、后台提交的校验、中文文案
  stage_templates.go    阶段模板表、首次启动写入内置模板、后台读写接口
  metrics.go            流程改善指标 ComputeMetrics()、经办候选 HandlerHints()
  store_project.go      建表、建项目、存量迁移 EnsureProjects()、事件与通知写入、批量读取与视图组装
  reviews.go · reviews_http.go   关卡引擎（提交 / 表决 / 撤回 / 通过联动）与接口
  intake.go · intake_store.go · intake_http.go · intake_review.go · intake_export.go
                          需求承接(21 节):自动诊断与规则 / 表与视图 / 承接方案的接口 / 逐点评估与终审 / 报告里的承接一节
  projects.go           路由注册、项目列表与详情、基本信息、状态、成员、回退、跳过、时间线
  overview.go           组合聚合(基础部分 + full=1 的趋势 / 负载 / 来源 / 系统 / 最新动态)
  export.go             项目清单 CSV、单个项目的 Markdown / JSON 报告
  channels.go · channels_delivery.go   外部通知渠道的配置与接口;notifier 实现(群机器人 / SMTP)与后台投递
  workitems.go          工作项、关系、拆分
  comments.go           评论、@提及、简报
  versions.go           版本列表、单版本、指标对比
  notify.go             通知接口与定时调度（逾期 / 评审积压 / 简报到期）
  followup.go           流程定义编辑（PUT）
  *_test.go             规则单元测试；连库的端到端与迁移测试
```

自动建项目：`POST /api/processes` 成功后创建项目（阶段 1、`pending`）并通知管理员"有新流程待立项"；
启动时 `EnsureProjects()` 为没有项目的流程补建，幂等。

---

## 14. 前端信息架构

```
/                      收集表单（现状保留）；顶栏入口：未登录「登录」、已登录「工作台」
/login                 唯一的登录页：任何页面未登录都来这里，登录成功一律进 /work
/work                  工作台（登录后首页）：一张按动作分组的清单，有内容才成卡
                         待我评审（评审人）| 待我初析与指派（PMO、管理员）| 待我终审（PMO、管理员）
                         等我推进（PM）| 我的任务（所有人）
                         右栏：在途 / 参与的项目；需要关注（管理员、CTO、PM）
/projects              流程项目组合：顶部「全池诊断」；看板（按阶段分组）/ 列表；「待 PMO 处理」筛选
/projects/[id]         项目工作区（页内标签）
                         承接（需求承接：进度轨 + 自动诊断 + 当前环节的面板；只在项目有承接阶段时存在，停在承接阶段时默认落在这里）
                         概览（阶段进度 + 关卡状态 + 成员 + 健康度 + 最新简报）
                         计划（工作项看板 / 列表；按阶段、负责人、状态筛选）
                         评审（当前关卡：提交或表决；历史轮次与意见）
                         流程（As-Is / To-Be 流程图并排对比；「编辑表单 / 编辑流程图」）
                         页头的「修改流程」：有权限的人（PM / BH / TH 成员、CTO、管理员）直达流程图编辑器，项目结束后消失
                         动态（时间线 = 事件流）
/inbox                 通知中心
/admin                 → 重定向到 /admin/processes（兼容旧书签）
/admin/processes       后台 · 流程定义（查看、流程图、编辑、删除）
/admin/systems         后台 · 线上系统库
/admin/users           后台 · 用户与岗位
/admin/stages          后台 · 阶段模板
/admin/channels        后台 · 通知渠道
/me                    「我的」：手机底部 Tab 栏的第四页；宽屏访问会回 /work
/monitor               数据大屏（全维度：六个核心数、近 6 个月趋势、阶段分布、在途健康度、
                        项目经理负载、申报部门 TOP5、线上系统涉及度、需求承接（全池诊断）、最新动态；可全屏）
```

- **应用外壳**：所有登录后的页面共用一个外壳（`components/shell/app-shell.tsx`），后台只是其中的第二组导航。桌面上是左侧悬浮侧栏，平板（768–1180）收成图标条，手机换成底部 Tab 栏（工作台 / 项目 / 通知 / 我的）。导航分两组：「工作空间」= 工作台 / 流程项目 / 通知 / 数据大屏；「系统管理」= 后台五个分区，只有管理员看得到。数据大屏是全屏页，不套外壳。导航定义在 `lib/shell-nav.ts`。
- **登录与去向**：全站只有 `/login` 一个登录页。未登录、或任意请求返回 401，都去 `/login`；登录成功一律进 `/work`，首次登录先在工作台改密码，改完留在工作台。已登录的人打开 `/login` 直接回工作台；非管理员打开 `/admin/*` 也回工作台（不再显示"需要管理员账号"的页面）。
- **工作台**：不再分标签页。主列是按动作分组的清单，四类的口径在 `lib/workbench.ts`，工作台页面和侧栏「工作台」后的数字共用同一套计算——任何会改变待办的写操作成功后，外壳会重算这个数字。每组先列最要紧的三条，其余「显示全部」就地展开；四类全空时显示「都处理完了」和按角色给的快捷入口。全局统计（在途、待评审、逾期、阻塞）不再放工作台，归数据大屏。
- **后台**：五个分区各有一条地址，刷新、分享、浏览器后退都正常；页头统一为「大标题 · 一句话说明 · 主操作」，侧栏与页头用同一个名字（`ADMIN_SECTION_META`）。新增类操作（创建账号、新增系统、新增渠道）走页头按钮弹出的表单；列表在桌面上是表格，手机上自动变成卡片行（`components/ui/data-table.tsx`）。阶段模板每个阶段先以摘要卡示人，点开才编辑。
- `/admin` 原有的"跟进看板"早已迁到 `/projects`、"跟进详情"迁到 `/projects/[id]`。
- 流程图对比复用 `FlowGraph`：As-Is 左、To-Be 右，突出"断点数、线下步骤占比、涉及系统数"三项变化。
- 外壳占了视口宽度，泳道与两栏布局的断点按内容区宽度而不是视口宽度判断（看板、计划页用容器查询，项目详情的两栏从 `lg` 提到 `xl`）。
- 移动端：经办主要在手机上做确认和试运行，`/work` 与项目"评审 / 计划"标签按 44pt 触控目标适配。
- 液态玻璃设计系统不变；新增图标沿用语义色（蓝=线上、绿=线下、琥珀=会签、靛蓝=依赖、红=逾期/驳回）。

---

## 15. 度量

**项目与组合**

| 指标 | 用途 |
|---|---|
| 阶段漏斗（各阶段在途数） | 大屏、组合看板 |
| 各阶段平均停留天数、总周期时间 | 找瓶颈阶段 |
| 待评审数、评审平均等待时长 | 发现 CTO / 经办评审积压 |
| 逾期工作项数、阻塞工作项数 | 项目健康度、PM 工作台 |
| 每人负责的在途项目数与逾期数 | 负载 |
| 驳回率、平均评审轮次 | 方案质量 |

**流程改善指标**（由 `steps` 直接计算，纯函数，As-Is 与 To-Be 各算一次做对比）

| 指标 | 定义 |
|---|---|
| 步骤数 | 主步骤数 + 会签内部子步骤数 |
| 线下步骤占比 | 线下步骤 / 全部步骤 |
| 断点数 | 线上↔线下衔接数 + 相邻线上步骤系统不互通数（与流程图虚线同口径） |
| 涉及系统数 | 去重后的 `systemName` 个数 |
| 移动端支持率 | 支持移动端的线上步骤 / 全部线上步骤 |
| 会签数 | 会签步骤个数 |

**已实现的组合指标**（`/api/overview`）：在途项目的阶段分布、待评审数与平均等待天数、逾期工作项与逾期阶段数、阻塞工作项数、健康度分布、
按期完成率、已完成项目的平均周期、近 6 个月的收集与完成趋势、每位 PM 的在办 / 逾期 / 阻塞数、申报部门 TOP5、线上系统涉及度。
各阶段平均停留天数、驳回率、平均评审轮次未做。

这组数字在"分析立项"阶段自动填进分析报告，给 CTO 的立项决策提供量化依据；上线后用同一口径对比改造前后。
业务侧 KPI（处理时长、人力投入）在"需求确认"阶段人工录入基线，运营阶段录入实际值。

---

## 16. 与运行期引擎的边界

| | 本文（改造期） | `collab-architecture.md`（运行期） |
|---|---|---|
| 管什么 | 把流程从 As-Is 改造成 To-Be 的**项目** | 按已发布流程**执行业务**的实例 |
| 核心对象 | 项目、阶段、关卡、工作项 | 实例、步骤状态、分支、运行任务 |
| 交接物 | 已发布流程版本（`process_versions.kind='published'`） | 读取该版本作为实例模板快照 |
| 共用 | `users`、`events`、`notifications`、成员与角色解析、权限骨架 | |

运行期引擎是独立的一期（见 17 节 P4），本架构为其预留但不实现。其"任务为并发最小单元、会签分支并行、事件驱动时间线"
与本文明文一致，接入时不需要重构改造期的表。

---

## 17. 分期实施

| 期 | 内容 | 验收口径 |
|---|---|---|
| **P0 地基** ✅ 已实现 | 用户扩充（显示名 / 部门 / 岗位角色）；`perms.go`；`events` 统一；存量迁移 | 存量流程迁移后看板内容不变；越权请求全部 403 |
| **P1 治理主线** ✅ 已实现 | 项目 / 成员 / 阶段 / 关卡引擎；自动建项目；我的工作台；项目概览与评审页；站内通知；按阶段分组的看板 | 一个新流程从提交到 G6 全程走通；会签关卡两人表决、一人驳回的行为正确；旧跟进看板已下线 |
| **P2 计划与协作** ✅ 已实现（甘特 / 列表视图与子任务界面未做） | 工作项（看板 / 拆分 / 阻塞）；评论与 @；项目简报；流程版本化与 As-Is / To-Be 对比；逾期调度 | 必交付物未完成时无法提交评审；To-Be 基线后 As-Is 不可被覆盖 |
| **P3 度量与配置** ✅ 已实现（各阶段平均停留、驳回率未做） | 大屏全维度；阶段模板后台可配；外部通知渠道；导出；修复删除流程 | 指标与手工计算一致；模板改动只影响新建项目（连库用例覆盖） |
| **P4 运行期** | 按 `collab-architecture.md` 实施实例引擎 | 见该文档 11 节 |

P0+P1 是"能用"的最小闭环：没有任务拆解，但 PM / CTO / 经办已经能按关卡推进一个流程。

---

## 18. 风险与待决策

**风险**

| 风险 | 对策 |
|---|---|
| 角色过多导致立项时配置繁琐 | 核心只三个角色；TH / PMO 可选；成员按岗位角色预填 |
| 关卡太重，小改造被流程拖慢 | 管理员可跳过阶段（`skipped`，须填原因并留事件）；P3 起阶段模板可在后台调整（改名、改评审规则、增减阶段） |
| CTO 成为评审瓶颈 | 或签关卡任一通过即过；工作台显示评审积压与等待时长 |
| 存量 As-Is 已被覆盖 | 迁移标注；此后版本化，不再发生 |
| 通知打扰 | 仅角色相关者接收；逾期类每日聚合一次；外部渠道默认只转发节点性事件，个人向的通知要显式勾选 |

**实现时采用的默认（都可以改，改之前请先确认）**

1. **立项方式**：提交即自动建项目。
2. **审批人**：CTO 评 G1 / G3 / G4 / G6，BH 会签 G2 / G5；没有另设"业务部门负责人"角色，业务验收由 BH 承担。
3. **TH 角色**：保留为可选的项目角色，不强制使用。
4. **可见性**：维持"登录即可看全部"，没有做项目私有。
5. **附件**：没有做站内文件上传，交付物用文本说明与链接。
6. **运行期**：`collab-architecture.md` 的实例引擎仍排在 P4，未实施。
7. **阶段模板**：标识不可改；增减阶段只能在末尾增、任意位置删，靠上下移排序。改模板不提供"应用到已有项目"。
8. **外部通知**：发到群或一组固定收件箱，不按人定向（系统里没有维护每个人的邮箱或机器人账号）；新渠道不回放历史通知。
9. **删除流程**：连同它的项目及全部记录一并删除（不留孤儿项目），界面二次确认；想保留记录的用「搁置 / 取消项目」。
10. **导出**：清单导出当前筛选结果（CSV），单项目导出 Markdown 报告或 JSON；没有做定时导出与附件打包。

---

## 19. 实现对照（2026-11-24，11-25 补记应用外壳）

**已实现（P0–P3）**

| 内容 | 位置 |
|---|---|
| 用户显示名 / 部门 / 岗位；用户目录；岗位修改 | `auth.go`、`users.go`；后台「用户与岗位」 |
| 项目、成员、七阶段；提交即自动立项；存量流程自动迁移 | `store_project.go`、`projects.go` |
| 关卡引擎：提交、表决（会签 / 或签）、驳回、撤回、通过后自动进入下一阶段、版本快照 | `reviews.go` |
| 回退到此前阶段、跳过当前阶段、搁置 / 恢复 / 完成 / 取消 | `projects.go` |
| 工作项：五种类型、六种状态、阻塞原因、清单、必交付物、依赖、按成员拆分、乐观并发 | `workitems.go` |
| 评论、@提及、简报与健康度 | `comments.go` |
| 流程版本（As-Is / To-Be 基线 / 已发布）与改善指标对比 | `versions.go`、`metrics.go` |
| 站内通知；定时扫描逾期工作项与阶段、评审积压、简报到期 | `notify.go` |
| 组合聚合（基础 + `full=1` 扩展维度） | `overview.go` |
| 阶段模板落库与后台配置；立项时快照进项目，引擎只认项目快照 | `stage_templates.go`、`template.go`；后台「阶段模板」 |
| 外部通知渠道：企业微信 / 钉钉 / 飞书群机器人、SMTP 邮件；后台异步投递、归并、退避重试 | `channels.go`、`channels_delivery.go`；后台「通知渠道」 |
| 导出：项目清单 CSV、单项目 Markdown / JSON 报告 | `export.go`；看板「导出清单」、项目页「导出」 |
| 数据大屏全维度（可全屏） | `frontend/app/monitor/page.tsx` |
| 删除流程时级联删除项目及全部关联记录（此前被外键挡住而失败）；界面二次确认 | `store.go` 的 `Delete`；后台「流程定义」 |
| 日志与排障：每个请求一行的访问日志、请求编号、操作审计、panic 恢复、浏览器与 Next 服务端的日志上报、页面错误边界（20 节） | `backend/logging.go`；`frontend/lib/client-logger.ts`、`instrumentation.ts`、`app/error.tsx`、`app/global-error.tsx` |
| 前端：项目看板、项目工作区（概览 / 计划 / 评审 / 流程 / 动态）、通知中心 | `frontend/components/projects/`、`inbox/` |
| 前端：统一应用外壳（侧栏 / 图标条 / 底部 Tab 栏）、唯一登录页、清单式工作台、后台五个分区各自的地址与统一页头（14 节） | `frontend/components/shell/`、`auth/`、`admin/`、`ui/data-table.tsx`；`lib/shell-nav.ts`、`lib/workbench.ts` |
| 需求承接（21 节）：自动诊断、PMO 初级分析与指派、PM 三条推进线、CTO 逐点技术可行性评估、PMO 终审；全池诊断、大屏面板、导出 | `backend/intake*.go`；`frontend/components/projects/intake-*.tsx`、`lib/intake.ts` |
| 测试：规则单元测试；连真实数据库、走真实路由的多角色全生命周期、模板配置、渠道投递、导出与级联删除、存量迁移、需求承接全流程测试 | `backend/*_test.go` |

**实现时定下来的几处（已同步回前文）**

- CTO 是全局岗位，不逐项目添加（4.1）。
- 或签由首位表决人决定，驳回即驳回（5.2）；实现中发现引擎只在会签里处理了驳回，已修正并补测试。
- 回退与跳过是两个接口（12 节）；没有做单独的"手工基线化 / 发布"接口，快照完全由关卡触发。
- 评审人缺位回退系统管理员；环境变量引导的管理员（没有用户行）可以直接裁决但不能作为评审人留票（9.1）。
- 取消项目时，仍在等待的评审一并作废。
- "待谁处理"（`pendingOn`）是派生字段：未指派 PM → `admin`（承接阶段的项目是 `pmo`）；阶段进行中 → `pm`；评审中 → 该关卡的评审角色；承接阶段等终审 → `pmo`。
- **模板改动只影响新建项目**的实现方式：`projects.template` 保存立项时的模板快照，引擎里所有"第几个阶段叫什么、由谁评审、怎么表决"的判断都走项目快照；旧项目没有快照，按内置模板处理（它们本来就是按内置模板建的）。存量流程迁移一律按内置模板建项目，与后台当前模板无关。
- 大屏的阶段分布按**阶段标识**归并：后台改过模板后，新旧项目的同一个阶段落在同一格，名称与顺序取当前模板。
- 通知渠道默认只转发节点性事件；"任务指派"等要显式勾选。实现中发现钉钉加签被二次 URL 编码（真实接口会拒绝），由单元测试抓出并修正。
- 实现中发现 P0–P2 的回归：每条流程提交后都会自动立项，`projects.process_id` 的外键让"删除流程"直接失败；P3 改为级联删除并补了确认与连库用例。
- **需求承接（2026-11-26）**：挂在第一个阶段上而不是另起一套，G1 的评审单就是技术可行性评估；"优先程度"只约束三条推进线的顺序，不做硬性前置；"流程是否完整"保留为人工核对；不可行的技术点不阻断通过但必须给替代方案。系统里没有 PMO 岗位时由管理员兜底。哪些是用户定的、哪些是我的判断，逐条记在 21 节。
- **应用外壳（2026-11-25）**：登录成功一律进 `/work`，不留"回到原页面"的例外——目前站内没有带着目标地址跳到登录页的链接。手机端加了「我的」页收数据大屏、提交流程、管理后台、个人信息与退出。外壳的内容区不设 `z-index`、背景层退到最底：内容区一旦自成层级，页面里弹出的对话框会被压在侧栏下面。
- **泳道列数按内容区宽度判断**：Tailwind 编译后不带原生的 `@layer`，工具类排在整张样式表的最末尾，同一个元素上单个类名的选择器总被工具类盖住；容器查询规则要带上 `.board-lanes >` 才能接管列数。
- 部署脚本的公网自检改为核对 `/admin/processes`：`/admin` 现在只是重定向，取不到构建指纹。
- **岗位改英文缩写（2026-11-25）**：五个岗位定为 GM、CTO、PM、业务经办、科技经办，界面一律显示缩写；业务经办、科技经办的缩写（BH、TH）是我取的，用户没有指定。存储代码没动，见 4.1。**同日用户要求把 GM 全部改成 PMO**——原"观察者"的显示名改为 PMO（项目管理办公室），权限不变，仍是只读；错误提示里的岗位清单也随改。GM 对应原来的"观察者"，权限没有变——用户列的五个岗位里没有"观察者"，按一一对应处理，这也是我的解读。
- **修改流程放开到项目成员（2026-11-25）**：新增 `caps.editFlow`，项目里的 PM / BH / TH 都能改流程定义（原来只有 PM / CTO / 管理员）；页头加「修改流程」，后台「流程定义」加「编辑」。起因是用户反馈"节点上的人员应该具备流程修改权限，现在没有地方可以修改流程"——"节点上的人员"我理解为项目里的 PM / BH / TH 成员，流程节点上登记的自由文本人员要先由 PM / CTO 拉进项目才有账号和权限。
- **线上「删除失败」查不出原因（2026-11-25）**：用户在生产点删除流程，界面提示「删除失败 / 请稍后重试」。排查结论是这次删除没有被执行——流程和项目都还在，PostgreSQL 没有任何错误记录，后端容器也不记请求；逐层探测（公网经 Cloudflare、服务器直连前端容器、直连后端）DELETE 都能到后端。最可能是请求在公网链路上丢了（本机发一个空请求要 9 秒），但当时隧道、前端容器、后端都不记请求，前端又把所有错误都显示成同一句话，无法证实。之后加了三样：后端访问日志（写请求与失败请求）、删除流程成败各记一行、前端显示真实的失败原因（`lib/auth.ts` 的 `transportError`）。

**未实现（P4 及以后）**

- 各阶段平均停留天数、驳回率、平均评审轮次；"轻量模板"一键切换（现在靠在阶段模板里增减阶段实现）。
- 甘特图 / 时间线视图、子任务界面（数据模型与接口已支持父子工作项，界面只展示"拆分出的子任务"）。
- 运行期实例引擎（`collab-architecture.md`）。
- 转交、加签：评审人不能转给别人或临时加人（新任 CTO 可补票）。

**已知限制**

- 数据互通结论只记录"是否互通"一个布尔值，不记录是针对哪两个系统作答的；步骤被调序或被插入会签后，旧结论会沿用到新的系统组合上（界面只在该问题成立时展示结论）。
- 流程定义的"当前工作副本"被编辑时不会自动提示哪些在途项目受影响。
- 通知在浏览器里靠 30 秒轮询刷新。
- 调度扫描与外部通知投递按**单实例部署**设计，没有加咨询锁；多实例会重复扫描（站内通知有幂等键，外部投递有投递记录主键，但同一轮里可能重复发出）。
- 逾期与"每天只提醒一次"的判定用数据库时区的日期；数据库容器若不是东八区，边界会偏移几个小时。
- 外部通知发到群或固定收件箱，不按人定向；SMTP 登录要求连接已加密（465 / SSL 或 STARTTLS）。
- 机器人接口的真实应答没有在真实环境验证过：三种机器人的报文与加签按官方文档实现，并用假服务器核对了报文格式与签名算法；上线前请用后台的「测试」按钮各验一次。
- 模板里新增、没有约定标识的阶段，看板泳道按位置归并：最后一个阶段归"运营优化"，最后一个带关卡的阶段归"验收"，其余归"改造实施"。

---

## 20. 日志与排障（2026-11-25）

**起因**：当天线上一次「删除流程失败」查不出原因。从浏览器到后端要经过 Cloudflare 隧道和前端容器，这两层出了状况，服务器上看不到痕迹；后端和前端容器都只记启动日志；界面上所有失败都显示成同一句「请稍后重试」。数据库里没有任何错误、流程也没被删，只能推断请求没有被执行，无法证实。

**目标**：出了问题，拿着用户报的一个编号，在一处日志里就能看清「谁、在哪个页面、做了什么、请求到没到后端、后端返回了什么」。

### 20.1 结构

三路日志汇到后端的一条流里（`docker logs flow-prod-backend`）：

| 来源 | 入口 | 记什么 |
|---|---|---|
| 后端自身 | `backend/logging.go` | 每个请求一行、操作审计、崩溃与堆栈、定时任务与外部通知的失败 |
| 浏览器 | `frontend/lib/client-logger.ts` → `POST /api/logs` | 页面报错、没接住的 Promise、`console.error`、资源加载失败、发不出去的接口调用 |
| Next 服务端 | `frontend/instrumentation.ts` → `POST /api/logs` | 服务端渲染与路由处理抛出的错误（Next 官方钩子 `onRequestError`） |

### 20.2 后端

- **中间件链**（`newHandler`，生产与端到端测试共用）：访问日志在最外层 → panic 恢复 → 安全头 → CORS。
- **访问日志**：每个请求一行 `msg=request`，字段 `req method path status dur bytes ip [query] [user role] [cf_ray] [err] [slow]`。2xx / 3xx 是 INFO；4xx 是 WARN，5xx 是 ERROR，都带上响应里的错误说明（`err=`）；超过 2 秒按 WARN 并标 `slow=true`。高频轮询的成功请求（`/api/notifications`、`/api/overview`、`/api/health`）和日志上报本身降到 DEBUG。
- **请求编号**（`X-Request-Id`）：沿用请求带来的合法编号（8–64 位字母、数字、`_`、`-`），否则生成 16 位十六进制；写回响应头，并放进请求的上下文。`requestLogger(r)` 取出带 `req` 的日志器，审计、`writeErr`、删除流程等都用它，和访问日志那一行靠 `req` 对应。
- **真实错误只进日志**：`writeErr` 对非业务错误回「服务异常，请稍后重试」，真实原因带 `req` 记 ERROR。早期接口里另有 19 处仍把 `err.Error()` 写在响应里返回，这次没有改接口——它们的失败由访问日志在 5xx 那一行原样记下 `err=`。
- **panic 恢复**：处理函数崩溃不再直接断连接，记 `msg=panic` 和堆栈，回一个带 `requestId` 的 500；`http.ErrAbortHandler` 照常放行。
- **审计**（`msg=audit`，`action` 取值）：`auth.register`、`auth.login`、`auth.login_failed`、`auth.login_locked`、`auth.logout`、`auth.password_wrong`、`auth.password_change`、`user.profile_update`、`user.create`、`user.update`、`user.delete`、`template.replace`、`channel.create` / `update` / `delete`（只记「密钥是否改过」，不记密钥本身）、`system.create` / `delete`、`process.delete`。项目内的推进、评审、回退等动作已经在 `events` 表里，日志不重复记；访问日志里有「谁、何时、调了哪个接口」。
- **上报接口** `POST /api/logs`：不要求登录（公开的收集表也会出错），所以有三道闸——每个来源地址每分钟 60 批、单批不超过 64KB 与 20 条、逐字段截断。级别按上报的映射，不认识的按 INFO；登录人以后端会话为准，不信上报里自己写的。内容一律当不可信文本处理：去掉控制字符，输出时转义。
- **定时任务与外部通知投递**：失败记 ERROR（panic 带堆栈），发送失败记 WARN，每轮正常跑完是 DEBUG。

### 20.3 前端

- **`authFetch` / `authFetchBlob`**：每次调用生成请求编号，放在 `X-Request-Id`。两类失败会自动上报——后端自己记不到的那两类：请求没发出去，回来的不是后端的 JSON。后端处理过的失败（4xx、5xx 的 JSON 响应）不重复上报。5xx 的界面提示带「编号」；4xx 的业务提示不带，免得提示变长。
- **`ClientLogger`**（根布局里挂一次）：全局监听 `error`（捕获阶段，含资源加载失败）、`unhandledrejection`，并接住 `console.error`。同一句话 1.5 秒内合并计数，每分钟最多收 40 条，本地最多留 60 条；发不出去就存在浏览器里，退避重试（3 秒起、最长 1 分钟），后端返回 400 / 413 的批次直接丢弃。
- **错误边界**：`app/error.tsx` 接住单个路由的渲染错误，显示「这个页面出错了」和编号，可以重试；`app/global-error.tsx` 是根布局自己出错时的最后一道防线。此前这两类错误只有用户看得见。
- **不重复上报**：React 的渲染错误先走 `console.error`，再到错误边界。边界用 `attachToReportedError` 把分类和编号补到已经记下的那一条上，不另记一条；流程图加载失败的边界同样只改分类（`chart-load`）。

### 20.4 怎么用

见 README「日志与排障」。核心是一条命令：`docker logs flow-prod-backend --since 2h | grep 'req=<编号>'`。浏览器的 `tag=api` 和后端的 `msg=request` 两行都有，说明请求到了后端；只有浏览器那一行，说明没到。

### 20.5 边界与已知限制

- 日志只留在容器里，每个容器约 100MB（`docker-compose.prod.yml` 的 `x-logging`），能留多久取决于访问量；要留更久得自己采集（`FLOW_LOG_FORMAT=json`）。
- 浏览器日志依赖页面还开着：出错后用户立刻关掉页面、而当时又发不出去，这一条要等下次打开本站才补发；换了浏览器或清了站点数据就没了。
- 来源地址取自 `CF-Connecting-IP` / `X-Forwarded-For`，是上游代理报告的值，只供排查参考；限流与鉴权仍然只信 `FLOW_TRUSTED_PROXY`。
- 上报来的浏览器日志谁都能发，只能当线索，不能当事实依据。
- 轮询接口的成功请求在默认级别下不记；想知道「某个读接口有没有被调用」要临时开 DEBUG。
- 这一套要部署之后才在生产生效。此前的线上版本各层都不记请求，那时出的问题查不出来就是查不出来了。

---

## 21. 需求承接（2026-11-26）

**起因**：用户要求在"业务流程收集完成之后、改造实施之前"加一段固定的承接流程——PMO 先做初级分析，完成后指派一名或多名 PM；
PM 负责整体推进（流程是否完整；线下节点转线上、系统不互通、线上节点移动化各自的原因与解决方案），可以指派多名 BH、申请 CTO 协助，
最后给出全部线上化与移动化的综合方案；CTO 评估技术可行性；整体流程与方案交回 PMO 终审。

### 21.1 挂在哪里

不另起一套，挂在阶段模板的**第一个阶段**上（内置模板的「分析立项」，标识 `intake`）。只有标识为 `intake` 的阶段排在第一位时才生效——
初级分析与指派发生在 PM 到岗之前，只有第一阶段能等。排在别处或不出现时项目仍按普通关卡走：旧模板立项的存量项目、以及后台把模板改成
没有承接阶段之后新建的项目，都是管理员指派 PM 的老路。

### 21.2 环节

环节是派生字段 `phase`（不落库），由阶段状态、有没有 PM、是否完成初级分析、等不等终审判出来（`intakePhase`）：

```
收集完成 ─▶ triage          ─▶ assign      ─▶ advance     ─▶ assess            ─▶ final        ─▶ done
            待 PMO 初级分析    待指派 PM      PM 按优先级推进  技术可行性评估        待 PMO 终审       承接完成
                 │ 没做初级分析、没有 PM     │ 已初析、没有 PM  │ 第一位 PM 到岗      │ 提交评估        │ 评估通过       │ 终审通过
                 └── 管理员可以不做初级分析直接指派 ──────────────┘
                                                   ▲────────── 终审退回整改：回到 advance，重提后另起一轮 ──────────┘
```

### 21.3 自动诊断

流程一提交就按收集数据算出三类节点各有多少（`Diagnose`，纯函数）。口径与「流程改善指标」里的断点、流程图里的虚线完全一致：

| 类别 | 口径 | 解决顺序 |
|---|---|---|
| 线下节点 | 办理方式为「线下办理」的步骤；会签按内部子步骤计 | ① 第一优先 |
| 系统不互通节点 | 与上一步系统不同、且标注了「数据不互通」。上一步是会签时取各方最后一个子步骤逐一比较，任一不同即算；上一步是线下时不涉及 | ② 第二优先 |
| 无法实现移动端节点 | 线上办理且「不支持移动端」 | ③ 第三优先 |

同一节点可能同时计入两类。诊断的基准是**立项时**的流程（As-Is 快照）；承接页同时给出当前工作副本里还剩多少。
节点标识带长度前缀（`m:<长度>:<id>`、`c:<步骤>:<长度>:<id>`，没有 ID 的按位置 `m:#n`），不会碰撞。

**三个优先级怎么用**：用户给的是"优先程度为：优先解决线下节点转线上，系统不互通，线上节点移动化"。落地为三条推进线按这个顺序
排列与编号，界面写明顺序的依据（先定下哪些节点转为线上，才能确定最终的跨系统衔接、以及需要移动化的线上节点范围）。
它约束的是方案推进与呈现的顺序，不要求 PM 做完前一条才能填后一条。

### 21.4 各环节的规则

1. **初级分析**（PMO；管理员兜底）：改造价值、复杂度、优先级、目标完成日、流程是否完整（结构完整 / 有缺口 + 缺口说明）、分析结论。
   可以随时保存；「完成初级分析」要求价值、复杂度、完整性、分析结论齐备。PMO 必须完成初级分析才能指派第一位 PM。
   初级分析在指派第一位 PM 时锁定，之后价值与复杂度由 PM 维护。
2. **指派 PM**（PMO；管理员兜底）：一名或多名，其中一名主负责——第一位到岗的是主负责，可以改；主负责离开后取最早到岗的。
   指派后阶段 1 进入进行中。之后 PMO 仍可增补 PM、更换主负责；最后一名 PM 被移除时阶段回到待开始，重新等指派。
3. **PM 推进**：PM / CTO / 管理员能改全部；PM 可以把某条推进线交给项目里的一位 BH / TH 负责，负责人只能改自己那条的原因、方案与节点状态，
   不能换负责人、不能提交评估。每条线 = 现状（自动诊断出的节点）→ 原因 → 解决方案；逐个节点标处理状态（待定 / 方案已定 / 无需处理）与说明。
   提交评估的准入条件（`intakeMissing`）：流程是否完整已确认；每条有节点的线都写了原因与解决方案；只要有节点，就要有综合方案总述
   与至少一个技术点；改造价值与复杂度已评估。
4. **申请 CTO 协助**：PM 在推进中写明事项发起，通知全部 CTO；CTO 响应加入后记入团队与动态。还没人响应的申请可以撤回；
   PM 或协助中的 CTO 可以结束。承接通过时仍在进行的协助自动结束。
5. **技术可行性评估**（CTO）：就是 G1 这一轮评审单（9.1 第 10 条）。对每个技术点给结论——可行 / 有条件可行（必须写条件）/
   不可行（必须给替代方案）。结论可以先存草稿；复评（第 2 轮起）可以一键沿用上一轮的结论，只重评变过的。
   总体结论：全部可行 = 通过，否则 = 有条件通过，条件与替代方案随方案带给 PMO。
6. **终审**（PMO；管理员兜底）：通过归档 / 有保留通过（必须写保留意见）/ 退回整改（必须写原因与整改要求）。通过 → G1 通过、进入阶段 2；
   退回 → 回到 PM 推进，PM 修改后重新提交，另起一轮评估。终审记录全部保留。评估通过后超过 3 天没人终审，每天提醒一次 PMO 与管理员。

### 21.5 待谁处理、通知与数据

- 承接阶段还没有 PM、或评估已通过在等终审时，`pendingOn = pmo`（5.3）。
- 通知：新流程提交（PMO 与管理员）、加入 CTO 协助、评估通过待终审、终审通过 / 退回、推进线指定了负责人；都落到项目的「承接」标签。
- 数据是第 7 节里的六张 `intake_*` 表与 `projects` 上的六列，全部随项目级联删除。
- **存量项目**（升级后才有的功能）：还停在阶段 1 的项目自然进入对应的环节（没有 PM 的等 PMO 初级分析；已有 PM 的直接从 PM 推进接上）；
  已经通过阶段 1 的项目记为「无承接记录」，不显示「承接」标签，导出里如实说明。判断只看 `projects.intake_passed_at`
  （PMO 终审通过时写入）——这个阶段被直接跳过的项目同样没有承接记录。

### 21.6 界面与导出

- **项目工作区**多一个「承接」标签，排在最前；项目停在承接阶段时默认落在它上面。顶部是六步进度轨与自动诊断，主体按环节换成
  当前角色的面板，右栏是承接团队、CTO 协助与承接动态（同一个人的连续细碎改动并成一条）。
- **工作台**：「待我初析与指派」「待我终审」两组（PMO 与管理员）；评审直达「承接」。
- **流程项目**：顶部「全池诊断」通栏、待初析提示条、卡片上的三类节点数与构成条、「待 PMO 处理」筛选。
- **数据大屏**：「需求承接 · 全池诊断」面板（三类节点合计、各涉及多少条流程、待初析与待终审的个数）；最新动态里上墙的是
  完成初级分析、提交 / 通过技术可行性评估、终审通过 / 退回。
- **导出**：清单 CSV 末尾四列（承接环节、三类节点数）；Markdown 报告的「需求承接」一节（初级分析、诊断、三条推进线、技术点与逐轮评估、
  终审记录）；JSON 的 `intake` 与 `intakeAssessments`。

### 21.7 实现时定下来的

用户明确给的：这段承接流程的六个步骤与各自的人；CTO 评估的是技术可行性；三类节点的自动诊断；三个优先级的先后。
下面这些是实现时的设计判断，**用户没有逐条确认过**：

- 挂在第一个阶段上而不是另建模块：复用关卡引擎、事件、通知、导出，G1 的评审单就是技术可行性评估。
- "优先程度"只约束顺序，不做硬性前置。
- "流程是否完整"保留为人工核对项（结构完整 / 有缺口），系统不自动判断流程结构是否完整。
- 不可行的技术点不阻断通过，但必须给替代方案，总体结论为有条件通过。
- 节点的处理状态是进度标注，不要求全部"方案已定"才能提交。
- 系统里还没有 PMO 岗位时，由管理员兜底做初级分析、指派与终审。
- PMO 可以指派任何项目的 PM，与项目有没有承接阶段无关。
- 等终审期间阶段在数据上仍是"评审中"，界面与导出里说成「待终审」。

### 21.8 已知限制

- 诊断按立项时的流程算；之后修改流程定义不会改写已经写好的原因与方案，已被消除的节点不能再标注（界面提示刷新）。
- 承接阶段被跳过、项目被取消或搁置时承接暂停，恢复后从原环节继续；跳过会清掉等终审的状态。
- 被指定为推进线负责人的 BH 只收到通知，工作台不单列"我负责的推进线"。
- 外部通知渠道默认不转发承接的个人向通知（推进线指定负责人等），要转发需在渠道里勾选。

---

## 附录：调研来源

**读到原文**

- Linear — Updates：https://linear.app/docs/initiative-and-project-updates
- Plane — Project updates：https://docs.plane.so/communication-and-collaboration/project-updates
- Jira Cloud — What are permission schemes：https://support.atlassian.com/jira-cloud-administration/docs/what-are-permission-schemes-in-jira

**BPM / 审批（另有一轮子任务通读官方文档；Camunda 读的是官方文档仓库里的同路径源文件，飞书、宜搭为帮助中心正文）**

- Camunda 8 — User tasks：https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks
- Camunda 8 — Multi-instance：https://docs.camunda.io/docs/components/modeler/bpmn/multi-instance
- Camunda 8 — Timer events：https://docs.camunda.io/docs/components/modeler/bpmn/timer-events
- Camunda 8 — User task authorization：https://docs.camunda.io/docs/components/tasklist/user-task-authorization
- 飞书审批 — 管理员设计审批流程：https://www.feishu.cn/hc/zh-CN/articles/360036163653
- 飞书审批 — 审批人异常流转规则：https://www.feishu.cn/hc/zh-CN/articles/360049067817
- 飞书审批 — 转交、加减签、回退审批：https://www.feishu.cn/hc/zh-CN/articles/360049067381
- 飞书审批 — 超时规则：https://www.feishu.cn/hc/zh-CN/articles/852878870528
- 飞书审批 — 修改规则：https://www.feishu.cn/hc/zh-CN/articles/230164856321
- 宜搭 — 审批人节点：https://docs.aliwork.com/docs/yida_support/_2/trbqg6/rq8i94
- 宜搭 — 超时处理规则：https://docs.aliwork.com/docs/yida_support/_2/ef8e88/aglbg3
- 宜搭 — 流程版本控制：https://docs.aliwork.com/docs/yida_support/_2/ef8e88/daeh3v
- 企业微信 — 审批接口（节点类型、或签 / 会签 / 依次审批字段）：https://developer.work.weixin.qq.com/document/path/91983

**仅见检索摘要（原文需登录或动态渲染）**

- 飞书审批 — 成员手册：https://www.feishu.cn/hc/zh-CN/articles/102254611657
- 钉钉 — 设置审批流程：https://alidocs.dingtalk.com/i/p/L4BYmaE53pwmNA8EYRBGveyB7Z041mDA
- Basecamp — Features：https://basecamp.com/features ；Hill Charts：https://basecamp.com/hill-charts
- RACI：https://en.wikipedia.org/wiki/Responsibility_assignment_matrix
- Asana 权限指南（社区）：https://forum.asana.com/t/asana-permissions-the-guide-2026/1133053

**开源仓库数据**（GitHub API `repos/{owner}/{repo}`，2026-11-23）

- https://github.com/makeplane/plane
- https://github.com/wekan/wekan
- https://github.com/opf/openproject
- https://github.com/Leantime/leantime
- https://github.com/kanboard/kanboard
- https://github.com/go-vikunja/vikunja
- https://github.com/kuaifan/dootask
- https://github.com/hcengineering/huly-selfhost
