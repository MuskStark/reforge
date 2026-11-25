"use client";

/**
 * 流程项目组合:看板(按阶段分组)与列表两种视图。
 * 各阶段归并成五条在途泳道,已搁置 / 取消 / 完成的进「已结束」;筛选结果可导出为 CSV。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { authFetch, authFetchBlob, saveBlob, type SessionUser } from "@/lib/auth";
import type { Overview, ProjectView, UserDir } from "@/lib/types";
import { LANES, PENDING_ON_LABEL, laneOf } from "@/lib/labels";
import { AppShell, PageHead, StateLine } from "@/components/shell/app-shell";
import { ProjectCard } from "@/components/projects/project-card";
import { MembersDialog } from "@/components/projects/members-dialog";
import { cn } from "@/lib/utils";

type PendingFilter = "" | "cto" | "handler" | "pm" | "admin";

export function ProjectBoard() {
  return <AppShell active="projects">{(me) => <ProjectBoardBody me={me} />}</AppShell>;
}

function ProjectBoardBody({ me }: { me: SessionUser }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [users, setUsers] = useState<UserDir[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [pending, setPending] = useState<PendingFilter>("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"board" | "list">("board");
  const [assignOf, setAssignOf] = useState<ProjectView | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ps, us, ov] = await Promise.all([
        authFetch<ProjectView[]>("/api/projects", { cache: "no-store" }),
        authFetch<UserDir[]>("/api/users", { cache: "no-store" }),
        authFetch<Overview>("/api/overview", { cache: "no-store" }),
      ]);
      setProjects(ps);
      setUsers(us ?? []);
      setOverview(ov);
    } catch {
      /* 会话失效由外壳处理 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const myId = me?.id ?? "";
    const q = query.trim().toLowerCase();
    return (projects ?? [])
      .filter((p) => scope === "all" || p.members.some((m) => m.userId === myId))
      .filter((p) => !pending || p.pendingOn === pending)
      .filter((p) => !q || (p.name + " " + p.applicant).toLowerCase().includes(q));
  }, [projects, scope, pending, query, me?.id]);

  const lanes = useMemo(
    () =>
      LANES.map((lane) => ({
        lane,
        items: shown.filter((p) => laneOf(p).key === lane.key),
      })),
    [shown],
  );

  // 导出当前筛选出的项目(界面上看到哪些就导哪些),顺序一致
  const exportList = async () => {
    if (shown.length === 0) return;
    setExporting(true);
    try {
      const { blob, filename } = await authFetchBlob(
        "/api/projects/export.csv",
        { method: "POST", body: JSON.stringify({ ids: shown.map((p) => p.id) }) },
        "流程项目清单.csv",
      );
      saveBlob(blob, filename);
      toast.success(`已导出 ${shown.length} 个项目`, { description: filename });
    } catch (e) {
      if (!(e instanceof Error && e.message === "UNAUTHORIZED")) toast.error("导出失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setExporting(false);
    }
  };

  // 从项目详情返回(指派完成)后刷新
  const refreshOne = useCallback(async () => {
    if (!assignOf) return;
    try {
      const p = await authFetch<ProjectView>(`/api/projects/${assignOf.id}`, { cache: "no-store" });
      setProjects((prev) => (prev ?? []).map((x) => (x.id === p.id ? p : x)));
      setAssignOf(p);
    } catch {
      /* 忽略 */
    }
  }, [assignOf]);

  if (!projects) return <StateLine>加载中…</StateLine>;

  const waitingAssign = projects.filter((p) => p.status === "active" && !p.hasPm);
  const canAssign = (p: ProjectView) => p.can.assign && !p.hasPm;

  return (
    <>
      <PageHead
        title="流程项目"
        subtitle="每条已提交的流程都是一个改造项目：从分析立项、需求确认、方案设计、系统改造、试运行，到验收上线与运营优化；阶段可在后台「阶段模板」里调整。"
      >
        {overview && (
          <>
            <span className="lg-chip font-data px-3 py-1.5 text-xs text-[color:var(--ink-2)]">在途 {overview.active}</span>
            <span className="lg-chip px-3 py-1.5 text-xs text-[color:var(--ink-2)]">已搁置 {overview.onHold}</span>
            <span className="lg-chip px-3 py-1.5 text-xs text-[color:var(--ink-2)]">
              已完成 <b className="font-data text-[color:var(--green-deep)]">{overview.done}</b>
            </span>
          </>
        )}
      </PageHead>

      {/* 待指派提示:管理员 / CTO 看得到 */}
      {waitingAssign.length > 0 && projects.some((p) => p.can.assign) && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-[color:var(--amber-soft)] px-4 py-3 text-[13px] text-[color:var(--amber-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
          <span className="font-semibold">{waitingAssign.length} 个流程等待立项指派</span>
          <span className="text-[color:var(--ink-2)]">指派 PM 后项目正式启动</span>
          <button
            type="button"
            onClick={() => setAssignOf(waitingAssign[0])}
            className="btn btn-glass ml-auto !h-9 !px-3.5 text-[13px]"
          >
            <Users className="h-3.5 w-3.5" /> 去指派 {waitingAssign[0].name}
          </button>
        </div>
      )}

      {/* 工具条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="seg seg-mini">
          {(
            [
              ["all", "全部"],
              ["mine", "我参与的"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setScope(v)} className={scope === v ? "on" : undefined}>
              {label}
            </button>
          ))}
        </div>
        <select
          value={pending}
          onChange={(e) => setPending(e.target.value as PendingFilter)}
          aria-label="按待处理人筛选"
          className="field !h-9 w-auto !text-[13px]"
        >
          <option value="">全部状态</option>
          {/* 与卡片上的待处理徽章同一份文案 */}
          <option value="admin">{PENDING_ON_LABEL.admin}</option>
          <option value="pm">{PENDING_ON_LABEL.pm}</option>
          <option value="cto">{PENDING_ON_LABEL.cto}</option>
          <option value="handler">{PENDING_ON_LABEL.handler}</option>
        </select>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" />
          <input
            className="field !h-9 pl-9 !text-[13px]"
            placeholder="搜索流程名称或申报人"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索项目"
          />
        </div>
        <div className="seg seg-mini">
          {(
            [
              ["board", "看板"],
              ["list", "列表"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setView(v)} className={view === v ? "on" : undefined}>
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void exportList()}
          disabled={exporting || shown.length === 0}
          className="btn btn-glass !h-9 !px-3.5 text-[13px] disabled:opacity-40"
          title="把当前列表导出为 CSV（Excel 可直接打开）"
        >
          <Download className="h-3.5 w-3.5" /> {exporting ? "导出中…" : "导出清单"}
        </button>
      </div>

      {projects.length === 0 ? (
        <section className="glass-card p-10 text-center">
          <h2 className="text-[17px] font-semibold">还没有流程项目</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[color:var(--ink-2)]">
            流程在前台提交后会自动立项并出现在这里。
          </p>
        </section>
      ) : shown.length === 0 ? (
        <StateLine>没有符合条件的项目</StateLine>
      ) : view === "board" ? (
        <div className="board-lanes">
          <div className="grid items-start gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 lane-cols-6">
          {lanes.map(({ lane, items }) => (
            <section key={lane.key} className="min-w-0">
              <h2 className="mb-2 flex items-center gap-2 px-1 text-[13px] font-semibold text-[color:var(--ink-2)]">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    lane.key === "intake" && "bg-[color:var(--amber)]",
                    lane.key === "design" && "bg-[color:var(--indigo)]",
                    lane.key === "build" && "bg-[#007aff]",
                    lane.key === "accept" && "bg-[color:var(--green)]",
                    lane.key === "operate" && "bg-[color:var(--tint)]",
                    lane.key === "closed" && "bg-[color:var(--ink-3)]",
                  )}
                />
                {lane.name}
                <span className="font-data ml-auto text-[11px] font-normal tabular-nums text-[color:var(--ink-3)]">{items.length}</span>
              </h2>
              {items.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-black/10 py-6 text-center text-xs text-[color:var(--ink-3)]">空</div>
              ) : (
                <div className="space-y-2.5">
                  {items.map((p) => (
                    <ProjectCard
                      key={p.id}
                      p={p}
                      dense
                      footer={
                        canAssign(p) ? (
                          <button type="button" onClick={() => setAssignOf(p)} className="btn btn-primary !h-8 w-full !px-3 text-[12px]">
                            <Users className="h-3.5 w-3.5" /> 指派 PM
                          </button>
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
          </div>
        </div>
      ) : (
        <div className="glass-card p-2">
          <ul>
            {shown.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-[color:var(--sep)] px-3 py-2.5 last:border-b-0">
                <LinkName p={p} />
                <span className="hidden text-xs text-[color:var(--ink-2)] sm:block">
                  阶段 {p.currentStage} · {p.stages[p.currentStage - 1]?.name}
                </span>
                {p.pendingOn && <span className="text-xs text-[color:var(--indigo-deep)]">{PENDING_ON_LABEL[p.pendingOn]}</span>}
                <span className="font-data ml-auto text-xs tabular-nums text-[color:var(--ink-3)]">
                  {p.stats.done}/{p.stats.total}
                </span>
                {canAssign(p) && (
                  <button type="button" onClick={() => setAssignOf(p)} className="btn btn-primary !h-8 !px-3 text-[12px]">
                    指派
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {assignOf && (
        <MembersDialog
          project={assignOf}
          users={users}
          onClose={() => setAssignOf(null)}
          onSaved={refreshOne}
        />
      )}
    </>
  );
}

function LinkName({ p }: { p: ProjectView }) {
  return (
    <Link href={`/projects/${p.id}`} prefetch={false} className="min-w-0 flex-1 truncate text-[14px] font-semibold text-neutral-900 hover:underline">
      {p.name}
    </Link>
  );
}
