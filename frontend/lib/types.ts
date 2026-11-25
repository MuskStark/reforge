import { genId } from "@/lib/utils";

export type StepMode = "online" | "offline";

/** 经办方：部门 + 涉及人员（线下办理用） */
export interface Handler {
  department: string;
  staff: string[];
}

/** 会签方内部的子步骤（会签内部可能存在多步），与主步骤同样采集线上/线下属性 */
export interface SubStep {
  id: string;
  name: string;
  mode: StepMode;
  online: OnlineInfo;
  offline: OfflineInfo;
}

/** 会签方：部门 + 涉及人员 + 内部子步骤（各方并行、内部顺序执行） */
export interface CountersignParty {
  id: string;
  department: string;
  staff: string[];
  subSteps: SubStep[];
}

export interface OnlineInfo {
  systemName: string;
  /** 是否支持移动端：必选（null=未选择） */
  mobileSupported: boolean | null;
  /** 与前一线上节点的系统是否数据互通：相邻系统不同时必填（null=未填写）；
   *  上一步为会签时，比较对象是各方最后一个子步骤的系统 */
  dataInteroperable?: boolean | null;
}

export interface OfflineInfo {
  documents: string[];
  handlers: Handler[];
}

/** 管理员维护的线上系统库条目（前台表单下拉选择） */
export interface SystemOption {
  id: string;
  name: string;
}

/** 前置会签依赖：等待指定会签步骤（可选：仅某个会签方）通过后方可执行 */
export interface WaitFor {
  stepId: string;
  partyId?: string;
}

export interface FlowStep {
  id: string;
  name: string;
  mode: StepMode;
  countersign: boolean;
  online: OnlineInfo;
  offline: OfflineInfo;
  parties: CountersignParty[];
  waitFor: WaitFor | null;
  remark: string;
}

export interface AnalysisInfo {
  conclusion: string;
  value: string;
  complexity: string;
  priority: string;
  analyst: string;
  passedAt: string;
}

export interface FlowProcess {
  id: string;
  name: string;
  description: string;
  applicant: string;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
  /** 跟进体系(docs/followup-plan.md) */
  followStatus?: FollowStatus;
  assigneeId?: string;
  assigneeName?: string;
  dueDate?: string;
  stage?: number;
  analysis?: AnalysisInfo | null;
}

export type FollowStatus = "analyzing" | "unassigned" | "following" | "review" | "done" | "shelved";

/** 跟进动态(followup_events) */
export interface FollowEvent {
  id: string;
  processId: string;
  actorId: string;
  actorName: string;
  kind: "analyzed" | "assigned" | "status" | "stage" | "edited_form" | "edited_chart";
  detail?: Record<string, unknown>;
  createdAt: string;
}

/** 改造阶段名(0..5,与后端 stageNames 一致) */
export const STAGE_NAMES = ["未开始", "需求确认", "方案设计", "系统改造", "试运行", "验收"] as const;

export const FOLLOW_STATUS_LABEL: Record<FollowStatus, string> = {
  analyzing: "需求分析",
  unassigned: "待指派",
  following: "跟进中",
  review: "待验收",
  done: "已完成",
  shelved: "已搁置",
};

export function emptyHandler(): Handler {
  return { department: "", staff: [] };
}

export function emptySubStep(): SubStep {
  return {
    id: genId(),
    name: "",
    mode: "online",
    online: { systemName: "", mobileSupported: null },
    offline: { documents: [], handlers: [] },
  };
}

/** 旧数据兜底：缺省 mode/online/offline 的子步骤补默认值 */
export function normalizeSubStep(s: Partial<SubStep>): SubStep {
  return {
    id: s.id ?? genId(),
    name: s.name ?? "",
    mode: s.mode ?? "online",
    online: s.online ?? { systemName: "", mobileSupported: null },
    offline: s.offline ?? { documents: [], handlers: [] },
  };
}

export function emptyParty(): CountersignParty {
  return { id: genId(), department: "", staff: [], subSteps: [emptySubStep()] };
}

/** 旧数据（无 subSteps 字段）读取兜底 */
export function normalizeParty(p: Partial<CountersignParty>): CountersignParty {
  return {
    id: p.id ?? genId(),
    department: p.department ?? "",
    staff: p.staff ?? [],
    subSteps: (p.subSteps ?? [])
      .filter((s) => s && s.name)
      .map((s) => normalizeSubStep(s)),
  };
}

export function emptyStep(name = "", id = genId()): FlowStep {
  return {
    id,
    name,
    mode: "online",
    countersign: false,
    online: { systemName: "", mobileSupported: null },
    offline: { documents: [], handlers: [] },
    parties: [],
    waitFor: null,
    remark: "",
  };
}

export function emptyProcess(): { name: string; description: string; applicant: string; steps: FlowStep[] } {
  return {
    name: "",
    description: "",
    applicant: "",
    // 首屏初始步骤用固定 id，保证 SSR 与 CSR 一致（后续新增步骤仅在客户端生成随机 id）
    steps: [emptyStep("", "step-initial")],
  };
}

/* ============================================================
   端到端流程管理(docs/process-management-architecture.md)
   ============================================================ */

/**
 * 全局岗位。显示名一律用英文缩写(lib/labels.ts):CTO、PM 项目经理、BH 业务经办、TH 科技经办、PMO 项目管理办公室。
 * 存储代码沿用历史取值,所以代码与缩写并非字面对应。
 */
export type JobRole = "cto" | "pm" | "handler" | "dev" | "viewer";

/** 项目角色(按项目授予;CTO 是全局岗位,不在此列):PM、BH、TH、PMO */
export type ProjectRole = "pm" | "handler" | "dev" | "viewer";

export interface FlowMetrics {
  steps: number;
  onlineSteps: number;
  offlineSteps: number;
  /** 线下步骤 / 全部步骤 */
  offlineShare: number;
  /** 线上↔线下衔接数 + 相邻线上步骤系统不互通数(与流程图虚线同口径) */
  breakpoints: number;
  systems: number;
  mobileSteps: number;
  /** 支持移动端的线上步骤 / 全部线上步骤 */
  mobileShare: number;
  countersigns: number;
}

export type ProjectStatus = "active" | "on_hold" | "cancelled" | "done";
export type StageStatus = "pending" | "in_progress" | "in_review" | "approved" | "skipped";
export type Priority = "high" | "medium" | "low";
export type Health = "on_track" | "at_risk" | "off_track";

export interface Project {
  id: string;
  processId: string;
  name: string;
  status: ProjectStatus;
  currentStage: number;
  priority: Priority;
  value: string;
  complexity: string;
  analysis: Record<string, unknown> | null;
  health: Health;
  dueDate: string;
  startedAt: string | null;
  completedAt: string | null;
  /** 乐观并发版本号(每次项目级写操作 +1) */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StageView {
  seq: number;
  key: string;
  name: string;
  status: StageStatus;
  gate: string;
  reviewerRole: "cto" | "handler" | "";
  mode: "all" | "any" | "";
  enteredAt: string | null;
  exitedAt: string | null;
  dueDate: string;
  rounds: number;
}

export interface MemberView {
  userId: string;
  username: string;
  displayName: string;
  role: ProjectRole;
}

export interface GateReviewer {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  decision: "pending" | "approve" | "reject";
  comment: string;
  decidedAt: string | null;
}

export interface GateReview {
  id: string;
  projectId: string;
  stageSeq: number;
  round: number;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  summary: string;
  submittedByName: string;
  submittedAt: string;
  decidedAt: string | null;
  mode: "all" | "any" | "";
  reviewerRole: "cto" | "handler" | "";
  reviewers: GateReviewer[];
}

export interface PendingReview extends GateReview {
  projectName: string;
  priority: Priority;
  waitingDays: number;
}

export interface ItemStats {
  total: number;
  done: number;
  overdue: number;
  blocked: number;
  openRequired: number;
  /** 未完成的必交付物标题 */
  missing: string[];
}

export interface HandlerHint {
  raw: string;
  userId: string;
  displayName: string;
  matched: boolean;
}

/** 当前用户在该项目里的能力(服务端仍然逐请求校验,这里只做显隐) */
export interface ProjectCaps {
  view: boolean;
  manage: boolean;
  /** 修改流程定义(表单与流程图):管理员、CTO,以及项目里的 PM、BH、TH */
  editFlow: boolean;
  /** 分配 PM:管理员 */
  assign: boolean;
  /** 分配 BH(业务经办):管理员、PM */
  assignHandler: boolean;
  /** 分配 TH(科技经办):管理员、CTO */
  assignDev: boolean;
  /** 添加 PMO:管理员 */
  assignViewer: boolean;
  skip: boolean;
  comment: boolean;
  createItem: boolean;
  reviewCTO: boolean;
  reviewHandler: boolean;
  isPM: boolean;
  isHandler: boolean;
  isCTO: boolean;
  isAdmin: boolean;
}

export interface ProjectView extends Project {
  /** 待谁处理:admin(待指派) | pm | cto | handler | "" */
  pendingOn: "admin" | "pm" | "cto" | "handler" | "";
  applicant: string;
  countersignN: number;
  hasPm: boolean;
  stages: StageView[];
  members: MemberView[];
  /** 当前阶段最新一轮评审(无则 null) */
  review: GateReview | null;
  stats: ItemStats;
  handlerHints: HandlerHint[];
  metrics: FlowMetrics;
  can: ProjectCaps;
}

export type ItemType = "task" | "deliverable" | "issue" | "risk" | "change";
export type ItemStatus = "todo" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled";

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ItemLink {
  toId: string;
  toTitle: string;
  toStatus: ItemStatus;
  kind: "blocks" | "relates";
  /** out = 我指向别人;in = 别人指向我 */
  direction?: "in" | "out";
}

export interface WorkItem {
  id: string;
  projectId: string;
  projectName: string;
  stageSeq: number;
  type: ItemType;
  title: string;
  body: string;
  status: ItemStatus;
  priority: Priority;
  assigneeId: string;
  assigneeName: string;
  assigneeDisplayName: string;
  parentId: string;
  dueDate: string;
  blockReason: string;
  labels: string[];
  checklist: ChecklistItem[];
  required: boolean;
  doneAt: string | null;
  children?: WorkItem[];
  links?: ItemLink[];
  /** 创建人用户 ID */
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ProjectComment {
  id: string;
  projectId: string;
  itemId: string;
  itemTitle: string;
  reviewId: string;
  kind: "comment" | "update";
  body: string;
  /** 简报的四栏 */
  structured: { progress?: string; next?: string; risks?: string; help?: string } | null;
  mentions: string[];
  authorId: string;
  authorName: string;
  authorDisplayName: string;
  createdAt: string;
}

export interface ProcessVersion {
  id: string;
  processId: string;
  projectId: string;
  version: number;
  kind: "as_is" | "to_be" | "published";
  steps?: FlowStep[];
  metrics: FlowMetrics;
  note: string;
  createdByName: string;
  createdAt: string;
}

export interface ProjectEvent {
  id: number;
  projectId: string;
  scope: string;
  targetId: string;
  actorName: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: string;
  projectId: string;
  itemId: string;
  reviewId: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}

export interface OverviewTrend {
  /** YYYY-MM */
  month: string;
  collected: number;
  done: number;
}

export interface OverviewLoad {
  userId: string;
  name: string;
  active: number;
  overdue: number;
  blocked: number;
}

export interface OverviewCount {
  name: string;
  count: number;
}

export interface OverviewEvent {
  id: number;
  projectId: string;
  projectName: string;
  actor: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface Overview {
  collected: number;
  monthlyNew: number;
  active: number;
  onHold: number;
  cancelled: number;
  done: number;
  /** 本月完成的项目数 */
  monthlyDone: number;
  /** 各阶段在途项目数(与 stageKeys / stageNames 一一对应,下标 0 = 第 1 个阶段) */
  byStage: number[];
  /** 阶段标识:后台改过模板(改名、增减阶段)后,新旧项目的同一阶段按它归并 */
  stageKeys: string[];
  /** 阶段名称取当前模板 */
  stageNames: string[];
  pendingReviews: number;
  reviewWaitDays: number;
  overdueItems: number;
  blockedItems: number;
  /** 当前阶段已过截止日的在途项目数 */
  overdueStages: number;
  byHealth: Record<Health, number>;
  /** 兼容旧大屏 */
  following: number;
  /** 以下维度只在 ?full=1 时返回(数据大屏用),基础接口里为 null */
  onTimeRate: number | null;
  avgCycleDays: number | null;
  trend: OverviewTrend[] | null;
  pmLoad: OverviewLoad[] | null;
  departmentTop: OverviewCount[] | null;
  systemTop: OverviewCount[] | null;
  recentEvents: OverviewEvent[] | null;
}

/** 阶段模板的一个阶段:后台可改,项目立项时把当时的模板快照进项目 */
export interface StageTemplate {
  seq: number;
  /** 阶段标识,不可改;design = 通过时留存 To-Be 基线,accept = 通过时留存已发布版本且通过后才可标记项目完成 */
  key: string;
  name: string;
  /** 出口关卡名;空 = 无门禁 */
  gate: string;
  reviewerRole: "cto" | "handler" | "";
  /** all = 会签;any = 或签 */
  mode: "all" | "any" | "";
  /** 必交付物:未完成不能提交评审 */
  required: string[];
  /** 立项时自动生成的默认任务 */
  tasks: string[];
}

export type ChannelKind = "wecom" | "dingtalk" | "feishu" | "email";

/** 外部通知渠道(Webhook 地址与口令是凭据,接口只返回脱敏值) */
export interface NotifyChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** 查询参数已打码;传回修改接口表示"不改" */
  webhook: string;
  secretSet: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassSet: boolean;
  smtpFrom: string;
  recipients: string;
  /** 转发的通知类型 */
  kinds: string[];
  enabled: boolean;
  lastError: string;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotifyChannelList {
  list: NotifyChannel[];
  /** 全部可转发的通知类型 */
  kinds: { kind: string; label: string }[];
  /** 新渠道的默认转发范围 */
  defaultKinds: string[];
}

/** 新建 / 修改渠道的请求体;没写的字段保持不变 */
export interface NotifyChannelInput {
  name?: string;
  kind?: ChannelKind;
  webhook?: string;
  secret?: string;
  clearSecret?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  clearPass?: boolean;
  smtpFrom?: string;
  recipients?: string;
  kinds?: string[];
  enabled?: boolean;
}

/** 用户目录里的一个人(登录可见,不含系统角色) */
export interface UserDir {
  id: string;
  username: string;
  displayName: string;
  department: string;
  jobRole: JobRole;
}
