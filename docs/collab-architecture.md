# 多人协作推进 — 架构设计（v1）

> 状态：设计稿，未实施。
> 范围：在既有"流程收集"之上，增加流程实例的**多人协作推进**能力——发起实例后，
> 由各步骤标注的部门/人员按顺序与会签规则推进，直至流程完成或驳回终止。
> 明确不在范围内：流程定义的多人实时协同编辑（OT/CRDT）、站内聊天、组织架构同步。

---

## 1. 核心设计决策（先定原则）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **模板与实例分离**：收集到的 Process 是"定义/模板"，推进时冻结为快照生成 Instance | 定义后续被改不影响已在推进的实例；审计可追溯 |
| D2 | **PostgreSQL 单一事实源 + 乐观并发**：所有推进动作在单事务内完成状态机迁移，实例带 `version` 乐观锁 | 与现有技术栈一致（pgx）；多人并发动作冲突时返回 409 让前端重试，无需分布式锁 |
| D3 | **任务（Task）为并发最小单元**：每个"待办人 × 子步骤"一条任务记录，动作为幂等单次迁移 | 多人并行会签天然拆成多任务；同一任务双人误点由状态机 + 幂等键兜底 |
| D4 | **会签分支并行、分支内子步骤串行、waitFor 门控**：引擎在任务动作后同事务重算下游就绪态 | 与收集阶段已采集的语义一一对应，不新增概念 |
| D5 | **事件表（EventLog）驱动时间线**：每次动作追加不可变事件，详情页时间线=查事件 | 天然审计；前端时间线无需额外建模 |
| D6 | **实时性分期**：Phase 1 前端轮询（待办页 10s）→ Phase 2 SSE 推送 | 避免过早引入 WebSocket/Redis；开发场景轮询足够 |
| D7 | **身份最小化**：不引入组织架构系统，dev 级 `users` 表（姓名/部门/角色），实例创建时按"部门+姓名"匹配模板中的经办方 | 与现有数据的 departments/staff 字段直接衔接；生产化时替换为组织同步即可 |

---

## 2. 领域模型

```
Process(已有)          ——定义/模板（现状保留，不动）
   │  发起（冻结快照）
   ▼
ProcessInstance        ——一次推进实例（process_snapshot JSONB 冻结定义）
   ├─ InstanceStep     ——实例内每一步的状态行（1 步 1 行，可查询可索引）
   │    └─ BranchState ——会签方分支状态（会签步骤 1..N 分支，并行）
   │         └─ SubStepState ——分支内部子步骤状态（串行）
   ├─ Task             ——待办：分支/子步骤 × 经办人（并发动作的最小单元）
   └─ Event            ——不可变事件流（时间线/审计）
```

关键点：**实例创建时把定义整体冻结进 `process_snapshot`**；运行期只写状态表。
模板后续修改 = 只影响新发起的实例。

---

## 3. 数据模型（PostgreSQL，新增 4 张表 + 1 张用户表）

```sql
-- D7：dev 级身份表（生产化时替换为组织系统同步）
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,          -- 32hex
  name       TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'member',  -- member | admin
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id              TEXT PRIMARY KEY,              -- 32hex
  process_id      TEXT NOT NULL,                 -- 来源模板（软引用）
  process_snapshot JSONB NOT NULL,               -- 冻结的完整定义（含 steps/parties/waitFor）
  title           TEXT NOT NULL,
  initiator_id    TEXT NOT NULL,                 -- 发起人
  state           TEXT NOT NULL DEFAULT 'running',  -- running | completed | rejected | cancelled
  version         INTEGER NOT NULL DEFAULT 1,    -- D2 乐观锁
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_initiator ON instances (initiator_id, created_at DESC);

-- 每步状态行（不含会签分支细分，分支状态在 branch_states）
CREATE TABLE IF NOT EXISTS instance_steps (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  step_id     TEXT NOT NULL,                     -- 快照内的 step.id
  seq         INTEGER NOT NULL,                  -- 顺序号
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | ready | done | rejected | skipped
  ready_at    TIMESTAMPTZ,
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_isteps_instance ON instance_steps (instance_id);

-- 会签分支（非会签步骤无行；branch = 模板 party 的并行实例）
CREATE TABLE IF NOT EXISTS branch_states (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  step_id     TEXT NOT NULL,
  party_id    TEXT NOT NULL,                     -- 快照内的 party.id
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | ready | running | done | rejected
  cursor      INTEGER NOT NULL DEFAULT 0,        -- 分支内子步骤游标（0=未开始，1=第1个子步骤进行中…）
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_branch_instance ON branch_states (instance_id, step_id);

-- 待办任务（并发最小单元；一个分支的当前子步骤会按候选人生成 1 条部门任务，
-- 部门内任意成员可认领执行 → 认领即写 assignee_user_id 防二次执行）
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES instances(id),
  step_id        TEXT NOT NULL,
  party_id       TEXT,                           -- 会签分支（非会签步骤为 NULL）
  sub_step_id    TEXT,                           -- 分支内子步骤（无内部步骤为 NULL）
  dept           TEXT NOT NULL,                  -- 模板标注的经办部门
  candidate      JSONB NOT NULL DEFAULT '[]',    -- 候选人姓名列表（快照 staff）
  assignee_id    TEXT,                           -- 认领人（认领后写死，防双人重复执行）
  state          TEXT NOT NULL DEFAULT 'pending',-- pending | claimed | done | rejected
  result_remark  TEXT NOT NULL DEFAULT '',       -- 通过备注 / 驳回原因 / 线下回执说明
  idempotency_key TEXT NOT NULL DEFAULT '',      -- D3 幂等键（客户端生成 UUID）
  acted_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_instance ON tasks (instance_id);
CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks (dept, state);

-- 事件流（时间线 + 审计，只追加）
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  type        TEXT NOT NULL,      -- instance_created | task_claimed | task_done | task_rejected |
                                  -- step_done | countersign_joined | instance_completed | ...
  actor_id    TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_instance ON events (instance_id, id DESC);
```

---

## 4. 状态机与推进引擎

### 4.1 规则（与收集语义一一对应）

1. **顺序主链**：`seq=N` 步骤 ready 条件 = `seq=N-1` 步骤 `done`（首步发起即 ready）。
2. **会签步骤 ready 后**：所有 `branch_states` 同步 `ready → running`，各自生成首个子步骤任务 → **多方并行**。
3. **分支内**：子步骤按序串行；当前子步骤任务 `done` → 游标 +1 生成下一子步骤任务；末个子步骤 `done` → 分支 `done`。
4. **会签步骤 done 条件**：全部分支 `done`（多方并行签署完成）。
5. **waitFor 门控**：目标步骤 `done` → 解除门控；`partyId` 指定分支时，该分支 `done` 即解除。
6. **驳回即熔断**：任意任务 `rejected` → 所属分支 `rejected` → 步骤 `rejected` → 实例 `rejected`（终止，其余任务全部关闭）。Phase 2 可扩展"驳回退回上一步"。

### 4.2 引擎事务（伪代码，`engine.go`）

```go
// 所有推进动作走这一个入口，单事务，天然解决多人并发动作
func Advance(taskID string, actor User, action Action, idemKey string) error {
  tx := db.Begin()
  // ① 幂等：idempotency_key 已存在 → 直接返回上次结果（防双击/重试）
  if exists(tasks, idemKey) { return nil }
  // ② 行锁锁定任务与实例（单实例串行化，冲突窗口=毫秒级）
  task   := SELECT * FROM tasks WHERE id=$1 FOR UPDATE
  inst   := SELECT * FROM instances WHERE id=$2 FOR UPDATE
  // ③ 状态机合法性：task.state 必须是 pending/claimed 且 actor 是候选成员或已认领人
  // ④ 迁移：写任务结果 → 重算分支游标/状态 → 重算步骤状态 → 按 4.1 规则点亮下游
  // ⑤ 写事件、instances.version = version + 1
  // ⑥ COMMIT（失败 → 409 Conflict，前端提示重试）
}
```

**多人并发场景结论**（承接上一问"多线程问题"）：
- 两人同时点同一任务"通过"：`FOR UPDATE` 行锁串行化，先者成功，后者任务已 `done` → 返回 409/幂等短路，前端刷新待办。
- 两人同时推进**不同分支**（会签并行）：不同任务行，互不阻塞；实例 version 均加 1，各自事务独立提交。
- 驳回与新通过同时到达：行锁保证先后顺序确定，最终状态一致（rejected 熔断优先级由到达顺序决定，事件表可追溯）。

---

## 5. 身份与权限

| 角色 | 登录方式 | 能做什么 |
|---|---|---|
| 发起人 | 既有 session 机制扩展为带 `user_id` | 发起实例、查看自己发起的实例、取消（running 且未被驳回前） |
| 经办人 | 同上 | 认领/执行分配到本部门的任务（通过 / 驳回 / 线下回执） |
| 管理员 | 既有 admin 会话保留 | 后台监管所有实例、强制终止、看全量事件 |

- 登录接口扩展：`POST /api/auth/login`（统一身份入口，admin 角色额外可进 `/admin`）；
  现有 `/api/admin/*` 仅放行 `role=admin`。
- 任务候选匹配：实例创建时按快照 `parties[].department + staff[]` 与 `users` 表匹配生成任务；
  dev 阶段允许"部门任务"无精确候选人（部门内任意登录用户可认领），生产化替换为组织同步。

---

## 6. API 设计（增量，全部走既有 `/api` 前缀 + rewrites）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/auth/login` | - | 统一登录（含 admin），返回令牌 |
| `GET` | `/api/auth/me` | ✓ | 当前用户信息 |
| `POST` | `/api/instances` | ✓ | `{processId, title?}` 发起实例（冻结快照） |
| `GET` | `/api/instances/mine` | ✓ | 我发起的实例列表 |
| `GET` | `/api/instances/{id}` | ✓ 参与者/管理员 | 实例详情：快照 + 步骤/分支状态 + 事件时间线 |
| `POST` | `/api/tasks/{id}/claim` | ✓ 候选人 | 认领任务（写 assignee，防重复执行） |
| `POST` | `/api/tasks/{id}/actions` | ✓ 认领人 | `{action: approve/reject/comment, remark, idempotencyKey}` |
| `GET` | `/api/tasks/mine` | ✓ | 我的待办（按部门 + 候选人匹配） |
| `GET` | `/api/admin/instances` | ✓ admin | 全量实例监管列表 |
| `POST` | `/api/admin/instances/{id}/cancel` | ✓ admin | 强制终止 |

约定：写操作统一返回 `409 {error, currentVersion}` 表示乐观锁冲突；任务动作要求客户端生成 `idempotencyKey`（UUID）防重试重复提交。

---

## 7. 前端信息架构（新增 3 个页面，复用现有组件体系）

```
/                    收集表单（现状保留）＋ 头部入口：我的任务 / 管理后台
/tasks               我的待办（登录后）：任务卡片 → 操作（通过/驳回/线下回执），10s 轮询
/instances/[id]      实例详情：只读流程轨道（复用 rail 视觉，节点标状态色）
                     + 右侧事件时间线（官方 Timeline 评估改用：轻量自绘列表）
/admin               既有管理台 + 新增"实例监管"页签（全量实例 + 强制终止）
/collect/[id]        发起页：从已收集流程发起实例（表单确认 → POST /instances）
```

- 步骤轨道视觉直接复用现有 rail-node 体系，状态色：`pending` 灰 → `ready` 青蓝呼吸 → `done` 实心青 → `rejected` 红；会签菱形沿用琥珀。
- 官方组件持续复用：StatefulButton（任务操作）、AnimatedModal（详情）、Spotlight（卡片）、VanishInput（待办搜索）、MultiStepLoader（推进 loading）。

---

## 8. 线上 / 线下步骤在推进期的差异

| | 线上步骤 | 线下步骤 |
|---|---|---|
| 执行动作 | 记录"已在 X 系统办理"（外部系统单号选填）+ 通过 | 上传/登记**回执说明**（回执人、时间、备注），必填回执说明才可通过 |
| 移动端标注用途 | 提示"可去移动端办理"（Phase 3 可挂系统跳转链接） | 提示"需线下办理后回执" |
| 不支持移动端 | 隐藏移动端提示 | 无差异 |

即：**线上/线下标注在推进期转化为任务的操作引导与必填项差异**，不产生新的数据结构。

---

## 9. 实时性方案（分期）

- **Phase 1（本次实施）**：待办页与实例详情 10s 轮询 `GET /tasks/mine`、`GET /instances/{id}`；动作后主动刷新一次。
- **Phase 2**：SSE（`GET /api/stream/instances/{id}`，Go 端 `events` 表 tail 广播），前端 EventSource 替换轮询；无需 Redis（单实例 Go 进程内存广播足够，多实例部署时再引入 PG LISTEN/NOTIFY）。
- **Phase 3**：邮件/移动端推送提醒待办。

---

## 10. 与现有代码的衔接点（实施清单预告）

| 模块 | 改动 |
|---|---|
| `backend/admin.go` | session 泛化为带 `user_id/role` 的统一会话；admin 判定改为查角色 |
| `backend/engine.go`（新增） | 状态机 + Advance 事务（第 4.2 节） |
| `backend/instances.go`（新增） | 实例/任务 REST handlers + 事件写入 |
| `frontend/lib/auth.ts` | token 附带 user 信息缓存；增加角色判断 |
| `frontend/components/rail.tsx`（新增） | 从 step-card 抽取只读轨道展示组件（状态着色） |
| `frontend/app/tasks`、`/instances/[id]`、`/collect/[id]` | 新页面 |
| 数据迁移 | `store.go` 建表清单追加第 3 节 SQL（`CREATE IF NOT EXISTS` 幂等） |

---

## 11. 分期实施建议

| 期 | 内容 | 验收口径 |
|---|---|---|
| P1 | users 表 + 统一登录、实例引擎（顺序/会签/waitFor 全规则）、我的待办、实例详情时间线、发起页、admin 监管列表 | 双浏览器并行会签：两分支互不阻塞；同任务双击幂等；驳回熔断；waitFor 分支门控生效 |
| P2 | SSE 实时推送、任务委托（经办人转派）、驳回退回上一步 | 动作后对方页面 2s 内刷新 |
| P3 | 消息提醒、统计报表（平均推进时长/卡点步骤）、流程定义版本对比 | — |
