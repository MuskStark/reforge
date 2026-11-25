"use client";

/**
 * 项目工作区的「承接」标签:流程收集完成之后、改造实施之前的那一段——
 *   PMO 初级分析 → 指派 PM(一名或多名) → PM 按优先级推进 → CTO 技术可行性评估 → PMO 终审。
 * 顶部是生命周期轨与自动诊断;主体按当前环节换成对应角色的操作面板;右栏是承接团队、CTO 协助与承接动态。
 */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";
import type { IntakeView, ProjectEvent } from "@/lib/types";
import { INTAKE_PHASE, STATUS_LABEL, fmtDateTime } from "@/lib/labels";
import { CountTiles, IntakeRail } from "@/components/projects/intake-bits";
import { IntakeAssign, IntakeTriage } from "@/components/projects/intake-triage";
import { IntakeSolution } from "@/components/projects/intake-solution";
import { IntakeAssessment } from "@/components/projects/intake-assessment";
import { IntakeFinal } from "@/components/projects/intake-final";
import { SupportDialog, SupportPanel } from "@/components/projects/intake-support";
import { TONE_DOT, eventLine } from "@/components/projects/activity-tab";
import { MemberRow } from "@/components/projects/stage-rail";
import { canAssignMembers } from "@/components/projects/members-dialog";
import { StateLine } from "@/components/shell/app-shell";
import type { DetailCtx } from "@/components/projects/project-detail";
import { cn } from "@/lib/utils";

/** 承接动态只收与这一段有关的事件 */
const INTAKE_EVENTS = new Set([
  "project_created",
  "intake_triaged",
  "intake_solution_updated",
  "intake_line_assigned",
  "intake_point_added",
  "intake_point_updated",
  "intake_point_deleted",
  "cto_support_requested",
  "cto_support_withdrawn",
  "cto_support_joined",
  "cto_support_released",
  "review_submitted",
  "intake_assessed",
  "review_voted",
  "review_approved",
  "review_rejected",
  "review_withdrawn",
  "intake_final_returned",
  "intake_final_passed",
  "member_added",
  "member_removed",
]);

/** 细碎的改动:同一个人连续做这些时并成一条 */
const VERBOSE_EVENTS = new Set(["intake_solution_updated", "intake_point_added", "intake_point_updated", "intake_point_deleted"]);

type EventEntry = { event: ProjectEvent; count: number };

/**
 * 把连续的细碎改动并成一条(同一个人连续改方案、连续录技术点),
 * 免得 PM 填几个节点就把「指派 PM」这类关键节点刷出这条只有几行的动态。
 */
export function foldEvents(list: ProjectEvent[]): EventEntry[] {
  const out: EventEntry[] = [];
  for (const event of list) {
    const prev = out[out.length - 1];
    if (prev && VERBOSE_EVENTS.has(event.kind) && prev.event.kind === event.kind && prev.event.actorName === event.actorName) prev.count++;
    else out.push({ event, count: 1 });
  }
  return out;
}

export function IntakeTab({ ctx }: { ctx: DetailCtx }) {
  const { project, me, users } = ctx;
  const [v, setV] = useState<IntakeView | null>(null);
  const [gone, setGone] = useState(false);
  const [events, setEvents] = useState<EventEntry[]>([]);
  // 申请 / 撤回 CTO 协助的对话框:挂在根节点上(放进右栏卡片会被卡片的背景模糊困住)
  const [supportAsk, setSupportAsk] = useState<"request" | "withdraw" | null>(null);

  // 承接的写操作都会让项目版本号 +1,所以跟着版本号重新读取;面板保存后只需刷新项目
  const load = useCallback(async () => {
    try {
      const [iv, ev] = await Promise.all([
        authFetch<IntakeView>(`/api/projects/${project.id}/intake`, { cache: "no-store" }),
        authFetch<ProjectEvent[]>(`/api/projects/${project.id}/events`, { cache: "no-store" }),
      ]);
      setV(iv);
      setEvents(foldEvents((ev ?? []).filter((e) => INTAKE_EVENTS.has(e.kind))).slice(0, 8));
    } catch (e) {
      if (e instanceof Error && /承接阶段/.test(e.message)) setGone(true);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load, project.version]);

  if (gone) return <StateLine>这个项目的第一个阶段不是需求承接阶段。</StateLine>;
  if (!v) return <StateLine>读取承接进度中…</StateLine>;

  const phase = v.phase;
  const ended = project.status === "done" || project.status === "cancelled";
  const early = phase === "triage" || phase === "assign";
  // 指派面板:PMO 与管理员在整个承接阶段都能增补 PM(终审通过后走「成员」管理)
  const assigning = !ended && v.can.assign && phase !== "done";
  const pms = project.members.filter((m) => m.role === "pm");
  const handlers = project.members.filter((m) => m.role === "handler");
  const devs = project.members.filter((m) => m.role === "dev");
  const ctos = users.filter((u) => u.jobRole === "cto").map((u) => ({ userId: u.id, username: u.username, displayName: u.displayName, role: "pm" as const }));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        {project.status !== "active" && (
          <p className="rounded-2xl bg-[color:var(--amber-soft)] px-4 py-3 text-[13px] text-[color:var(--amber-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
            项目已{STATUS_LABEL[project.status]}，需求承接暂停；恢复推进后从「{INTAKE_PHASE[phase].label}」继续。
          </p>
        )}

        {/* 生命周期轨 */}
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            需求承接
            <span className={cn("badge !h-[20px] text-[11px]", phase === "done" ? "badge-ok" : "badge-blue")}>{INTAKE_PHASE[phase].label}</span>
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">收集完成后先由 PMO 初级分析并指派 PM；PM 按优先级推进并出方案；CTO 评估技术可行性；最后整体流程与方案交回 PMO 终审。</p>
          {/* w-0 + min-w-full:可横滑的宽内容不把卡片撑宽 */}
          <div className="w-0 min-w-full overflow-x-auto pb-1 pt-3">
            <IntakeRail v={v} createdAt={project.createdAt} pmCount={pms.length} />
          </div>
        </section>

        {/* 自动诊断 */}
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            自动诊断
            <span className="badge badge-plain ml-auto !h-[20px] text-[11px]">按收集数据自动统计</span>
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
            流程一提交就能算出三类节点各有多少。数量按立项时的流程统计；改过流程定义后，括注当前工作副本里还剩多少。
          </p>
          <CountTiles lines={v.lines} className="mt-3" />
          <details className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
            <summary className="cursor-pointer">统计口径</summary>
            <ul className="mt-1.5 grid list-disc gap-0.5 pl-4">
              <li>线下节点：办理方式为「线下办理」的步骤，会签按内部子步骤计</li>
              <li>系统不互通节点：与上一步系统不同，且标注了「数据不互通」</li>
              <li>无法实现移动端节点：线上办理且「不支持移动端」</li>
              <li>同一节点可能同时计入两类</li>
            </ul>
          </details>
        </section>

        {/* 当前环节的操作面板 */}
        {early && <IntakeTriage v={v} project={project} me={me} onSaved={ctx.refresh} />}
        {assigning && early && <IntakeAssign v={v} project={project} users={users} me={me} onSaved={ctx.refresh} />}
        {phase === "advance" && <IntakeSolution v={v} project={project} onSaved={ctx.refresh} onMembers={() => ctx.setMembersOpen(true)} />}
        {phase === "assess" && <IntakeAssessment key={v.reviewId} v={v} project={project} me={me} onSaved={ctx.refresh} />}
        {(phase === "final" || phase === "done") && <IntakeFinal v={v} project={project} me={me} onSaved={ctx.refresh} />}
        {/* 过了指派环节之后,PMO / 管理员仍可增补 PM、更换主负责 */}
        {assigning && !early && <IntakeAssign later v={v} project={project} users={users} me={me} onSaved={ctx.refresh} />}
      </div>

      <aside className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {/* 承接团队 */}
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            承接团队
            <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">PM×{pms.length}</span>
            {canAssignMembers(project.can) && !ended && (
              <button type="button" onClick={() => ctx.setMembersOpen(true)} className="text-xs font-medium text-[color:var(--tint)] hover:underline">
                管理
              </button>
            )}
          </h2>
          <ul className="mt-3 space-y-2.5 text-[13px]">
            <MemberRow
              label="PM"
              full="项目经理"
              people={pms}
              leadId={project.leadPmId}
              warn
              hint={v.triageDoneAt || me.role === "admin" ? "待 PMO 指派" : "待 PMO 初级分析后指派"}
            />
            <MemberRow label="BH" full="业务经办" people={handlers} hint={pms.length ? "尚未分配，由 PM 分配" : "指派 PM 后由 PM 分配"} />
            {devs.length > 0 && <MemberRow label="TH" full="科技经办" people={devs} />}
            <MemberRow label="CTO" full="首席技术官" people={ctos} hint="尚未设置 CTO 岗位" />
          </ul>
          <SupportPanel v={v} projectId={project.id} onSaved={ctx.refresh} onAsk={setSupportAsk} />
        </section>

        {/* 承接动态 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
            承接动态
            <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{events.length}</span>
          </h2>
          {events.length === 0 ? (
            <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">流程刚提交，还没有承接动作。</p>
          ) : (
            <ol className="mt-3">
              {events.map(({ event, count }, i) => {
                const line = eventLine(event);
                return (
                  <li key={event.id} className="flex gap-3">
                    <div className="flex w-[30px] shrink-0 flex-col items-center pt-1">
                      <span className={cn("z-[1] size-[9px] rounded-full ring-4 ring-white/80", TONE_DOT[line.tone ?? "plain"])} />
                      {i < events.length - 1 && <span className="min-h-[18px] w-0.5 flex-1 bg-gradient-to-b from-[rgba(120,120,128,0.22)] to-[rgba(120,120,128,0.08)]" />}
                    </div>
                    <div className="min-w-0 flex-1 pb-4">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <b className="text-[13px] font-semibold leading-snug text-neutral-900">
                          {line.title}
                          {count > 1 && <span className="ml-1 font-data text-[12px] text-[color:var(--tint)]">×{count}</span>}
                        </b>
                        <span className="text-[11px] tabular-nums text-[color:var(--ink-3)]">
                          {event.actorName || "系统"} · {fmtDateTime(event.createdAt)}
                        </span>
                      </div>
                      {line.body && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--ink-2)]">{line.body}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="glass-card p-5 text-xs leading-relaxed text-[color:var(--ink-2)]">
          <b className="text-[13px] text-neutral-900">这一段怎么走</b>
          <ol className="mt-1.5 grid list-decimal gap-1 pl-4">
            <li>PMO 看自动诊断，做初级分析，再指派一名或多名 PM</li>
            <li>PM 按优先级推进：先把线下节点转为线上，再打通系统互通，最后做移动化；可分配 BH、申请 CTO 协助</li>
            <li>CTO 逐个技术点评估技术可行性</li>
            <li>整体流程与方案交回 PMO 终审，通过后进入下一阶段</li>
          </ol>
        </section>
      </aside>

      {supportAsk && <SupportDialog action={supportAsk} projectId={project.id} onClose={() => setSupportAsk(null)} onSaved={ctx.refresh} />}
    </div>
  );
}
