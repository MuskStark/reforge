"use client";

import type { ProjectRole, ProjectView, StageView, UserDir } from "@/lib/types";
import { JOB_ROLE_FULL, JOB_ROLE_LABEL, PENDING_ON_LABEL, PROJECT_ROLE_LABEL, STAGE_STATUS_LABEL, stageTone } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const stageDone = (s: StageView) => s.status === "approved" || s.status === "skipped";

/** 七个阶段的进度条:打勾=已通过,省略号=评审中,数字=未开始 / 进行中
 *  finalSeq:正在等 PMO 终审的承接阶段(状态仍是评审中,读屏里说成「待终审」) */
export function StageRail({ stages, current, finalSeq }: { stages: StageView[]; current: number; finalSeq?: number }) {
  return (
    <ol className="flex min-w-[620px] items-start" aria-label="阶段进度">
      {stages.map((s, i) => (
        <li key={s.seq} className="flex min-w-0 flex-1 flex-col items-center text-center">
          <div className="flex w-full items-center">
            <span
              className={cn(
                "h-[2.5px] flex-1 rounded",
                i === 0 ? "bg-transparent" : stageDone(stages[i - 1]) ? "bg-[rgba(52,199,89,0.5)]" : "bg-[rgba(120,120,128,0.18)]",
              )}
            />
            <span className={stageTone(s.status)} role="img" aria-label={`${s.name}：${s.seq === finalSeq ? "待终审" : STAGE_STATUS_LABEL[s.status]}`}>
              {stageDone(s) ? (s.status === "skipped" ? "–" : "✓") : s.status === "in_review" ? "…" : s.seq}
            </span>
            <span className={cn("h-[2.5px] flex-1 rounded", stageDone(s) ? "bg-[rgba(52,199,89,0.5)]" : "bg-[rgba(120,120,128,0.18)]")} />
          </div>
          <span
            className={cn(
              "mt-1.5 block px-1 text-xs font-semibold leading-tight",
              s.seq === current ? "text-neutral-900" : stageDone(s) ? "text-[color:var(--ink-2)]" : "text-[color:var(--ink-3)]",
            )}
          >
            {s.name}
          </span>
          <span className="mt-0.5 block px-1 text-[10px] leading-tight text-[color:var(--ink-3)]">
            {s.gate ? `${s.gate.split(" ")[0]} · ${s.mode === "all" ? "会签" : "或签"}` : "无门禁"}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "待谁处理"徽章。悬停说明告诉各角色此刻该做什么、去哪里操作 */
const PENDING_ON_HINT: Record<ProjectView["pendingOn"], string> = {
  admin: "还没有指派 PM：管理员在「承接」或成员管理里指派后，项目正式启动",
  pmo: "轮到 PMO 处理：初级分析、指派 PM、终审或核准完成，入口在工作台与详情页行动卡",
  pm: "轮到 PM 推进：完成必交付物后在「评审」标签提交关卡评审",
  cto: "当前关卡由 CTO 表决：评审人在「评审」标签（承接期在「承接」标签）给出结论",
  handler: "当前关卡由 BH 表决：评审人在「评审」标签（承接期在「承接」标签）给出结论",
  "": "",
};

/** "待谁处理"徽章 */
export function PendingOnBadge({ on }: { on: ProjectView["pendingOn"] }) {
  if (!on) return null;
  return (
    <span
      title={PENDING_ON_HINT[on]}
      className={cn(
        "badge !h-[20px] text-[11px]",
        on === "admin" && "badge-amber",
        on === "pmo" && "badge-amber",
        on === "pm" && "badge-blue",
        on === "cto" && "badge-indigo",
        on === "handler" && "badge-green",
      )}
    >
      <span className="dot" />
      {PENDING_ON_LABEL[on]}
    </span>
  );
}

/** 头像首字 */
export function Avatar({ name, size = 24, tone }: { name: string; size?: number; tone?: string }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.42),
        background: tone ?? "linear-gradient(180deg,#b8ccff,#9db4ff)",
        color: tone ? "#fff" : "#21407a",
      }}
      aria-hidden="true"
    >
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 用户的可选行:头像 + 显示名 + 岗位 / 部门 */
export function UserOptionLine({ u, suffix }: { u: UserDir; suffix?: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={u.displayName} size={22} />
      <span className="min-w-0 flex-1 truncate text-left text-[13px] text-neutral-900">{u.displayName}</span>
      <span className="shrink-0 text-[11px] text-[color:var(--ink-3)]" title={suffix ? undefined : JOB_ROLE_FULL[u.jobRole]}>
        {suffix ?? JOB_ROLE_LABEL[u.jobRole]}
      </span>
    </span>
  );
}

/** 成员标签:头像 + 名字 + 角色缩写(悬停显示全称),可删除。
 *  PM 可以有多名,其中一名主负责:lead 标出主负责;onMakeLead 给出「设为主负责」的入口。 */
export function MemberChip({
  name,
  role,
  onRemove,
  lead,
  onMakeLead,
  disabled,
}: {
  name: string;
  role: ProjectRole;
  onRemove?: () => void;
  lead?: boolean;
  onMakeLead?: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="tag-chip !h-[28px] !text-[12px]">
      {name}
      {lead ? (
        <span className="badge badge-blue ml-1 !h-[18px] !px-1.5 text-[10px]">主负责</span>
      ) : (
        <>
          <span className="ml-1 text-[11px] text-[color:var(--ink-3)]" title={JOB_ROLE_FULL[role]}>
            {PROJECT_ROLE_LABEL[role] ?? role}
          </span>
          {onMakeLead && (
            <button type="button" disabled={disabled} onClick={onMakeLead} className="ml-1 text-[11px] font-medium text-[color:var(--tint)] hover:underline disabled:opacity-50">
              设为主负责
            </button>
          )}
        </>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`移除 ${name}`} disabled={disabled} className="ml-1 disabled:opacity-50">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </span>
  );
}

/** 成员列表里的一类人:岗位缩写 + 头像标签。没有人时显示一句提示(warn 时用提醒色)。
 *  leadId:主负责 PM 的用户 ID,标在对应的标签上。 */
export function MemberRow({
  label,
  full,
  people,
  hint,
  warn,
  leadId,
}: {
  /** 岗位缩写;full 是它的中文全称,做成悬停提示 */
  label: string;
  full?: string;
  people: { userId: string; username: string; displayName: string; role: "pm" | "handler" | "dev" | "viewer" }[];
  hint?: string;
  warn?: boolean;
  leadId?: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="w-[62px] shrink-0 pt-0.5 text-[color:var(--ink-2)]" title={full}>
        {label}
      </span>
      {people.length ? (
        <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {people.map((m) => (
            <span key={m.userId} className="tag-chip !h-[26px] !text-[12px]">
              <Avatar name={m.displayName} size={18} />
              {m.displayName}
              {leadId === m.userId && <span className="badge badge-blue ml-1 !h-[18px] !px-1.5 text-[10px]">主负责</span>}
            </span>
          ))}
        </span>
      ) : (
        <span className={cn("text-xs", warn ? "font-medium text-[color:var(--amber-deep)]" : "text-[color:var(--ink-3)]")}>{hint}</span>
      )}
    </li>
  );
}
