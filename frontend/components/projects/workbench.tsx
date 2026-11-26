"use client";

/**
 * 工作台(登录后的首页):只回答"我现在要做什么"。
 * 主列是一张按动作分组的清单——待我评审 / 待我初析与指派 / 待我终审 / 等我推进 / 我的任务,不同的人看到不同的组;
 * 右栏是我提交的需求(有才显示)、我的项目与需要关注的。有内容才成卡,空的收成一行,各组全空显示「都处理完了」。
 * 分组的口径与侧栏上的待办数字共用 lib/workbench.ts。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, ClipboardCheck, FileSignature, Hourglass, Plus, Presentation, Route, Stamp, TriangleAlert, UserPlus, Waypoints, Workflow, Users } from "lucide-react";
import { AppShell, PageHead, StateLine, announceTodo } from "@/components/shell/app-shell";
import { MembersDialog } from "@/components/projects/members-dialog";
import { EditProcessModal } from "@/components/followup/edit-process-modal";
import { PendingOnBadge } from "@/components/projects/stage-rail";
import { computeWorkbench, canEditSubmission, riskWhy } from "@/lib/workbench";
import { inIntakeStage, intakeHref, isIntakeReview } from "@/lib/intake";
import { authFetch, type SessionUser } from "@/lib/auth";
import type { FlowProcess, PendingReview, ProjectView, UserDir, WorkItem } from "@/lib/types";
import { HEALTH_LABEL, ITEM_STATUS_LABEL, MODE_LABEL, PENDING_ON_LABEL, PRIORITY_LABEL, STATUS_LABEL, dueInfo, fmtDate, pct, priorityClass, statusClass } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** 每组默认最多显示几行,其余「显示全部」就地展开 */
const FOLD = 3;

const DAY = 86_400_000;
/** 隔了几个自然日:昨晚提交的流程过零点就是「1 天前提交」(按满 24 小时算会一整天都显示「今天提交」) */
const daysAgo = (iso: string) => {
  const at = new Date(iso);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((midnight.getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / DAY));
};

/** 「今天提交 / N 天前提交」;等了 3 天以上标红成「已等 N 天」 */
function Wait({ days }: { days: number }) {
  if (days >= 3) return <span className="act-when warn">已等 {days} 天</span>;
  return <span className="act-when">{days === 0 ? "今天提交" : `${days} 天前提交`}</span>;
}

/** 健康度徽章:已偏离用红,有风险用琥珀 */
const healthBadge = (p: ProjectView) => <span className={cn("badge !h-[20px] !px-2 text-[11px]", p.health === "off_track" ? "badge-warn" : "badge-amber")}>{HEALTH_LABEL[p.health]}</span>;

/**
 * 清单里的一组。条目的类型随组走(PendingReview / ProjectView / WorkItem 各不相同),
 * 所以渲染在组内部完成,对外只暴露统一的形状:数量、是否适用、画出前几行或全部。
 */
function group<T>(g: { key: string; icon: LucideIcon; tone: string; title: string; empty: string; items: T[]; keyOf: (item: T) => string; render: (item: T) => React.ReactNode; applies: boolean }) {
  return {
    key: g.key,
    icon: g.icon,
    tone: g.tone,
    title: g.title,
    empty: g.empty,
    applies: g.applies,
    count: g.items.length,
    draw: (all: boolean) =>
      g.items
        .slice(0, all ? g.items.length : FOLD)
        .map((item) => <Fragment key={g.keyOf(item)}>{g.render(item)}</Fragment>),
  };
}

export function Workbench() {
  return <AppShell active="work">{(me) => <WorkbenchBody me={me} />}</AppShell>;
}

function WorkbenchBody({ me }: { me: SessionUser }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [tasks, setTasks] = useState<WorkItem[]>([]);
  const [users, setUsers] = useState<UserDir[]>([]);
  const [assignOf, setAssignOf] = useState<ProjectView | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 正在修改的自己提交的流程(未被处理时可以改) */
  const [editing, setEditing] = useState<FlowProcess | null>(null);

  const isAdmin = me.role === "admin";
  const isPM = me.jobRole === "pm";
  const isPMO = me.jobRole === "viewer";

  const canAssign = isAdmin || isPMO;
  // 无岗位的纯提交人:右栏只有「我提交的需求」,不参与项目
  const jobless = me.role !== "admin" && !me.jobRole;

  const load = useCallback(async () => {
    try {
      // 用户名单只有能指派 PM 的人(管理员、PMO)打开成员管理时用得上
      const [ps, rv, mine, us] = await Promise.all([
        authFetch<ProjectView[]>("/api/projects", { cache: "no-store" }),
        authFetch<PendingReview[]>("/api/reviews/pending", { cache: "no-store" }),
        authFetch<WorkItem[]>("/api/me/items", { cache: "no-store" }),
        canAssign ? authFetch<UserDir[]>("/api/users", { cache: "no-store" }) : Promise.resolve([] as UserDir[]),
      ]);
      setProjects(ps);
      setReviews(rv ?? []);
      setTasks(mine ?? []);
      setUsers(us ?? []);
    } catch {
      /* 会话失效由外壳处理 */
    }
  }, [canAssign]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = useMemo(() => (projects ? computeWorkbench(me, projects, reviews, tasks) : null), [me, projects, reviews, tasks]);

  // 侧栏「工作台」后面的数字:这里已经算好,直接告诉外壳,外壳不必再请求一遍
  const total = model?.total;
  useEffect(() => {
    if (total != null) announceTodo(total);
  }, [total]);

  // 指派完成后刷新这一个项目
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

  if (!model) return <StateLine>加载中…</StateLine>;

  const showRisk = model.oversee || isPM;
  const projectOf = (id: string) => projects?.find((p) => p.id === id);
  const stageOf = (p?: ProjectView) => p?.stages[p.currentStage - 1];

  /** 四类行动:顺序固定,人人一样;不适用的组不出现 */
  const groups = [
    group<PendingReview>({
      key: "review",
      icon: FileSignature,
      tone: "indigo",
      title: "待我评审",
      empty: "没有等你评审的关卡",
      items: model.review,
      keyOf: (r) => r.id,
      applies: true,
      render: (r) => {
        // 技术可行性评估(承接阶段的关卡)在「承接」标签里做,其余关卡在「评审」标签里
        const intake = isIntakeReview(r, projectOf(r.projectId));
        const stage = projectOf(r.projectId)?.stages[r.stageSeq - 1];
        const href = `/projects/${r.projectId}?tab=${intake ? "intake" : "review"}`;
        return (
          <div className="act-row">
            <Link href={href} prefetch={false} className="act-main">
              <span className="act-title">{r.projectName}</span>
              <span className="act-meta">
                {intake
                  ? `技术可行性评估（${MODE_LABEL[r.mode]} · 第 ${r.round} 轮）`
                  : `阶段 ${r.stageSeq} · ${stage?.name ?? ""}${stage?.gate && ` · ${stage.gate}`}（${MODE_LABEL[r.mode]} · 第 ${r.round} 轮）`}
                {r.summary ? ` · ${r.summary}` : ""}
              </span>
            </Link>
            <span className="act-tags">
              <span className={cn(priorityClass(r.priority), "!h-[20px] !px-2 text-[11px]")}>{PRIORITY_LABEL[r.priority]}优先</span>
              <Wait days={r.waitingDays} />
            </span>
            <Link href={href} prefetch={false} className="btn-tint">
              {intake ? "去评估" : "去评审"}
            </Link>
          </div>
        );
      },
    }),
    group<ProjectView>({
      key: "assign",
      icon: UserPlus,
      tone: "amber",
      title: "待我初析与指派",
      empty: "没有等你初析指派的流程",
      items: model.assign,
      keyOf: (p) => p.id,
      // PMO 岗位与管理员:新流程还没有 PM
      applies: isAdmin || isPMO,
      render: (p) => (
        <div className="act-row">
          <Link href={p.intake ? intakeHref(p) : `/projects/${p.id}`} prefetch={false} className="act-main">
            <span className="act-title">{p.name}</span>
            <span className="act-meta">
              {p.applicant ? `${p.applicant} 提交 · ` : ""}
              {fmtDate(p.createdAt)}
              {p.intake && ` · 线下节点 ${p.intake.offline} · 系统不互通 ${p.intake.interop} · 无法移动端 ${p.intake.mobile}`}
            </span>
          </Link>
          <span className="act-tags">
            <Wait days={daysAgo(p.createdAt)} />
          </span>
          {p.intake ? (
            // 需求承接的项目:初级分析与指派都在「承接」标签里
            <Link href={intakeHref(p)} prefetch={false} className="btn-tint">
              <Route className="h-3.5 w-3.5" aria-hidden="true" /> {p.intake.triageDone ? "去指派" : "去初析"}
            </Link>
          ) : (
            <button type="button" className="btn-tint" onClick={() => setAssignOf(p)}>
              <UserPlus aria-hidden="true" />
              指派 PM
            </button>
          )}
        </div>
      ),
    }),
    group<ProjectView>({
      key: "final",
      icon: Stamp,
      tone: "indigo",
      title: "待我终审",
      empty: "没有等你终审的方案",
      items: model.final,
      keyOf: (p) => p.id,
      // PMO 岗位与管理员:技术可行性评估已通过、等终审
      applies: isAdmin || isPMO,
      render: (p) => (
        <div className="act-row">
          <Link href={intakeHref(p)} prefetch={false} className="act-main">
            <span className="act-title">{p.name}</span>
            <span className="act-meta">技术可行性评估已通过，整体流程与方案等你终审{p.intake && ` · 待改造节点 ${p.intake.offline + p.intake.interop + p.intake.mobile} 个`}</span>
          </Link>
          <span className="act-tags">
            <span className="badge badge-indigo !h-[20px] !px-2 text-[11px]">PMO 终审</span>
          </span>
          <Link href={intakeHref(p)} prefetch={false} className="btn-tint">
            去终审
          </Link>
        </div>
      ),
    }),
    group<ProjectView>({
      key: "advance",
      icon: Hourglass,
      tone: "blue",
      title: "等我推进",
      empty: "没有等你推进的项目",
      items: model.advance,
      keyOf: (p) => p.id,
      applies: isPM,
      render: (p) => {
        const stage = stageOf(p);
        const due = dueInfo(stage?.dueDate ?? p.dueDate);
        const why = riskWhy(p);
        const pendingMe = p.pendingOn === "pm";
        // 还停在承接阶段的项目,推进在「承接」标签里
        const href = inIntakeStage(p) ? intakeHref(p) : `/projects/${p.id}`;
        return (
          <div className="act-row">
            <Link href={href} prefetch={false} className="act-main">
              <span className="act-title">{p.name}</span>
              <span className="act-meta">
                阶段 {p.currentStage} · {stage?.name ?? ""}
                <span className="mx-1.5 text-[color:var(--ink-3)]">·</span>
                {pendingMe ? PENDING_ON_LABEL.pm : why || HEALTH_LABEL[p.health]}
              </span>
            </Link>
            <span className="act-tags">
              {p.health !== "on_track" && healthBadge(p)}
              {/* 轮到我了,同时还有逾期 / 阻塞:原因单独亮出来 */}
              {pendingMe && why && <span className="act-when warn">{why}</span>}
              {due && <span className={cn("act-when", due.overdue && "warn")}>{due.label}</span>}
            </span>
            <Link href={href} prefetch={false} className="btn-tint">
              去推进
            </Link>
          </div>
        );
      },
    }),
    group<WorkItem>({
      key: "tasks",
      icon: ClipboardCheck,
      tone: "plain",
      title: "我的任务",
      empty: "没有分配给你的任务",
      items: model.tasks,
      keyOf: (t) => t.id,
      applies: true,
      render: (t) => {
        const due = dueInfo(t.dueDate);
        const href = `/projects/${t.projectId}?tab=plan&item=${t.id}`;
        return (
          <div className="act-row">
            <Link href={href} prefetch={false} className="act-main">
              <span className="act-title">{t.title}</span>
              <span className="act-meta">
                {t.projectName}
                {t.blockReason && (
                  <>
                    <span className="mx-1.5 text-[color:var(--ink-3)]">·</span>
                    <b className="warn">阻塞：{t.blockReason}</b>
                  </>
                )}
              </span>
            </Link>
            <span className="act-tags">
              <span className={cn("badge !h-[20px] !px-2 text-[11px]", t.status === "blocked" ? "badge-warn" : t.status === "in_progress" ? "badge-blue" : "badge-plain")}>
                {ITEM_STATUS_LABEL[t.status]}
              </span>
              {due && <span className={cn("act-when", due.overdue && "warn")}>{due.label}</span>}
            </span>
            <Link href={href} prefetch={false} className="btn-tint">
              去处理
            </Link>
          </div>
        );
      },
    }),
  ].filter((g) => g.applies);
  const filled = groups.filter((g) => g.count > 0);
  const idle = groups.filter((g) => g.count === 0);

  /** 页头的一句话摘要 */
  const summary = model.total === 0 ? "现在没有等你处理的事情。" : <>{model.total} 件事等你处理{model.urgent > 0 && <>，其中 <b className="warn">{model.urgent} 件</b>已经拖了</>}。</>;

  /** 都处理完时的快捷入口,按角色给 */
  const quick = isAdmin
    ? [
        { icon: Workflow, label: "流程定义", href: "/admin/processes" },
        { icon: Users, label: "用户与岗位", href: "/admin/users" },
        { icon: Presentation, label: "数据大屏", href: "/monitor" },
        { icon: Plus, label: "提交流程", href: "/" },
      ]
    : model.oversee
      ? [
          { icon: Waypoints, label: "流程项目", href: "/projects" },
          { icon: Presentation, label: "数据大屏", href: "/monitor" },
          { icon: Plus, label: "提交流程", href: "/" },
        ]
      : [
          { icon: Waypoints, label: "流程项目", href: "/projects" },
          { icon: Plus, label: "提交流程", href: "/" },
        ];

  const projRow = (p: ProjectView, trailing?: React.ReactNode) => {
    const progress = pct(p.stats.done, p.stats.total);
    const tag =
      p.status !== "active" ? (
        <span className={cn(statusClass(p.status), "!h-[20px] text-[11px]")}>{STATUS_LABEL[p.status]}</span>
      ) : p.health !== "on_track" ? (
        healthBadge(p)
      ) : (
        <PendingOnBadge on={p.pendingOn} />
      );
    return (
      <Link key={p.id} href={`/projects/${p.id}`} prefetch={false} className="proj-row">
        <span className="proj-top">
          <span className="proj-name">{p.name}</span>
          {tag}
          {trailing}
        </span>
        <span className="proj-bottom">
          <span className="proj-stage">
            <b>
              {p.currentStage}/{p.stages.length}
            </b>{" "}
            · {stageOf(p)?.name ?? ""}
          </span>
          <span className={cn("proj-bar", p.health !== "on_track" && "is-warn")} aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </span>
          <span className="proj-pct">{progress}%</span>
        </span>
      </Link>
    );
  };

  // 打开自己未处理需求的修改弹层:先把流程定义读出来
  const openEditSubmission = async (p: ProjectView) => {
    try {
      const proc = await authFetch<FlowProcess>(`/api/processes/${p.processId}`, { cache: "no-store" });
      setEditing(proc);
    } catch {
      toast.error("读取流程失败", { description: "请稍后重试" });
    }
  };

  return (
    <>
      <PageHead title="工作台" subtitle={summary} />

      <div className="wb-grid">
        <div className="min-w-0 space-y-3.5">
          {model.total === 0 ? (
            <section className="glass-card allclear">
              <span className="allclear-bead" aria-hidden="true">
                <Check />
              </span>
              <h2 className="text-[22px] font-bold tracking-[-0.02em] text-neutral-900">都处理完了</h2>
              <p className="mx-auto mt-2 max-w-[30em] text-[15px] leading-relaxed text-[color:var(--ink-2)]">现在没有等你评审、初析指派、终审或办理的事情。新的待办一出现就会列在这里。</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2.5 border-t border-[color:var(--sep)] pt-5">
                {quick.map(({ icon: Icon, label, href }) => (
                  <Link
                    key={href}
                    href={href}
                    prefetch={false}
                    className="inline-flex h-9 items-center gap-2 rounded-full bg-white/75 px-4 text-[13px] font-semibold text-neutral-900 shadow-[inset_0_1px_0_#fff,inset_0_0_0_0.5px_rgba(255,255,255,0.6),0_3px_10px_-5px_rgba(23,42,80,0.25)]"
                  >
                    <Icon className="h-4 w-4 text-[color:var(--tint)]" aria-hidden="true" />
                    {label}
                  </Link>
                ))}
              </div>
            </section>
          ) : (
            <>
              {filled.map((g) => {
                const showAll = Boolean(expanded[g.key]);
                return (
                  <section key={g.key} className="glass-card act-card" aria-label={g.title}>
                    <header className="act-head">
                      <span className={cn("act-ic", g.tone)}>
                        <g.icon aria-hidden="true" />
                      </span>
                      <h2>{g.title}</h2>
                      <span className="badge badge-plain !h-[20px] font-data text-[11px]">{g.count}</span>
                    </header>
                    {g.draw(showAll)}
                    {g.count > FOLD && (
                      <button type="button" className="act-more" aria-expanded={showAll} onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !showAll }))}>
                        {showAll ? "收起" : `显示全部 ${g.count} 项`}
                        <ChevronDown className={cn("h-4 w-4 transition-transform", showAll && "rotate-180")} aria-hidden="true" />
                      </button>
                    )}
                  </section>
                );
              })}
              {idle.length > 0 && (
                <p className="act-quiet">
                  {idle.map((g) => (
                    <span key={g.key}>
                      <Check aria-hidden="true" />
                      {g.empty}
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>

        <aside className="min-w-0 space-y-3.5">
          {model.submitted.length > 0 && (
            <section className="glass-card side-card">
              <header className="side-head">
                <h2>我提交的需求</h2>
                <Link href="/projects?scope=submitted" prefetch={false} className="side-more">
                  查看全部
                  <ChevronRight aria-hidden="true" />
                </Link>
              </header>
              {model.submitted.slice(0, 5).map((p) =>
                projRow(
                  p,
                  canEditSubmission(me.id, p) ? (
                    <button
                      key="edit-submission"
                      type="button"
                      className="btn-tint"
                      title="需求还没被处理，可以修改；开始处理后锁定"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void openEditSubmission(p);
                      }}
                    >
                      修改
                    </button>
                  ) : undefined,
                ),
              )}
            </section>
          )}

          {/* 纯提交人不会被加进项目,这张卡恒空,不占地方 */}
          {!jobless && (
            <section className="glass-card side-card">
              <header className="side-head">
                <h2>{model.oversee ? "在途项目" : "我参与的项目"}</h2>
                <Link href="/projects" prefetch={false} className="side-more">
                  查看全部
                  <ChevronRight aria-hidden="true" />
                </Link>
              </header>
              {model.mine.length === 0 ? (
                <p className="side-empty">{model.oversee ? "当前没有在途项目。" : "你还没有参与任何项目。被加入项目后，会出现在这里。"}</p>
              ) : (
                model.mine.slice(0, 5).map((p) => projRow(p))
              )}
            </section>
          )}

          {showRisk && (
            <section className="glass-card side-card">
              <header className="side-head">
                <TriangleAlert aria-hidden="true" />
                <h2>需要关注</h2>
                <span className={cn("badge !h-[20px] font-data text-[11px]", model.risky.length > 0 ? "badge-warn" : "badge-plain")}>{model.risky.length}</span>
              </header>
              {model.risky.length === 0 ? (
                <p className="side-empty">{isPM && !model.oversee ? "你负责的项目状态都正常。" : "所有在途项目状态正常。"}</p>
              ) : (
                model.risky.slice(0, 6).map((p) => (
                  <Link key={p.id} href={`/projects/${p.id}`} prefetch={false} className="risk-row">
                    <TriangleAlert style={{ color: p.health === "off_track" ? "var(--red)" : "var(--amber)" }} aria-hidden="true" />
                    <span className="proj-name">{p.name}</span>
                    <span className={cn("risk-why", p.health !== "off_track" && "is-warn")}>{riskWhy(p) || HEALTH_LABEL[p.health]}</span>
                  </Link>
                ))
              )}
            </section>
          )}
        </aside>
      </div>

      {assignOf && <MembersDialog project={assignOf} users={users} onClose={() => setAssignOf(null)} onSaved={() => void refreshOne()} />}

      {/* 修改自己未被处理的需求(改单窗口);保存后刷新列表与角标 */}
      {editing && (
        <EditProcessModal
          process={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}
