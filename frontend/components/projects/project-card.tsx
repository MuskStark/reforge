"use client";

import Link from "next/link";
import type { ProjectView } from "@/lib/types";
import { HEALTH_LABEL, PRIORITY_LABEL, STAGE_STATUS_LABEL, STATUS_LABEL, dueInfo, healthClass, pct, statusClass } from "@/lib/labels";
import { PendingOnBadge } from "@/components/projects/stage-rail";
import { cn } from "@/lib/utils";

/** 看板 / 列表里的项目卡片:整卡可点进详情;底部可带一个操作(如「指派 PM」) */
export function ProjectCard({ p, dense, footer }: { p: ProjectView; dense?: boolean; footer?: React.ReactNode }) {
  const stage = p.stages[p.currentStage - 1];
  const due = dueInfo(p.dueDate);
  const progress = pct(p.stats.done, p.stats.total);
  const pms = p.members.filter((m) => m.role === "pm");
  const risky = p.status === "active" && p.health !== "on_track";

  return (
    <div
      className={cn(
        "glass-card transition",
        risky &&
          "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_1.5px_rgba(255,149,0,0.35),0_28px_64px_-28px_rgba(23,42,80,0.28)]",
      )}
    >
      <Link href={`/projects/${p.id}`} prefetch={false} className={cn("block transition hover:-translate-y-0.5", dense ? "p-3.5" : "p-4", footer && "pb-3")}>
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-snug text-neutral-900" title={p.name}>
            {p.name}
          </span>
          {p.priority === "high" && <span className="badge badge-warn shrink-0 !h-[19px] !px-1.5 text-[10px]">优先 {PRIORITY_LABEL.high}</span>}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {p.status === "active" ? (
            <>
              <span className="badge badge-blue !h-[20px] text-[11px]">
                阶段 {p.currentStage} · {stage?.name ?? ""}
              </span>
              <span className="badge badge-plain !h-[20px] text-[11px]">{stage ? STAGE_STATUS_LABEL[stage.status] : ""}</span>
              <PendingOnBadge on={p.pendingOn} />
            </>
          ) : (
            <span className={cn(statusClass(p.status), "!h-[20px] text-[11px]")}>{STATUS_LABEL[p.status]}</span>
          )}
        </div>

        {p.status === "active" && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(120,120,128,0.14)]">
              <div
                className="h-full rounded-full bg-[color:var(--tint)] transition-all"
                style={{ width: `${progress}%` }}
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="工作项完成度"
              />
            </div>
            <span className="font-data shrink-0 text-[11px] tabular-nums text-[color:var(--ink-2)]">
              {p.stats.done}/{p.stats.total}
            </span>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[color:var(--ink-2)]">
          {p.status === "active" && (
            <span className={cn("inline-flex items-center gap-1 font-medium", p.health === "on_track" ? "text-[color:var(--green-deep)]" : "text-[color:var(--amber-deep)]")}>
              <span className={cn("size-1.5 rounded-full", p.health === "on_track" ? "bg-[color:var(--green)]" : "bg-[color:var(--amber)]")} />
              {HEALTH_LABEL[p.health]}
            </span>
          )}
          {pms.length > 0 ? (
            <span className="truncate">PM {pms.map((m) => m.displayName).join("、")}</span>
          ) : p.status === "active" ? (
            <span className="text-[color:var(--amber-deep)]">尚未指派 PM</span>
          ) : null}
          {due && (
            <span className={cn("font-data tabular-nums", due.overdue ? "font-semibold text-[color:var(--red-deep)]" : undefined)}>
              {due.overdue ? due.label : `目标 ${p.dueDate.slice(5).replace("-", "/")}`}
            </span>
          )}
          {p.stats.overdue > 0 && (
            <span className="font-data font-semibold tabular-nums text-[color:var(--red-deep)]">{p.stats.overdue} 项逾期</span>
          )}
          {p.stats.blocked > 0 && <span className="font-data tabular-nums text-[color:var(--red-deep)]">{p.stats.blocked} 项阻塞</span>}
        </div>

        {!dense && p.applicant && <p className="mt-1.5 truncate text-[11px] text-[color:var(--ink-3)]">申报人 {p.applicant}</p>}
      </Link>
      {footer && <div className="border-t border-[color:var(--sep)] px-3.5 py-2.5">{footer}</div>}
    </div>
  );
}

/** 按健康度 / 状态给出的一行摘要色 */
export function healthTextClass(p: ProjectView): string {
  return p.status === "active" && p.health !== "on_track" ? healthClass(p.health) : "badge badge-plain";
}
