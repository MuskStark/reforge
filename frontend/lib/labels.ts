import type {
  FinalDecision,
  Health,
  IntakeLineKey,
  IntakePhase,
  ItemStatus,
  ItemType,
  JobRole,
  PlanStatus,
  Priority,
  ProjectRole,
  ProjectStatus,
  ProjectView,
  StageStatus,
  StageView,
  Verdict,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/* 流程项目的文案与配色:语义色沿用设计系统(蓝=线上、绿=线下/正常、琥珀=会签/提醒、靛蓝=依赖/评审、红=逾期/驳回) */

/**
 * 岗位与项目成员角色的显示名一律用英文缩写:
 *   CTO · PM 项目经理 · BH 业务经办(Business Handler) · TH 科技经办(Technical Handler) · PMO 项目管理办公室(Project Management Office)
 * 存储代码沿用历史取值(handler / dev / viewer)没有改,所以键与缩写并非字面对应;后端 export.go / template.go 里有一份同样的对照。
 */
export const JOB_ROLE_LABEL: Record<JobRole, string> = {
  cto: "CTO",
  pm: "PM",
  handler: "BH",
  dev: "TH",
  viewer: "PMO",
};

/** 缩写的中文全称:只放得下缩写的地方(徽章、成员标签)用它做悬停提示 */
export const JOB_ROLE_FULL: Record<JobRole, string> = {
  cto: "首席技术官",
  pm: "项目经理",
  handler: "业务经办",
  dev: "科技经办",
  viewer: "项目管理办公室",
};

/** 缩写是名称,中文全称放在说明的开头 */
export const JOB_ROLE_OPTIONS: { value: JobRole; label: string; hint: string }[] = [
  { value: "viewer", label: "PMO", hint: "项目管理办公室：对每条新流程做初级分析、指派 PM、终审；查看全部项目与数据大屏" },
  { value: "cto", label: "CTO", hint: "评估技术可行性，评审方案 / 上线 / 验收，全局生效；分配项目里的 TH" },
  { value: "pm", label: "PM", hint: "项目经理：承接需求、负责一个流程从立项到上线的推进；分配项目里的 BH" },
  { value: "handler", label: "BH", hint: "业务经办：确认需求、执行试运行、办理业务" },
  { value: "dev", label: "TH", hint: "科技经办：承接系统改造任务" },
];

/** 项目里的成员角色:BH 是业务侧,TH 是科技侧 */
export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  pm: "PM",
  handler: "BH",
  dev: "TH",
  viewer: "PMO",
};

/** 每类成员由谁分配(与服务端一致:管理员分配全部,PMO 指派 PM,CTO 分配 TH,PM 分配 BH) */
export const PROJECT_ROLE_OWNER: Record<ProjectRole, string> = {
  pm: "由 PMO 指派",
  handler: "由 PM 分配",
  dev: "由 CTO 分配",
  viewer: "由管理员添加",
};

export const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };

/** 改造价值 / 复杂度的三档 */
export const OVERALL = ["高", "中", "低"] as const;

export const HEALTH_LABEL: Record<Health, string> = {
  on_track: "正常",
  at_risk: "有风险",
  off_track: "已偏离",
};

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "进行中",
  on_hold: "已搁置",
  cancelled: "已取消",
  done: "已完成",
};

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  in_review: "评审中",
  approved: "已通过",
  skipped: "已跳过",
};

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  task: "任务",
  deliverable: "交付物",
  issue: "问题",
  risk: "风险",
  change: "变更",
};

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  todo: "待办",
  in_progress: "进行中",
  blocked: "阻塞",
  in_review: "待验收",
  done: "完成",
  cancelled: "已取消",
};

export const ITEM_STATUSES: ItemStatus[] = ["todo", "in_progress", "blocked", "in_review", "done", "cancelled"];

export const PENDING_ON_LABEL: Record<string, string> = {
  admin: "待指派 PM",
  pmo: "待 PMO 处理",
  pm: "待 PM 处理",
  cto: "待 CTO 评审",
  handler: "待 BH 确认",
};

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: "待决",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

export const MODE_LABEL: Record<string, string> = { all: "会签", any: "或签" };

/** 看板分组:各阶段归并成五条在途泳道,已搁置 / 取消 / 完成的进「已结束」 */
export interface Lane {
  key: string;
  name: string;
}

export const LANES: Lane[] = [
  { key: "intake", name: "待立项" },
  { key: "design", name: "需求与方案" },
  { key: "build", name: "改造实施" },
  { key: "accept", name: "验收" },
  { key: "operate", name: "运营优化" },
  { key: "closed", name: "已结束" },
];

/** 阶段标识 → 泳道。按标识而不是序号归并:后台改了模板(改名、增减阶段)后,新旧项目的同一阶段仍在同一条泳道 */
const LANE_OF_KEY: Record<string, string> = {
  intake: "intake",
  require: "design",
  design: "design",
  build: "build",
  trial: "build",
  accept: "accept",
  operate: "operate",
};

/**
 * 验收阶段:模板里带 accept 标识的阶段;没有则取最后一个带关卡的阶段。
 * 标记项目完成以它通过为准(与后端 acceptStage 同一口径)。
 */
export function acceptStageOf(p: ProjectView) {
  return p.stages.find((s) => s.key === "accept") ?? [...p.stages].reverse().find((s) => s.gate);
}

export function laneOf(p: ProjectView): Lane {
  if (p.status !== "active") return LANES[5];
  const stages = p.stages;
  const cur = stages[p.currentStage - 1];
  const byKey = LANES.find((l) => l.key === LANE_OF_KEY[cur?.key ?? ""]);
  if (byKey) return byKey;
  // 模板里新增、没有约定标识的阶段:最后一个阶段归"运营优化",最后一个带关卡的阶段归"验收",其余归"改造实施"
  const lastGated = Math.max(0, ...stages.filter((s) => s.gate).map((s) => s.seq));
  if (p.currentStage === stages.length) return LANES[4];
  if (lastGated > 0 && p.currentStage === lastGated) return LANES[3];
  return LANES[2];
}

/** 截止日的展示与逾期判断 */
export function dueInfo(due?: string | null): { label: string; overdue: boolean; soon: boolean } | null {
  if (!due) return null;
  const end = new Date(due.length <= 10 ? due + "T23:59:59" : due).getTime();
  if (Number.isNaN(end)) return null;
  const days = Math.ceil((end - Date.now()) / 86_400_000);
  if (days < 0) return { label: `逾期 ${-days} 天`, overdue: true, soon: false };
  if (days === 0) return { label: "今天截止", overdue: false, soon: true };
  return { label: days <= 7 ? `剩 ${days} 天` : due.slice(5).replace("-", "/"), overdue: false, soon: days <= 3 };
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 今天适用的截止日输入值 */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function pct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/* ---- 徽章配色 ---- */

export function badgeClass(kind: "blue" | "green" | "amber" | "indigo" | "plain" | "ok" | "warn"): string {
  return `badge badge-${kind}`;
}

export function healthClass(health: Health): string {
  if (health === "off_track") return "badge badge-warn";
  if (health === "at_risk") return "badge badge-amber";
  return "badge badge-ok";
}

export function statusClass(status: ProjectStatus): string {
  if (status === "done") return "badge badge-ok";
  if (status === "on_hold") return "badge badge-plain";
  if (status === "cancelled") return "badge badge-warn";
  return "badge badge-blue";
}

export function priorityClass(p: Priority): string {
  return p === "high" ? "badge badge-warn" : p === "low" ? "badge badge-plain" : "badge badge-blue";
}

export function stageTone(status: StageStatus): string {
  return cn(
    "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-xs font-bold",
    status === "approved" && "bg-[color:var(--green-soft)] text-[color:var(--green-deep)] shadow-[inset_0_0_0_1px_rgba(52,199,89,0.4)]",
    status === "skipped" && "bg-[rgba(120,120,128,0.14)] text-[color:var(--ink-2)]",
    status === "in_review" &&
      "bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)] shadow-[0_0_0_4px_rgba(88,86,214,0.16)]",
    status === "in_progress" &&
      "bg-gradient-to-b from-[#2b95ff] to-[#0071e3] text-white shadow-[0_0_0_4px_rgba(0,113,227,0.18)]",
    status === "pending" && "bg-[rgba(120,120,128,0.14)] text-[color:var(--ink-3)]",
  );
}

export function itemStatusDot(status: ItemStatus): string {
  return cn(
    "inline-block size-1.5 shrink-0 rounded-full",
    status === "todo" && "bg-[color:var(--ink-3)]",
    status === "in_progress" && "bg-[#007aff]",
    status === "blocked" && "bg-[color:var(--red)]",
    status === "in_review" && "bg-[color:var(--indigo)]",
    status === "done" && "bg-[color:var(--green)]",
    status === "cancelled" && "bg-[color:var(--ink-3)] opacity-50",
  );
}

export function itemTypeClass(type: ItemType): string {
  return cn(
    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
    type === "deliverable" && "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]",
    type === "issue" && "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]",
    type === "risk" && "bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)]",
    type === "change" && "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]",
    type === "task" && "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
  );
}

/* ---- 需求承接 ---- */

/** 三条推进线,数组顺序即解决顺序:先线下转线上,再系统互通,最后移动化。
 *  配色沿用图例:绿 = 线下、靛蓝 = 系统间的衔接、琥珀 = 提醒(会签色在这组界面里不出现,不冲突)。
 *  reasonHint / solutionHint 是原因与解决方案输入框里的示例,每条线各写各的。 */
export const INTAKE_LINES: { key: IntakeLineKey; title: string; mark: string; order: string; soft: string; deep: string; dot: string; reasonHint: string; solutionHint: string }[] = [
  {
    key: "offline",
    title: "线下节点转线上",
    mark: "①",
    order: "第一优先",
    soft: "var(--green-soft)",
    deep: "var(--green-deep)",
    dot: "var(--green)",
    reasonHint: "如：财务要求核对发票原件并手写签字",
    solutionHint: "如：发票影像上传 + 电子签名，替代粘贴签字",
  },
  {
    key: "interop",
    title: "系统不互通",
    mark: "②",
    order: "第二优先",
    soft: "var(--indigo-soft)",
    deep: "var(--indigo-deep)",
    dot: "var(--indigo)",
    reasonHint: "如：两套系统分期建设、厂商不同，数据靠人工二次录入",
    solutionHint: "如：单点登录 + 接口对接，结果自动回写",
  },
  {
    key: "mobile",
    title: "线上节点移动化",
    mark: "③",
    order: "第三优先",
    soft: "var(--amber-soft)",
    deep: "var(--amber-deep)",
    dot: "var(--amber)",
    reasonHint: "如：系统只有网页版，审批人出差时无法处理",
    solutionHint: "如：高频审批接入移动待办，复杂操作保留网页版",
  },
];

/** 诊断结果里三类节点的中文名 */
export const DIAGNOSIS_LABEL: Record<IntakeLineKey, string> = {
  offline: "线下节点",
  interop: "系统不互通节点",
  mobile: "无法实现移动端节点", // 紧凑处(工作台、列表行)用简称「无法移动端」
};

/** 承接环节的名字;短名用在生命周期轨上 */
export const INTAKE_PHASE: Record<IntakePhase, { label: string; short: string }> = {
  triage: { label: "待 PMO 初级分析", short: "PMO 初级分析" },
  assign: { label: "待指派 PM", short: "指派 PM 承接" },
  advance: { label: "PM 推进中", short: "PM 按优先级推进" },
  assess: { label: "技术可行性评估中", short: "技术可行性评估" },
  final: { label: "待 PMO 终审", short: "PMO 终审" },
  done: { label: "承接完成", short: "PMO 终审" },
};

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  pending: "待定",
  planned: "方案已定",
  na: "无需处理",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  feasible: "可行",
  conditional: "有条件可行",
  infeasible: "不可行",
};

/** 结论所要求的说明:附条件要写明条件,不可行必须给出替代方案 */
export const VERDICT_NOTE_HINT: Record<Verdict, string> = {
  feasible: "说明（选填）",
  conditional: "条件（必填）",
  infeasible: "替代方案（必填）",
};

export const FINAL_LABEL: Record<FinalDecision, string> = {
  passed: "通过归档",
  passed_with_notes: "有保留通过",
  returned: "退回整改",
};

export function verdictClass(verdict: Verdict | ""): string {
  return cn("badge !h-[20px] text-[11px]", verdict === "feasible" && "badge-ok", verdict === "conditional" && "badge-amber", verdict === "infeasible" && "badge-warn");
}

export function finalClass(decision: FinalDecision): string {
  return cn("badge !h-[20px] text-[11px]", decision === "passed" && "badge-ok", decision === "passed_with_notes" && "badge-amber", decision === "returned" && "badge-warn");
}
