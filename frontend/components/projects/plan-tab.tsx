"use client";

/**
 * 计划:工作项看板(按状态分列)+ 工作项详情。
 * 类型:任务 / 交付物 / 问题 / 风险 / 变更;必交付物未完成时不能提交评审。
 */

import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import type { ItemStatus, WorkItem } from "@/lib/types";
import { ITEM_TYPE_LABEL, dueInfo, itemTypeClass } from "@/lib/labels";
import { iAmPM } from "@/lib/workbench";
import { inIntakeStage } from "@/lib/intake";
import { ItemDialog } from "@/components/projects/item-dialog";
import type { DetailCtx } from "@/components/projects/project-detail";
import { Avatar } from "@/components/projects/stage-rail";
import { cn } from "@/lib/utils";

/** 看板的五列(已取消并入「完成」列,置灰显示) */
const COLUMNS: { status: ItemStatus[]; title: string; hint: string }[] = [
  { status: ["todo"], title: "待办", hint: "还没开始" },
  { status: ["in_progress"], title: "进行中", hint: "有人在做" },
  { status: ["blocked"], title: "阻塞", hint: "卡住了，需要原因" },
  { status: ["in_review"], title: "待验收", hint: "做完待确认" },
  { status: ["done", "cancelled"], title: "完成", hint: "已完成 / 已取消" },
];

export function PlanTab({ ctx, focusItem, clearFocus }: { ctx: DetailCtx; focusItem: string | null; clearFocus: () => void }) {
  const { project, items, me } = ctx;
  const [stage, setStage] = useState<string>("current");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cur = project.stages[project.currentStage - 1];
  // PM 的行动提示:必交付物进度 + 交付完成后的评审提交去向(承接期的提交在「承接」标签,不在此提示)
  const curRequired = items.filter((i) => i.required && cur && i.stageSeq === cur.seq);
  const curMissing = curRequired.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const showDeliverableHint =
    project.status === "active" && cur?.status === "in_progress" && !!cur.gate && !inIntakeStage(project) && iAmPM(me.id, project);

  // 从通知、概览等处带 item 参数进来时,直接打开那条工作项
  useEffect(() => {
    if (focusItem) {
      setOpenId(focusItem);
      clearFocus();
    }
  }, [focusItem, clearFocus]);

  const top = useMemo(() => items.filter((i) => !i.parentId), [items]);
  const shown = useMemo(
    () => top.filter((i) => stage === "all" || (stage === "current" ? i.stageSeq === project.currentStage : i.stageSeq === Number(stage))),
    [top, stage, project.currentStage],
  );
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;
  const editable = project.status === "active";

  return (
    <div>
      {/* 必交付物进度提示(PM):做完去哪提交、现在还差什么 */}
      {showDeliverableHint && (
        <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-2xl bg-[color:var(--amber-soft)] px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
          <ClipboardList className="h-4 w-4 shrink-0 text-[color:var(--amber-deep)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[color:var(--amber-deep)]">
            本阶段必交付 <b className="font-data">{curRequired.length - curMissing.length}/{curRequired.length}</b>
            {curMissing.length > 0 ? (
              <>
                {" "}· 还差 <b>{curMissing.map((i) => i.title).join("、")}</b>。全部完成后即可提交「{cur.gate}」评审。
              </>
            ) : (
              <>
                {" "}· 已全部完成，可以提交「{cur.gate}」评审了。
              </>
            )}
          </span>
          <button type="button" onClick={() => ctx.goTab("review")} className="btn btn-glass !h-8 shrink-0 !px-3 text-[12px]">
            去提交评审
          </button>
        </div>
      )}

      {/* 工具条:阶段筛选 + 新建 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {[{ v: "current", n: "当前阶段" }, { v: "all", n: "全部" }].map((o) => (
            <button key={o.v} type="button" onClick={() => setStage(o.v)} className={chip(stage === o.v)}>
              {o.n}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-[color:var(--sep)]" aria-hidden="true" />
          {project.stages.map((s) => {
            const n = top.filter((i) => i.stageSeq === s.seq).length;
            return (
              <button key={s.seq} type="button" onClick={() => setStage(String(s.seq))} className={cn(chip(stage === String(s.seq)), "gap-1")} title={s.gate ? `出口：${s.gate}` : undefined}>
                <span className={cn("size-1.5 rounded-full", s.status === "in_progress" ? "bg-[#007aff]" : s.status === "in_review" ? "bg-[color:var(--indigo)]" : s.status === "approved" ? "bg-[color:var(--green)]" : "bg-[rgba(120,120,128,0.3)]")} />
                {s.seq} {s.name}
                <span className="font-data text-[11px] text-[color:var(--ink-3)]">{n}</span>
              </button>
            );
          })}
        </div>
        {project.can.createItem && editable && (
          <button type="button" onClick={() => setCreating(true)} className="btn btn-primary !h-9 !px-3.5 text-[13px]">
            <Plus className="h-3.5 w-3.5" /> 新建工作项
          </button>
        )}
      </div>

      <div className="board-lanes">
        <div className="grid items-start gap-3 grid-cols-1 sm:grid-cols-2 lane-cols-5">
          {COLUMNS.map((col) => {
            const list = shown.filter((i) => col.status.includes(i.status));
            return (
              <section key={col.title} className="min-w-0">
                <h3 className="mb-2 flex items-baseline gap-1.5 px-1 text-[13px] font-semibold text-[color:var(--ink-2)]">
                  {col.title}
                  <span className="font-data text-[11px] font-normal text-[color:var(--ink-3)]">{list.length}</span>
                  <span className="ml-auto hidden text-[10px] font-normal text-[color:var(--ink-3)] xl:inline">{col.hint}</span>
                </h3>
                {list.length === 0 ? (
                  <div className="rounded-[20px] border border-dashed border-black/10 py-5 text-center text-xs text-[color:var(--ink-3)]">空</div>
                ) : (
                  <ul className="space-y-2">
                    {list.map((i) => (
                      <li key={i.id}>
                        <ItemCard item={i} onOpen={() => setOpenId(i.id)} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {shown.length === 0 && <p className="mt-3 text-center text-xs text-[color:var(--ink-3)]">这个阶段还没有工作项。</p>}

      {(creating || open) && (
        <ItemDialog
          ctx={ctx}
          item={open}
          stageSeq={stage === "current" || stage === "all" ? project.currentStage : Number(stage)}
          onClose={() => {
            setCreating(false);
            setOpenId(null);
          }}
          onCreated={(id) => {
            // 新建成功后留在对话框里,继续编辑刚创建的那条
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
    </div>
  );
}

function chip(on: boolean) {
  return cn(
    "inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[12px] font-medium transition",
    on ? "bg-white/90 text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,1),0_3px_10px_-5px_rgba(23,42,80,0.25)]" : "bg-white/40 text-[color:var(--ink-2)] hover:bg-white/60",
  );
}

function ItemCard({ item, onOpen }: { item: WorkItem; onOpen: () => void }) {
  const due = dueInfo(item.dueDate);
  const cancelled = item.status === "cancelled";
  const kidsOpen = (item.children ?? []).filter((c) => c.status !== "done" && c.status !== "cancelled").length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "block w-full rounded-2xl border border-black/5 bg-white/75 px-3 py-2.5 text-left shadow-[0_1px_4px_-2px_rgba(23,42,80,0.2)] transition hover:-translate-y-0.5 hover:bg-white",
        item.status === "blocked" && "border-[color:var(--red)]/35 bg-[color:var(--red-soft)]",
        item.required && "shadow-[inset_0_0_0_1px_rgba(255,149,0,0.45),0_1px_4px_-2px_rgba(23,42,80,0.2)]",
        cancelled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("min-w-0 flex-1 text-[13px] font-semibold leading-snug text-neutral-900", (item.status === "done" || cancelled) && "text-[color:var(--ink-2)] line-through")}>
          {item.title}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={itemTypeClass(item.type)}>{ITEM_TYPE_LABEL[item.type]}</span>
        {item.required && <span className="text-[10px] font-semibold text-[color:var(--amber-deep)]">必交付</span>}
        {item.priority === "high" && <span className="badge badge-warn !h-[18px] !px-1.5 text-[10px]">高优先</span>}
        {item.links?.some((l) => l.direction === "in" && l.kind === "blocks") && <span className="badge badge-indigo !h-[18px] !px-1.5 text-[10px]">被阻塞</span>}
        {kidsOpen > 0 && <span className="font-data text-[10px] text-[color:var(--ink-3)]">{kidsOpen} 项子任务</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {item.assigneeId ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={item.assigneeDisplayName} size={18} />
            <span className="truncate text-[11px] text-[color:var(--ink-2)]">{item.assigneeDisplayName}</span>
          </span>
        ) : (
          <span className="text-[11px] text-[color:var(--ink-3)]">未指派</span>
        )}
        {due && <span className={cn("font-data ml-auto shrink-0 text-[11px] tabular-nums", due.overdue ? "font-semibold text-[color:var(--red-deep)]" : "text-[color:var(--ink-3)]")}>{due.label}</span>}
      </div>
    </button>
  );
}
