"use client";

import type { ProjectRole, ProjectView, StageView, UserDir } from "@/lib/types";
import { JOB_ROLE_LABEL, PENDING_ON_LABEL, PROJECT_ROLE_LABEL, STAGE_STATUS_LABEL, stageTone } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const stageDone = (s: StageView) => s.status === "approved" || s.status === "skipped";

/** 七个阶段的进度条:打勾=已通过,省略号=评审中,数字=未开始 / 进行中 */
export function StageRail({ stages, current }: { stages: StageView[]; current: number }) {
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
            <span className={stageTone(s.status)} role="img" aria-label={`${s.name}：${STAGE_STATUS_LABEL[s.status]}`}>
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

/** "待谁处理"徽章 */
export function PendingOnBadge({ on }: { on: ProjectView["pendingOn"] }) {
  if (!on) return null;
  return (
    <span
      className={cn(
        "badge !h-[20px] text-[11px]",
        on === "admin" && "badge-amber",
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
      <span className="shrink-0 text-[11px] text-[color:var(--ink-3)]">{suffix ?? JOB_ROLE_LABEL[u.jobRole]}</span>
    </span>
  );
}

/** 成员标签:头像 + 名字 + 角色,可删除 */
export function MemberChip({
  name,
  role,
  onRemove,
}: {
  name: string;
  role: ProjectRole;
  onRemove?: () => void;
}) {
  return (
    <span className="tag-chip !h-[28px] !text-[12px]">
      {name}
      <span className="ml-1 text-[11px] text-[color:var(--ink-3)]">{PROJECT_ROLE_LABEL[role] ?? role}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`移除 ${name}`} className="ml-1">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </span>
  );
}
