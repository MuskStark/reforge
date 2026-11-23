# 流程改造跟进 — 方案设计(v1)

> **已被取代(2026-11-24)**:改造期跟进由「流程项目」接管,见 `process-management-architecture.md`。
> 存量跟进数据在后端首次启动时自动迁入项目(原跟进人成为项目经理,旧时间线迁入「动态」);`analyze / assign / status / stage` 接口已下线,前端旧跟进看板与详情页不再挂载。本文保留作历史记录。
>
> 原状态:**P1+P2 已实施**(2026-11-22)——跟进看板/详情/分析指派/阶段验收/权限/表单与流程图编辑(A 期)/数据大屏 /monitor 均已上线;实施清单见 `followup-implementation-plan.md`。P3(拖拽连线、大屏全维度)待做。
> 范围:在"流程收集"之后,把已收集的流程推进为**改造工单**——管理员指派专人跟进、
> 双方监督改造进度;被分配人有权修改流程定义,并支持**直接在流程图上编辑**。
> 与 `collab-architecture.md`(流程实例的多人推进执行)互补:本文管"改造期",那份管"运行期"。

---

## 1. 核心概念

收集到的 Process 从"死数据"变为**被跟进的改造项**:

```
前台收集 ──▶ 【需求分析】(必经节点:管理员分析改造价值/复杂度/优先级,通过方可指派)
                  │ 分析通过(可同时直接指派)
                  ▼
            立项指派(选人+截止日) ──▶ 跟进人推进改造(可改流程/图)
                                        │
           管理员看板监督 ◀── 状态/阶段/动态时间线 ──▶ 待验收 → 验收完成
```

| 决策 | 内容 | 理由 |
|---|---|---|
| F1 | **跟进字段内嵌 processes 表**,不建独立工单表 | 1 流程 = 1 改造项,一一对应;避免双表同步 |
| F2 | **事件表 followup_events 驱动时间线**(不可变追加) | 审计免费;详情页动态 = 查事件,与协作文档 D5 同构 |
| F3 | **阶段(5)+状态(6)双层模型**:状态管看板流转(含必经的「需求分析」门),阶段管改造深度 | 状态少而稳定,阶段由跟进人自评、管理员可视监督 |
| F3a | **「需求分析」为收集后的必经状态门**:管理员产出分析结论(价值/复杂度/优先级),通过后才能指派;不通过可退回补充或搁置 | 所有流程改造前先过统一的分析关口,指派有依据、优先级可排序 |
| F4 | **权限按"被指派"授予**:assignee 对该流程获得编辑权(表单+图),其余人只读 | 无需新角色;权限判断 = `admin || me == assignee` |
| F5 | **图编辑分两期**:A 期"选节点→检查器改属性→图实时重排"(布局始终派生,不会拖乱正交规则);B 期再放开拖拽连线改顺序/依赖 | 现有布局是从 steps 派生的确定性算法;直接拖线易破坏"主干直连+旁路容器"画法,A 期体验已覆盖 90% 修改 |

## 2. 状态机

```
跟进状态(看板列): 需求分析 → 待指派 → 跟进中 → 待验收 → 已完成
                  └──────────┴── 任意可 → 已搁置(备注原因)
改造阶段(跟进中自评): ① 需求确认 → ② 方案设计 → ③ 系统改造 → ④ 试运行 → ⑤ 验收
```

- **收集完成 → 需求分析(必经)**:管理员填写分析结论(改造价值 / 复杂度 / 优先级 / 建议),
  通过 → 待指派(分析时可直接一并指派);需补充材料 → 退回申报人(备注原因);不立项 → 搁置。
- 状态迁移:待指派 --指派--> 跟进中 --跟进人提交--> 待验收 --管理员验收--> 已完成;搁置/恢复随时。
- 阶段只在"跟进中"可推进,每次变更写事件。
- 逾期 = 跟进中/待验收 且 `due_date < today`(看板标红,不阻塞流转)。

## 3. 数据模型(PostgreSQL 增量)

```sql
ALTER TABLE processes
  ADD COLUMN follow_status  TEXT NOT NULL DEFAULT 'analyzing',  -- analyzing|unassigned|following|review|done|shelved
  ADD COLUMN assignee_id    TEXT,                               -- users.id,可空
  ADD COLUMN due_date       DATE,
  ADD COLUMN stage          SMALLINT NOT NULL DEFAULT 0,        -- 0..5,改造阶段
  ADD COLUMN analysis       JSONB;                              -- 需求分析结论 {conclusion,value,complexity,priority,analystId,passedAt}

CREATE TABLE IF NOT EXISTS followup_events (
  id          TEXT PRIMARY KEY,
  process_id  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,        -- 操作人
  kind        TEXT NOT NULL,        -- assigned|status|stage|edited_form|edited_chart|note
  detail      JSONB NOT NULL,       -- {from,to} / {summary} 等
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fe_process ON followup_events (process_id, created_at DESC);
```

> 存量数据自动落入 `analyzing`(补一次需求分析即可继续),零迁移成本;`users` 表已存在(管理员建号),指派从中选择。

## 4. API(增量,均走既有会话鉴权)

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/processes` | 登录 | 列表带跟进字段;`mine=1` 过滤我负责的 |
| POST | `/api/admin/processes/{id}/analyze` | admin | `{conclusion, value, complexity, priority, pass}`;pass=true → unassigned(可带 `assign` 一并指派) |
| POST | `/api/admin/processes/{id}/assign` | admin | `{assigneeId, dueDate, note}`(仅 analyzing 通过后可指派)→ following + 事件 |
| POST | `/api/admin/processes/{id}/status` | admin / assignee* | `{status, note}`(*提交验收仅 assignee;完成/搁置仅 admin) |
| POST | `/api/admin/processes/{id}/stage` | assignee | `{stage}` + 事件 |
| PUT | `/api/admin/processes/{id}` | admin / assignee | 修改流程定义(复用现校验);写 `edited_form` 事件(带 steps 差异摘要) |
| POST | `/api/admin/processes/{id}/chart` | assignee | 图编辑器保存:`{steps}` 同上,事件 `edited_chart` |
| GET | `/api/admin/processes/{id}/events` | 登录 | 时间线 |
| GET | `/api/admin/overview` | 登录 | 大屏一期聚合:`{collected, following, done, monthlyNew}`(30s 轮询;P3 扩展趋势/漏斗/负载等) |

前端权限规则(403 拦截):非 admin 且非 assignee 的登录用户 → 全只读。

## 5. 页面与导航(设计稿对应)

| 页面 | 入口 | 设计稿 |
|---|---|---|
| 跟进看板(需求分析/待指派/跟进中/待验收/已完成 泳道 + 分析·指派弹窗 + 我的跟进切换) | 后台侧栏「跟进看板」 | `follow-board.html` |
| 跟进详情(负责人/阶段进度/时间线/编辑入口) | 看板卡片点入 | `follow-detail.html` |
| 流程图编辑器(画布 + 检查器 + 工具栏) | 详情页「编辑流程图」(assignee/admin) | `chart-editor.html` |
| 监控大屏 **一期**(暗色玻璃,仅三个核心数:累计收集 / 跟进中 / 改造完成) | 独立只读页 `/monitor`,登录可看,随 P1 交付 | `monitor-screen.html` |
| 监控大屏 **完整版**(P3:趋势/阶段漏斗/在途环形/跟进人负载/部门TOP/系统涉及度/最新动态) | 同页扩展,适配 16:9 大屏与投影 | `monitor-full.html` |

普通用户登录后台 → 默认落"我的跟进"(被指派的卡片);表单编辑复用现有编辑器(只读态关掉输入)。

## 6. 流程图直接编辑(技术方案)

- **A 期(本期设计稿)**:画布进入编辑态后节点可点选(选中=蓝环+四向锚点视觉);
  右侧玻璃检查器随选中对象切换(普通步骤:名称/处理方式/系统/移动端/前置依赖/删除;
  会签容器:增删会签方与子步骤)。所有修改写回 `steps` → **布局算法重算重排**
  ——正交对齐、旁路拓扑规则永不被破坏;工具栏:添加步骤/添加会签/撤销/重做/保存(脏标记红点)。
- **B 期**:放开节点拖动手柄连线 = 改顺序(插入位置)与 waitFor(仅指向会签容器),
  连线校验沿用现有依赖合法性规则(只能指向前置会签)。
- 复用点:`FlowGraph` 布局引擎、`flow-builder` 的字段组件(检查器直接搬 StepCard 字段)、
  校验器 `step-checks`。

## 7. 分期实施

| 期 | 内容 | 依赖 |
|---|---|---|
| P1 | 数据模型 + 指派/状态/阶段 API + 跟进看板 + 详情时间线 + **监控大屏一期(三个核心数)** | 仅后端增量 |
| P2 | 权限(编辑权随指派)+ 表单编辑复用 + 图编辑器 A 期(检查器) | P1 |
| P3 | 图编辑器 B 期(拖拽连线)、逾期提醒(轮询徽标)、监控大屏完整版(趋势/负载/逾期等全维度) | P2 |
