import type {
  Health,
  ItemStatus,
  ItemType,
  JobRole,
  Priority,
  ProjectRole,
  ProjectStatus,
  ProjectView,
  StageStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/* 流程项目的文案与配色:语义色沿用设计系统(蓝=线上、绿=线下/正常、琥珀=会签/提醒、靛蓝=依赖/评审、红=逾期/驳回) */

export const JOB_ROLE_LABEL: Record<JobRole, string> = {
  cto: "CTO",
  pm: "项目经理",
  handler: "经办",
  dev: "开发实施",
  viewer: "观察者",
};

export const JOB_ROLE_OPTIONS: { value: JobRole; label: string; hint: string }[] = [
  { value: "cto", label: "CTO", hint: "评审立项 / 方案 / 上线 / 验收,全局生效" },
  { value: "pm", label: "项目经理", hint: "负责一个流程从立项到上线的推进" },
  { value: "handler", label: "经办", hint: "确认需求、执行试运行、办理业务" },
  { value: "dev", label: "开发实施", hint: "承接系统改造任务" },
  { value: "viewer", label: "观察者", hint: "只读" },
];

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  pm: "项目经理",
  handler: "经办",
  dev: "开发实施",
  viewer: "观察者",
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
  admin: "待指派项目经理",
  pm: "待项目经理处理",
  cto: "待 CTO 评审",
  handler: "待经办确认",
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
