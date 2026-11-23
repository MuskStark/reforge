"use client";

/**
 * 我的工作台(登录后首页):按角色组织。
 *   CTO  / 管理员:待我评审 → 需要关注的项目(有风险 / 逾期)→ 在途项目
 *   项目经理      :待我处理(待提交评审、逾期、阻塞)→ 我负责的项目 → 我的任务
 *   经办 / 开发   :待我确认 / 评审 → 我的任务 → 我参与的项目
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, FileSignature, Hourglass, Layers } from "lucide-react";
import { authFetch, type SessionUser } from "@/lib/auth";
import type { Overview, PendingReview, ProjectView, WorkItem } from "@/lib/types";
import { HEALTH_LABEL, ITEM_STATUS_LABEL, MODE_LABEL, PRIORITY_LABEL, dueInfo, healthClass, priorityClass } from "@/lib/labels";
import { AppShell, PageHead, StateLine } from "@/components/shell/app-shell";
import { ProjectCard } from "@/components/projects/project-card";
import { Avatar } from "@/components/projects/stage-rail";
import { cn } from "@/lib/utils";

type Tab = "todo" | "reviews" | "projects" | "tasks";

export function Workbench() {
  return <AppShell active="work">{(me) => <WorkbenchBody me={me} />}</AppShell>;
}

function WorkbenchBody({ me }: { me: SessionUser }) {
  const [tab, setTab] = useState<Tab>("todo");
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [tasks, setTasks] = useState<WorkItem[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);

  const load = useCallback(async () => {
    try {
      const [ps, rv, mine, ov] = await Promise.all([
        authFetch<ProjectView[]>("/api/projects", { cache: "no-store" }),
        authFetch<PendingReview[]>("/api/reviews/pending", { cache: "no-store" }),
        authFetch<WorkItem[]>("/api/me/items", { cache: "no-store" }),
        authFetch<Overview>("/api/overview", { cache: "no-store" }),
      ]);
      setProjects(ps);
      setReviews(rv ?? []);
      setTasks(mine ?? []);
      setOverview(ov);
    } catch {
      /* 会话失效由外壳处理 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isCTO = me?.jobRole === "cto" || me?.role === "admin";

  const mine = useMemo(() => {
    const myId = me?.id ?? "";
    return (projects ?? []).filter((p) => p.members.some((m) => m.userId === myId));
  }, [projects, me?.id]);

  /** 有风险 / 逾期 / 阻塞的在途项目 */
  const risky = useMemo(
    () => (projects ?? []).filter((p) => p.status === "active" && (p.health !== "on_track" || p.stats.overdue > 0 || p.stats.blocked > 0)),
    [projects],
  );

  /** 需要我出手的在途项目:待我评审;CTO / 管理员另含待指派与有风险的;项目经理另含轮到自己推进的 */
  const needsMe = useMemo(() => {
    const myId = me?.id ?? "";
    const oversight = me?.role === "admin" || me?.jobRole === "cto";
    const riskyIds = new Set(risky.map((p) => p.id));
    return (projects ?? []).filter((p) => {
      if (p.status !== "active") return false;
      if (reviews.some((r) => r.projectId === p.id)) return true;
      if (oversight && (p.pendingOn === "admin" || riskyIds.has(p.id))) return true;
      const iAmPM = p.members.some((m) => m.userId === myId && m.role === "pm");
      return iAmPM && (p.pendingOn === "pm" || p.stats.overdue > 0 || p.stats.blocked > 0);
    });
  }, [projects, reviews, risky, me?.id, me?.role, me?.jobRole]);

  if (!projects) return <StateLine>加载中…</StateLine>;

  const myTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const empty = projects.length === 0 && reviews.length === 0 && myTasks.length === 0;

  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: "todo", label: "待我处理", n: reviews.length + myTasks.length + needsMe.filter((p) => !reviews.some((r) => r.projectId === p.id)).length },
    { id: "reviews", label: "待我评审", n: reviews.length },
    { id: "projects", label: isCTO ? "全部项目" : "我参与的项目", n: isCTO ? projects.length : mine.length },
    { id: "tasks", label: "我的任务", n: myTasks.length },
  ];
  const roleLine =
    me.role === "admin"
      ? "系统管理员"
      : me.jobRole === "cto"
        ? "CTO"
        : me.jobRole === "pm"
          ? "项目经理"
          : me.jobRole === "handler"
            ? "经办"
            : me.jobRole === "dev"
              ? "开发实施"
              : "成员";

  return (
    <>
      <PageHead
        title={
          <span className="flex items-center gap-2.5">
            <Avatar name={me.displayName || me.username} size={34} />
            {me.displayName || me.username}，你好
          </span>
        }
        subtitle={
          me.role === "admin" || me.jobRole === "cto"
            ? "先处理等你评审的关卡，再看哪些项目需要你介入。"
            : me.jobRole === "pm"
              ? "推进你负责的流程：完成必交付物、提交评审、及时写简报。"
              : "这里是你需要确认、评审或办理的事项。"
        }
      >
        <span className="badge badge-plain !h-[24px]">{roleLine}</span>
        {overview && (
          <>
            <span className="lg-chip font-data px-3 py-1.5 text-xs text-[color:var(--ink-2)]">在途 {overview.active}</span>
            <span className="lg-chip px-3 py-1.5 text-xs text-[color:var(--ink-2)]">
              待评审 <b className="font-data text-[color:var(--indigo-deep)]">{overview.pendingReviews}</b>
            </span>
            <span className={cn("lg-chip px-3 py-1.5 text-xs", overview.overdueItems > 0 ? "text-[color:var(--red-deep)]" : "text-[color:var(--ink-2)]")}>
              逾期 <b className="font-data">{overview.overdueItems}</b>
            </span>
            <span className="lg-chip px-3 py-1.5 text-xs text-[color:var(--ink-2)]">
              阻塞 <b className="font-data">{overview.blockedItems}</b>
            </span>
          </>
        )}
      </PageHead>

      {empty ? (
        <section className="glass-card p-8 text-center">
          <Layers className="mx-auto h-9 w-9 text-[color:var(--ink-3)]" />
          <h2 className="mt-3 text-[17px] font-semibold">还没有需要你处理的事情</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[color:var(--ink-2)]">
            流程一提交就会自动立项。项目经理由管理员或 CTO 指派；被加入项目后，待办会出现在这里。
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2.5">
            <Link href="/projects" className="btn btn-glass">
              查看全部项目
            </Link>
            <Link href="/" className="btn btn-primary">
              去提交流程
            </Link>
          </div>
        </section>
      ) : (
        <>
          {/* 分段 */}
          <div className="seg mb-4 max-w-[560px] overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} className={tab === t.id ? "on" : undefined}>
                {t.label}
                {t.n ? <span className="font-data ml-1.5 text-[11px] text-[color:var(--ink-3)]">{t.n}</span> : null}
              </button>
            ))}
          </div>

          {tab === "todo" && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-4">
                {/* 待我评审 */}
                <Section icon={FileSignature} title="待我评审" count={reviews.length} tone="indigo">
                  {reviews.length === 0 ? (
                    <EmptyLine>没有等你评审的关卡。</EmptyLine>
                  ) : (
                    <ul className="grid gap-2.5">
                      {reviews.map((r) => {
                        const stage = projects.find((p) => p.id === r.projectId)?.stages[r.stageSeq - 1];
                        return (
                          <li key={r.id}>
                            <Link
                              href={`/projects/${r.projectId}?tab=review`}
                              className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/60 px-3.5 py-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(88,86,214,0.22)] transition hover:bg-white/80"
                            >
                              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)]">
                                <FileSignature className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14px] font-semibold text-neutral-900">{r.projectName}</span>
                                <span className="mt-0.5 block truncate text-xs text-[color:var(--ink-2)]">
                                  阶段 {r.stageSeq} · {stage?.name} · {stage?.gate}（{MODE_LABEL[r.mode]} · 第 {r.round} 轮）
                                  {r.summary ? ` · ${r.summary}` : ""}
                                </span>
                              </span>
                              <span className={priorityClass(r.priority)}>{PRIORITY_LABEL[r.priority]}优先</span>
                              {r.waitingDays >= 3 ? (
                                <span className="badge badge-warn !h-[20px] text-[11px] font-data">已等 {r.waitingDays} 天</span>
                              ) : (
                                <span className="font-data text-[11px] text-[color:var(--ink-3)]">{r.waitingDays === 0 ? "今天提交" : `${r.waitingDays} 天前提交`}</span>
                              )}
                              <ArrowRight className="h-4 w-4 shrink-0 text-[color:var(--ink-3)]" />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Section>

                {/* 轮到我推进 / 需要我处理的项目 */}
                <Section icon={Hourglass} title={isCTO ? "需要关注的项目" : me.jobRole === "pm" ? "等我推进的项目" : "等我处理的项目"} count={needsMe.length}>
                  {needsMe.length === 0 ? (
                    <EmptyLine>{isCTO ? "没有需要你关注的项目。" : "没有等你处理的项目。"}</EmptyLine>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {needsMe.map((p) => (
                        <ProjectCard key={p.id} p={p} dense />
                      ))}
                    </div>
                  )}
                </Section>

                {/* 我的任务摘要 */}
                <Section icon={ClipboardCheck} title="我的待办任务" count={myTasks.length}>
                  {myTasks.length === 0 ? (
                    <EmptyLine>没有分配给你的任务。</EmptyLine>
                  ) : (
                    <ul className="grid gap-1">
                      {myTasks.slice(0, 6).map((t) => (
                        <TaskRow key={t.id} t={t} />
                      ))}
                    </ul>
                  )}
                </Section>
              </div>

              {/* 侧栏:风险与概况 */}
              <aside className="space-y-4">
                <section className="glass-card p-5">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold">
                    <AlertTriangle className="h-4 w-4 text-[color:var(--amber)]" />
                    风险与逾期
                    <span className="badge badge-warn ml-auto !h-[20px] text-[11px]">{risky.filter((p) => p.health !== "on_track").length}</span>
                  </h3>
                  {risky.length === 0 ? (
                    <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">所有在途项目状态正常。</p>
                  ) : (
                    <ul className="mt-3 grid gap-1">
                      {risky.slice(0, 8).map((p) => (
                        <li key={p.id}>
                          <Link href={`/projects/${p.id}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-white/60">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-900">{p.name}</span>
                            <span className={healthClass(p.health)}>{HEALTH_LABEL[p.health]}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="glass-card p-5">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold">
                    <CheckCircle2 className="h-4 w-4 text-[color:var(--green)]" />
                    阶段分布
                  </h3>
                  {overview && overview.active === 0 ? (
                    <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">当前没有在途项目。</p>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {(overview?.byStage ?? []).map((n, i) => {
                        const name = overview?.stageNames?.[i] ?? `阶段 ${i + 1}`;
                        const max = Math.max(1, ...(overview?.byStage ?? [1]));
                        return (
                          <li key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-[62px] shrink-0 text-[color:var(--ink-2)]">{name}</span>
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(120,120,128,0.12)]">
                              <span className="block h-full rounded-full bg-[color:var(--tint)]" style={{ width: `${(n / max) * 100}%` }} />
                            </span>
                            <span className="font-data w-5 text-right tabular-nums text-[color:var(--ink-2)]">{n}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {overview && overview.pendingReviews > 0 && (
                    <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-2)]">
                      待决评审平均已等待 <b className="font-data text-[color:var(--indigo-deep)]">{overview.reviewWaitDays}</b> 天
                      {overview.reviewWaitDays >= 3 ? "，评审正在成为瓶颈" : ""}。
                    </p>
                  )}
                </section>
              </aside>
            </div>
          )}

          {tab === "reviews" && (
            <Section icon={FileSignature} title="待我评审" count={reviews.length} tone="indigo">
              {reviews.length === 0 ? (
                <EmptyLine>没有等你评审的关卡。提交后会在这里出现。</EmptyLine>
              ) : (
                <ul className="grid gap-2.5">
                  {reviews.map((r) => {
                    const stage = projects.find((p) => p.id === r.projectId)?.stages[r.stageSeq - 1];
                    return (
                      <li key={r.id}>
                        <Link href={`/projects/${r.projectId}?tab=review`} className="glass-card flex flex-wrap items-center gap-3 p-4 transition hover:-translate-y-0.5">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-semibold text-neutral-900">{r.projectName}</span>
                            <span className="mt-1 block text-xs text-[color:var(--ink-2)]">
                              {stage?.gate} · {MODE_LABEL[r.mode]} · 第 {r.round} 轮 · {r.submittedByName} 提交
                            </span>
                            {r.summary && <span className="mt-1.5 block line-clamp-2 text-[13px] leading-relaxed text-[color:var(--ink-2)]">{r.summary}</span>}
                          </span>
                          {r.waitingDays >= 3 && <span className="badge badge-warn !h-[20px] text-[11px] font-data">已等 {r.waitingDays} 天</span>}
                          <span className="btn btn-primary !h-9 !px-3.5 text-[13px]">去评审</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          )}

          {tab === "projects" && (
            <Section icon={Layers} title={isCTO ? "全部项目" : "我参与的项目"} count={isCTO ? projects.length : mine.length}>
              {(isCTO ? projects : mine).length === 0 ? (
                <EmptyLine>你还没有参与任何项目。</EmptyLine>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {(isCTO ? projects : mine).map((p) => (
                    <ProjectCard key={p.id} p={p} />
                  ))}
                </div>
              )}
            </Section>
          )}

          {tab === "tasks" && (
            <Section icon={ClipboardCheck} title="我的任务" count={myTasks.length}>
              {myTasks.length === 0 ? (
                <EmptyLine>没有分配给你的任务。</EmptyLine>
              ) : (
                <ul className="grid gap-1">
                  {myTasks.map((t) => (
                    <TaskRow key={t.id} t={t} />
                  ))}
                </ul>
              )}
            </Section>
          )}
        </>
      )}
    </>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  tone = "default",
  children,
}: {
  icon: typeof Layers;
  title: string;
  count?: number;
  tone?: "default" | "indigo";
  children: React.ReactNode;
}) {
  return (
    <section className="glass-card p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
        <span className={cn("grid h-7 w-7 place-items-center rounded-full", tone === "indigo" ? "bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)]" : "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]")}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        {title}
        {count != null && <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{count}</span>}
      </h2>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-black/10 bg-white/30 px-3 py-3 text-center text-xs text-[color:var(--ink-3)]">{children}</p>;
}

function TaskRow({ t }: { t: WorkItem }) {
  const due = dueInfo(t.dueDate);
  return (
    <li>
      <Link href={`/projects/${t.projectId}?tab=plan&item=${t.id}`} className="flex flex-wrap items-center gap-2.5 rounded-xl px-2 py-1.5 transition hover:bg-white/60">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-900">{t.title}</span>
        <span className="hidden text-xs text-[color:var(--ink-3)] sm:block">{t.projectName}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", t.status === "blocked" ? "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]" : t.status === "in_progress" ? "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]" : "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]")}>
          {ITEM_STATUS_LABEL[t.status]}
        </span>
        {due && <span className={cn("font-data text-[11px] tabular-nums", due.overdue ? "font-semibold text-[color:var(--red-deep)]" : "text-[color:var(--ink-3)]")}>{due.label}</span>}
      </Link>
    </li>
  );
}
