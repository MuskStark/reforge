# 流程改造跟进 — 详细实施计划(P1+P2)

> 依据 `docs/followup-plan.md`(方案)与设计稿 F1–F4 落地。本文为可执行任务清单,按依赖顺序排列。
> 权限口径:登录用户(管理员/普通成员)均具备**数据查看权限**(大屏/看板/详情/时间线只读);
> 分析、指派、验收、状态流转 = 管理员;阶段推进、编辑表单/流程图 = 管理员或**被指派跟进人**。

## T1 数据模型与迁移(后端 store.go / model.go)

- `processes` 增列:`follow_status TEXT NOT NULL DEFAULT 'analyzing'`、`assignee_id TEXT`、`due_date DATE`、`stage SMALLINT NOT NULL DEFAULT 0`、`analysis JSONB`
- 新表 `followup_events(id, process_id, actor_id, actor_name, kind, detail JSONB, created_at)` + 索引
- `listCols`/`scanProcess` 扩展;`Process` 结构体补字段;新增 `FollowEvent` 模型
- 存量数据自动落入 `analyzing`,零迁移脚本
- **验收**:`docker compose` 环境重启后端无报错,`psql \d processes` 见新列

## T2 鉴权与权限助手(后端 auth.go / followup.go)

- `requireAuth`(任意登录角色,通过返回 sessionData)——**大屏/查看类接口的权限门**
- `canEdit(sd, p)`:`sd.Role==admin` 或 `p.AssigneeID == 当前用户ID`(按用户名反查)
- **验收**:无 token 请求 `/api/admin/overview` → 401;member token → 200

## T3 聚合与跟进 API(后端 followup.go / main.go 路由)

| 端点 | 权限 | 行为 |
|---|---|---|
| GET `/api/admin/overview` | requireAuth(大屏一期) | `{collected, following, done, monthlyNew}`;following=follow_status∈{following,review} |
| GET `/api/admin/processes` | requireAuth(现有,放宽为登录可读) | 列表带跟进字段 + assignee 用户名(join users) |
| POST `.../analyze` | admin | `{conclusion,value,complexity,priority,pass}` → 存 analysis;pass→unassigned;事件 kind=analyzed |
| POST `.../assign` | admin | `{assigneeId,dueDate,note}`(需 analyzing 已通过)→ following;事件 assigned |
| POST `.../status` | admin;assignee 仅 following→review | `{status}` 合法迁移;事件 status |
| POST `.../stage` | admin/assignee | `{stage 0..5}`;事件 stage |
| GET `.../events` | requireAuth | 时间线倒序 |
| PUT `/api/admin/processes/{id}` | admin/assignee | 复用 sanitize+validateProcess;`via: form|chart` → 事件 edited_form/edited_chart(摘要:步骤数) |

- **验收**:curl 全链路——分析→指派(member)→member 推进阶段→member 提交验收→admin 验收→overview 数字变化;越权操作 403;未登录 401

## T4 前端类型与 API 客户端(lib/types.ts)

- `FlowProcess` 补 `followStatus/assigneeId/assigneeName/dueDate/stage/analysis?`;`FollowEvent` 类型
- **验收**:`tsc --noEmit` 通过

## T5 数据大屏专属路由 `/monitor`(app/monitor/page.tsx)

- 暗色玻璃一期(设计稿 monitor-screen.html 还原):三大数字卡 + 实时钟 + 30s 轮询 overview
- **鉴权门**:无 token 或 `/api/auth/me` 401 → 跳转 `/admin` 登录(带提示);member/admin 均可见
- **验收**:浏览器无痕访问 /monitor 被拦;登录后三数与后端一致

## T6 后台导航接入(app/admin/page.tsx)

- 侧栏新增:「跟进看板」(页内 tab)与「数据大屏」(Link → /monitor,当前页新开路由)
- **验收**:两入口可见可跳转

## T7 跟进看板 F1(components/followup/follow-board.tsx)

- 五列泳道(需求分析/待指派/跟进中/待验收/已完成)+ 统计牌 + 我的/全部 + 卡片(阶段进度条/逾期红标)
- 分析弹窗(结论/价值/复杂度/优先级/通过)、指派弹窗(选人/截止日/备注,分析通过才可指派)
- 卡片点击 → 页内切详情视图(复用 admin 会话态)
- **验收**:E2E——对测试流程完成分析→指派,卡片跨列移动

## T8 跟进详情 F2(components/followup/follow-detail.tsx)

- 需求分析结论卡、5 阶段步进器(推进按钮=权限)、时间线(events 渲染)、流程概要、操作按钮(提交验收/验收/搁置/恢复)
- 「编辑表单」/「编辑流程图」入口仅 admin/assignee 可见
- **验收**:时间线与操作按权限显隐;状态流转写事件

## T9 表单编辑复用(components/flow-builder.tsx 微调)

- `FlowBuilder` 支持 `existing?: {id, ...}`:提交走 PUT,成功后不重置草稿而回调刷新
- 详情页弹窗内渲染
- **验收**:member(assignee)改字段保存成功;非授权保存 403

## T10 流程图编辑器 A 期 F3(components/followup/chart-editor.tsx + flow-graph 增强)

- `FlowGraph` 增 `editable/selectedStepId/onSelect`:节点可点选(选中=蓝环+虚线晕+已选中标签,同设计稿)
- 编辑器壳:工具栏(添加步骤/会签/撤销/保存+脏点)+ 右侧检查器(选中步骤字段复用 StepCard 控件;会签容器→PartyEditor;增删/上下移)
- 修改写回 steps 草稿 → 布局自动重排(派生布局,拓扑规则不破坏);保存 → PUT(via:chart)
- **验收**:选中③改依赖→图上虚线即时变化;保存后详情/前台图一致;权限 403 拦截

## T11 构建与回归

- `pnpm build` ✓;既有功能回归(收集提交/后台三管理器/流程图只读)
- 浏览器 E2E 全链路 + 截图留档 shots/

## T12 文档与收尾

- README 功能列表补跟进体系;followup-plan.md 标记实施状态;记忆更新

## 里程碑

- **M1 = T1–T6**(数据大屏 + 看板骨架可用,用户本轮点名的核心)
- **M2 = T7–T9**(看板/详情/表单编辑闭环)
- **M3 = T10**(图编辑器 A 期)
