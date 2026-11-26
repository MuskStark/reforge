"use client";

/**
 * 项目工作区:一条流程改造的主页面。
 *   承接:流程收集之后、改造实施之前——PMO 初级分析、指派 PM、PM 按优先级推进、CTO 技术可行性评估、PMO 终审
 *   概览:阶段进度、当前关卡的必交付物、立项信息、成员、项目状态
 *   计划:工作项看板   评审:提交 / 表决 / 历史 / 阶段调整
 *   流程:As-Is 与当前(To-Be)对比   动态:时间线与评论
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Braces, ChevronDown, ClipboardList, Download, Eye, FileSignature, FileText, GitCompareArrows, History, Pencil, Route, UserCog, Users } from "lucide-react";
import { toast } from "sonner";
import { authFetch, authFetchBlob, saveBlob, type SessionUser } from "@/lib/auth";
import type { FlowProcess, ProjectComment, ProjectView, UserDir, WorkItem } from "@/lib/types";
import { canEditSubmission } from "@/lib/workbench";
import { acceptStageOf, fmtDateTime, HEALTH_LABEL, healthClass, MODE_LABEL, OVERALL, PRIORITY_LABEL, priorityClass, STATUS_LABEL, statusClass } from "@/lib/labels";
import { OVERALL_MODE_LABEL, countersignMode } from "@/lib/step-checks";
import { AppShell, PageHead, StateLine } from "@/components/shell/app-shell";
import { MemberRow, StageRail, PendingOnBadge } from "@/components/projects/stage-rail";
import { MembersDialog, canAssignMembers } from "@/components/projects/members-dialog";
import { PlanTab } from "@/components/projects/plan-tab";
import { ReviewTab } from "@/components/projects/review-tab";
import { FlowTab } from "@/components/projects/flow-tab";
import { ActivityTab } from "@/components/projects/activity-tab";
import { IntakeTab } from "@/components/projects/intake-tab";
import { awaitingFinal, inIntakeStage, myIntakeAction, stageStatusText } from "@/lib/intake";
import { UpdateDialog } from "@/components/projects/update-dialog";
import { FlowChartModal } from "@/components/flow-chart";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type DetailTab = "intake" | "overview" | "plan" | "review" | "flow" | "activity";

/** 流程定义的两个编辑器:流程图(画布 + 检查器)与表单(与收集表同一套) */
export type FlowEditor = "chart" | "form";

const TABS: { id: DetailTab; label: string; icon: typeof History }[] = [
  { id: "intake", label: "承接", icon: Route },
  { id: "overview", label: "概览", icon: Eye },
  { id: "plan", label: "计划", icon: ClipboardList },
  { id: "review", label: "评审", icon: FileSignature },
  { id: "flow", label: "流程", icon: GitCompareArrows },
  { id: "activity", label: "动态", icon: History },
];

/** 各标签共用的上下文 */
export interface DetailCtx {
  project: ProjectView;
  me: SessionUser;
  users: UserDir[];
  process: FlowProcess | null;
  items: WorkItem[];
  comments: ProjectComment[];
  /** 重新拉取项目、流程定义、工作项与评论 */
  refresh: () => Promise<void>;
  /** 改项目基本信息,成功后更新本地状态并返回新项目 */
  patchProject: (body: Record<string, unknown>) => Promise<ProjectView | null>;
  goTab: (t: DetailTab, opts?: { item?: string }) => void;
  setMembersOpen: (v: boolean) => void;
  setUpdateOpen: (v: boolean) => void;
  setFlowChartOpen: (v: boolean) => void;
}

export function ProjectDetail({ id }: { id: string }) {
  return <AppShell active="projects">{(me) => <ProjectDetailBody id={id} me={me} />}</AppShell>;
}

function ProjectDetailBody({ id, me }: { id: string; me: SessionUser }) {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [missing, setMissing] = useState(false);
  const [users, setUsers] = useState<UserDir[]>([]);
  const [process, setProcess] = useState<FlowProcess | null>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [comments, setComments] = useState<ProjectComment[]>([]);
  /** 地址栏指定的 / 当前所在的标签。
   *  "gate" = 当前关卡(评审类通知用):承接阶段的技术可行性评估在「承接」里,其余关卡在「评审」里;
   *  null = 还没定(等读到项目后按承接是否走完决定默认落点) */
  const [tab, setTab] = useState<DetailTab | "gate" | null>(null);
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [flowChartOpen, setFlowChartOpen] = useState(false);
  /** 页头「修改流程」要打开的编辑器:等「流程」标签页挂载后由它消费 */
  const [flowEdit, setFlowEdit] = useState<FlowEditor | null>(null);
  const [statusAsk, setStatusAsk] = useState<"on_hold" | "active" | "done" | "cancelled" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // 进入时读取地址栏里的标签与要定位的工作项(可从通知、工作台直达)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t && (t === "gate" || TABS.some((x) => x.id === t))) setTab(t as DetailTab | "gate");
    const it = q.get("item");
    if (it) {
      setFocusItem(it);
      setTab("plan");
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const p = await authFetch<ProjectView>(`/api/projects/${id}`, { cache: "no-store" });
      setProject(p);
      // 地址栏没指定标签时的默认落点:承接还没走完的项目先进「承接」,其余进「概览」。
      // 只在第一次读到项目时定;之后的刷新不把人从当前标签上拽走
      setTab((cur) => cur ?? (inIntakeStage(p) ? "intake" : "overview"));
      const [proc, its, cs, us] = await Promise.all([
        authFetch<FlowProcess>(`/api/admin/processes/${p.processId}`, { cache: "no-store" }),
        authFetch<WorkItem[]>(`/api/projects/${id}/items`, { cache: "no-store" }),
        authFetch<ProjectComment[]>(`/api/projects/${id}/comments`, { cache: "no-store" }),
        authFetch<UserDir[]>("/api/users", { cache: "no-store" }),
      ]);
      setProcess(proc);
      setItems(its ?? []);
      setComments(cs ?? []);
      setUsers(us ?? []);
    } catch (e) {
      if (e instanceof Error && /不存在/.test(e.message)) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const goTab = useCallback((t: DetailTab, opts?: { item?: string }) => {
    setTab(t);
    setFocusItem(opts?.item ?? null);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    if (opts?.item) url.searchParams.set("item", opts.item);
    else url.searchParams.delete("item");
    window.history.replaceState(null, "", url);
  }, []);

  const patchProject = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const p = await authFetch<ProjectView>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        setProject(p);
        return p;
      } catch (e) {
        toast.error("保存失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
        return null;
      }
    },
    [id],
  );

  const changeStatus = async () => {
    if (!statusAsk || !project) return;
    setBusy(true);
    try {
      const p = await authFetch<ProjectView>(`/api/projects/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: statusAsk, note }),
      });
      setProject(p);
      toast.success(`项目${STATUS_LABEL[statusAsk]}`);
      setStatusAsk(null);
      setNote("");
    } catch (e) {
      toast.error("操作失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  if (!project && !missing) return <StateLine>加载中…</StateLine>;
  if (!project) {
    return (
      <>
        <PageHead title="项目不存在" size="md" back={{ href: "/projects", label: "流程项目" }} />
        <StateLine>这个项目不存在或已被删除。</StateLine>
      </>
    );
  }

  const cur = project.stages[project.currentStage - 1];
  const iCanReviewCurrent =
    project.status === "active" &&
    cur?.status === "in_review" &&
    !awaitingFinal(project) &&
    (cur.reviewerRole === "cto" ? project.can.reviewCTO : cur.reviewerRole === "handler" ? project.can.reviewHandler : project.can.manage);
  const openItems = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
  const acceptStage = acceptStageOf(project);
  // 流程定义改的是 To-Be 工作副本:项目里的 PM / BH / TH、CTO 与管理员都能改,项目结束后锁定;
  // 提交人另有改单窗口——自己提交的需求还没被处理(等初级分析)时可自行修改
  const ended = project.status === "done" || project.status === "cancelled";
  const canEditFlow = (project.can.editFlow || canEditSubmission(me.id, project)) && !ended && !!process;
  // 项目正停在承接阶段:这一段的指派、提交、评估、终审都在「承接」标签里,页头按钮直接带过去
  const atIntake = inIntakeStage(project);
  // 「承接」标签只对第一个阶段是承接阶段的项目存在;地址栏写了 tab=intake 而项目没有承接阶段时回落到概览
  const intakeOpen = !!project.intake && !project.intake.legacy;
  const activeTab: DetailTab = tab === "gate" ? (atIntake ? "intake" : "review") : tab === "intake" && !intakeOpen ? "overview" : tab ?? "overview";
  const awaitFinal = project.status === "active" && !!project.intake?.finalPending && project.can.final;
  const awaitTriage = project.status === "active" && !project.hasPm && project.can.assign && !!project.intake;
  const intakePrimary = myIntakeAction(project);

  const ctx: DetailCtx = {
    project,
    me,
    users,
    process,
    items,
    comments,
    refresh: loadAll,
    patchProject,
    goTab,
    setMembersOpen,
    setUpdateOpen,
    setFlowChartOpen,
  };

  return (
    <>
      <PageHead
        title={project.name}
        size="md"
        back={{ href: "/projects", label: "流程项目" }}
        subtitle={process?.description || undefined}
      >
        {intakePrimary ? (
          <button type="button" onClick={() => goTab("intake")} className="btn btn-primary !h-10">
            {intakePrimary.includes("指派") ? <Users className="h-4 w-4" /> : <Route className="h-4 w-4" />} {intakePrimary}
          </button>
        ) : (
          project.can.assign && project.status === "active" && !project.hasPm && (
            <button type="button" onClick={() => setMembersOpen(true)} className="btn btn-primary !h-10">
              <Users className="h-4 w-4" /> 指派 PM
            </button>
          )
        )}
        {!atIntake && project.status === "active" && cur?.status === "in_progress" && project.can.manage && cur.gate && (
          <button type="button" onClick={() => goTab("review")} className="btn btn-primary !h-10">
            <FileSignature className="h-4 w-4" /> 提交 {cur.gate}
          </button>
        )}
        {!atIntake && iCanReviewCurrent && (
          <button type="button" onClick={() => goTab("review")} className="btn btn-primary !h-10">
            <FileSignature className="h-4 w-4" /> 去{cur.gate}表决
          </button>
        )}
        {project.can.manage && project.status === "active" && project.hasPm && (
          <button type="button" onClick={() => setUpdateOpen(true)} className="btn btn-glass !h-10">
            写简报
          </button>
        )}
        {canAssignMembers(project.can) && project.status !== "done" && project.status !== "cancelled" && (
          <button type="button" onClick={() => setMembersOpen(true)} className="btn btn-glass !h-10">
            <UserCog className="h-4 w-4" /> 成员
          </button>
        )}
        {canEditFlow && (
          <button
            type="button"
            onClick={() => {
              setFlowEdit("chart");
              goTab("flow");
            }}
            className="btn btn-glass !h-10"
            title="修改当前流程定义（To-Be 工作副本）"
          >
            <Pencil className="h-4 w-4" /> 修改流程
          </button>
        )}
        <button type="button" onClick={() => setFlowChartOpen(true)} className="btn btn-glass !h-10">
          流程图
        </button>
        <ExportMenu id={project.id} name={project.name} />
      </PageHead>

      {/* 元信息 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={cn(statusClass(project.status), "!h-[24px]")}>{STATUS_LABEL[project.status]}</span>
        {project.status === "active" && cur && (
          <span className="badge badge-blue !h-[24px]">
            阶段 {cur.seq} · {cur.name} · {stageStatusText(project, cur.status)}
          </span>
        )}
        {project.status === "active" && <PendingOnBadge on={project.pendingOn} />}
        {project.status === "active" && <span className={cn(healthClass(project.health), "!h-[24px]")}>健康度 · {HEALTH_LABEL[project.health]}</span>}
        <span className={cn(priorityClass(project.priority), "!h-[24px]")}>优先级 {PRIORITY_LABEL[project.priority]}</span>
        {project.stats.overdue > 0 && <span className="badge badge-warn !h-[24px] font-data">{project.stats.overdue} 项逾期</span>}
        {project.dueDate && <span className="font-data text-xs text-[color:var(--ink-2)]">目标 {project.dueDate}</span>}
      </div>

      {/* 标签栏 */}
      <div className="seg mb-4 max-w-[620px] overflow-x-auto">
        {TABS.filter(({ id: t }) => t !== "intake" || intakeOpen).map(({ id: t, label, icon: Icon }) => (
          <button key={t} type="button" onClick={() => goTab(t)} className={cn("gap-1.5", activeTab === t && "on")} aria-current={activeTab === t ? "page" : undefined}>
            <Icon className="h-3.5 w-3.5" />
            {label}
            {t === "plan" && openItems > 0 && <span className="font-data text-[11px] font-normal text-[color:var(--ink-3)]">{openItems}</span>}
            {/* 停在承接阶段时,待我表决的提示挂在「承接」上;此外 PMO 的初析指派与终审也在这里提示 */}
            {t === "intake" && (awaitTriage || awaitFinal) && !iCanReviewCurrent && <span className="size-1.5 rounded-full bg-[color:var(--amber)]" aria-label="等我处理" />}
            {t === (atIntake ? "intake" : "review") && cur?.status === "in_review" && iCanReviewCurrent && (
              <span className="size-1.5 rounded-full bg-[color:var(--red)]" aria-label="待我表决" />
            )}
          </button>
        ))}
      </div>

      {activeTab === "intake" && <IntakeTab ctx={ctx} />}
      {activeTab === "overview" && <OverviewTab ctx={ctx} onStatus={setStatusAsk} />}
      {activeTab === "plan" && <PlanTab ctx={ctx} focusItem={focusItem} clearFocus={() => setFocusItem(null)} />}
      {activeTab === "review" && <ReviewTab ctx={ctx} />}
      {activeTab === "flow" && <FlowTab ctx={ctx} autoEdit={flowEdit} onAutoEditDone={() => setFlowEdit(null)} />}
      {activeTab === "activity" && <ActivityTab ctx={ctx} />}

      {membersOpen && (
        <MembersDialog project={project} users={users} onClose={() => setMembersOpen(false)} onSaved={loadAll} />
      )}
      {updateOpen && <UpdateDialog ctx={ctx} onClose={() => setUpdateOpen(false)} />}
      {flowChartOpen && process && (
        <FlowChartModal onClose={() => setFlowChartOpen(false)} source={{ name: project.name, steps: process.steps }} />
      )}

      {statusAsk && (
        <Dialog onClose={() => setStatusAsk(null)} labelledBy="status-title">
          <DialogHeader
            id="status-title"
            title={{ on_hold: "搁置项目", active: "恢复推进", done: "标记项目完成", cancelled: "取消项目" }[statusAsk]}
            subtitle={
              statusAsk === "on_hold"
                ? "搁置后流程暂停推进，成员会收到通知；可随时恢复。"
                : statusAsk === "done"
                  ? project.can.assign
                    ? `核准项目完成：${acceptStage?.name ?? "验收阶段"}已通过、复盘结束。完成后成员会收到通知。`
                    : `提交完成申请：由 PMO 核准后项目才会标记完成，成员会收到核准结果的通知。`
                  : "取消后项目不再推进，仍在等待的评审一并作废。"
            }
            onClose={() => setStatusAsk(null)}
          />
          {statusAsk !== "active" && (
            <div className="mt-4">
              <Field label="说明" hint={statusAsk === "cancelled" ? "必填" : "选填"} required={statusAsk === "cancelled"}>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={statusAsk === "cancelled" ? "请说明取消原因" : "补充说明"} />
              </Field>
            </div>
          )}
          <DialogActions>
            <button type="button" onClick={() => setStatusAsk(null)} className="btn btn-glass">
              取消
            </button>
            <button
              type="button"
              disabled={busy || (statusAsk === "cancelled" && !note.trim())}
              onClick={() => void changeStatus()}
              className={cn("btn", statusAsk === "done" || statusAsk === "active" ? "btn-primary" : "btn-glass")}
            >
              {{ on_hold: "搁置", active: "恢复", done: project.can.assign ? "标记完成" : "提交申请", cancelled: "确认取消" }[statusAsk]}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}

/** 导出:Markdown 报告(给人看)或 JSON(完整数据) */
function ExportMenu({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (json: boolean) => {
    setOpen(false);
    try {
      const { blob, filename } = await authFetchBlob(`/api/projects/${id}/export${json ? "?format=json" : ""}`, {}, `${name}.${json ? "json" : "md"}`);
      saveBlob(blob, filename);
      toast.success("已导出", { description: filename });
    } catch (e) {
      if (!(e instanceof Error && e.message === "UNAUTHORIZED")) toast.error("导出失败", { description: e instanceof Error ? e.message : "请重试" });
    }
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" className="btn btn-glass !h-10">
        <Download className="h-4 w-4" /> 导出
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div
          role="menu"
          className="glass-card absolute right-0 top-[calc(100%+6px)] z-30 w-[240px] !rounded-[18px] p-1.5"
        >
          <button type="button" role="menuitem" onClick={() => void run(false)} className="flex w-full items-start gap-2.5 rounded-[13px] px-3 py-2.5 text-left transition hover:bg-white/70">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--tint)]" />
            <span>
              <span className="block text-[14px] font-semibold text-neutral-900">Markdown 报告</span>
              <span className="block text-xs text-[color:var(--ink-2)]">基本信息、需求承接、阶段与评审、工作项、简报、指标、时间线</span>
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => void run(true)} className="flex w-full items-start gap-2.5 rounded-[13px] px-3 py-2.5 text-left transition hover:bg-white/70">
            <Braces className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--indigo-deep)]" />
            <span>
              <span className="block text-[14px] font-semibold text-neutral-900">JSON 数据</span>
              <span className="block text-xs text-[color:var(--ink-2)]">同一份内容的结构化形式，便于二次处理</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- 概览 ---------------- */

function OverviewTab({ ctx, onStatus }: { ctx: DetailCtx; onStatus: (s: "on_hold" | "active" | "done" | "cancelled") => void }) {
  const { project, items, comments, users, process, patchProject, refresh } = ctx;
  const cur = project.stages[project.currentStage - 1];
  const required = items.filter((i) => i.required && i.stageSeq === cur.seq);
  const doneRequired = required.filter((i) => i.status === "done").length;
  const missingRequired = required.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const latestUpdate = comments.find((c) => c.kind === "update");
  const canEdit = project.can.manage && project.status === "active";
  const conclusion = String(project.analysis?.conclusion ?? "");
  const pms = project.members.filter((m) => m.role === "pm");
  const handlers = project.members.filter((m) => m.role === "handler");
  const devs = project.members.filter((m) => m.role === "dev");
  const viewers = project.members.filter((m) => m.role === "viewer");
  const ctos = users.filter((u) => u.jobRole === "cto");
  const acceptStage = acceptStageOf(project);
  const acceptPassed = acceptStage?.status === "approved" || acceptStage?.status === "skipped";

  // 完成核准:PMO 通过/退回 PM 发起的完成申请(服务端逐请求校验,这里只是入口)
  const [completionBusy, setCompletionBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const decideCompletion = async (decision: "approve" | "reject", note: string) => {
    setCompletionBusy(true);
    try {
      const p = await authFetch<ProjectView>(`/api/projects/${project.id}/completion`, {
        method: "POST",
        body: JSON.stringify({ decision, note }),
      });
      void refresh();
      setRejectOpen(false);
      setRejectNote("");
      toast.success(decision === "approve" ? "已核准完成" : "已退回申请", {
        description: decision === "approve" ? `「${project.name}」已标记为完成` : "项目继续推进，发起人已收到通知",
      });
    } catch (e) {
      if (!(e instanceof Error && e.message === "UNAUTHORIZED")) toast.error("操作失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setCompletionBusy(false);
    }
  };

  const stageBody = useMemo(() => {
    if (!cur) return null;
    if (project.status !== "active") return null;
    if (cur.status === "in_review") {
      return (
        <>
          <p className="text-[13px] leading-relaxed text-[color:var(--ink-2)]">
            「{cur.gate}」评审中（{MODE_LABEL[cur.mode]} · 第 {project.review?.round ?? 1} 轮）。
            {project.review?.reviewers?.length
              ? ` 已表决 ${project.review.reviewers.filter((r) => r.decision !== "pending").length}/${project.review.reviewers.length}。`
              : ""}
          </p>
        </>
      );
    }
    if (cur.status === "in_progress") {
      if (!project.hasPm) {
        return <p className="text-[13px] leading-relaxed text-[color:var(--amber-deep)]">尚未指派 PM。指派后项目正式启动，进入「{cur.name}」。</p>;
      }
      if (!cur.gate) {
        return <p className="text-[13px] leading-relaxed text-[color:var(--ink-2)]">流程已上线。持续跟踪运营指标，积累的优化项可以再次立项。</p>;
      }
      return (
        <p className="text-[13px] leading-relaxed text-[color:var(--ink-2)]">
          完成下列必交付物后，由 PM 提交「{cur.gate}」（{cur.reviewerRole === "cto" ? "CTO" : "BH"}
          {MODE_LABEL[cur.mode]}）。
        </p>
      );
    }
    return null;
  }, [cur, project]);

  // 停在承接阶段时,「当前阶段」卡片解释这一段怎么走,并把人带到「承接」标签
  const atIntake = inIntakeStage(project);
  const intakePhase = project.intake?.phase ?? "done";
  const intakeBody: Record<string, string> = {
    triage: `流程已收集。自动诊断出线下节点 ${project.intake?.offline ?? 0} 个、系统不互通 ${project.intake?.interop ?? 0} 个、无法移动端 ${project.intake?.mobile ?? 0} 个，等 PMO 完成初级分析并指派 PM。`,
    assign: "PMO 已完成初级分析，等待指派一名或多名 PM 承接。",
    advance: "PM 正按优先级推进：① 线下节点转线上 → ② 系统不互通 → ③ 线上节点移动化。原因与解决方案齐备后，提交 CTO 做技术可行性评估。",
    assess: `CTO 正在评估技术可行性（${cur?.gate ?? ""}，第 ${project.review?.round ?? 1} 轮）。通过后整体流程与方案交 PMO 终审。`,
    final: "技术可行性评估已通过，等 PMO 终审；终审通过后进入下一阶段。",
    done: "",
  };
  const intakeAction = myIntakeAction(project);

  const inlineSelect = "field !h-8 !px-2.5 !text-[13px] w-auto min-w-[64px]";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {/* 阶段进度 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">阶段进度</h2>
          {/* w-0 + min-w-full:可横滑的宽内容不再把自身宽度报给祖先,窄屏下卡片不会被撑宽 */}
          <div className="w-0 min-w-full overflow-x-auto pb-1 pt-3">
            <StageRail stages={project.stages} current={project.currentStage} finalSeq={awaitingFinal(project) ? project.currentStage : undefined} />
          </div>

          {cur && (
            <div className="mt-4 rounded-2xl bg-white/55 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold text-neutral-900">
                  当前：阶段 {cur.seq} · {cur.name}
                </h3>
                {/* 项目已结束(完成 / 取消 / 搁置)时显示项目状态,而不是阶段自己的"进行中" */}
                <span className={cn(project.status === "active" ? "badge badge-plain" : statusClass(project.status), "!h-[20px] text-[11px]")}>
                  {project.status === "active" ? stageStatusText(project, cur.status) : STATUS_LABEL[project.status]}
                </span>
                {cur.gate && <span className="badge badge-indigo !h-[20px] text-[11px]">{cur.gate}</span>}
                {cur.enteredAt && <span className="font-data text-[11px] text-[color:var(--ink-3)]">始于 {fmtDateTime(cur.enteredAt)}</span>}
                {!atIntake && (
                  <span className="badge badge-blue ml-auto !h-[20px] font-data text-[11px]">
                    必交付 {doneRequired}/{required.length}
                  </span>
                )}
              </div>
              {atIntake ? (
                <>
                  {/* 承接阶段的准入条件是承接方案;模板里的必交付物在提交评估时自动记为完成,不在这里列 */}
                  <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink-2)]">{intakeBody[intakePhase]}</p>
                  <div className="mt-3">
                    <button type="button" onClick={() => ctx.goTab("intake")} className={cn("btn !h-10", intakeAction ? "btn-primary" : "btn-glass")}>
                      <Route className="h-4 w-4" aria-hidden="true" /> {intakeAction || "查看承接"}
                    </button>
                  </div>
                </>
              ) : (
                stageBody
              )}

              {!atIntake && required.length > 0 && (
                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {required.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-[13px]">
                      <span
                        className={cn(
                          "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                          r.status === "done" ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]" : "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-3)]",
                        )}
                      >
                        {r.status === "done" ? "✓" : ""}
                      </span>
                      <span className={cn("min-w-0 flex-1 truncate", r.status === "done" ? "text-[color:var(--ink-2)] line-through" : "text-neutral-900")}>{r.title}</span>
                      <Link
                        href={`/projects/${project.id}?tab=plan&item=${r.id}`}
                        prefetch={false}
                        onClick={(e) => {
                          e.preventDefault();
                          ctx.goTab("plan", { item: r.id });
                        }}
                        className="text-xs font-medium text-[color:var(--tint)] hover:underline"
                      >
                        打开
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {!atIntake && project.status === "active" && cur.gate && (
                <div className="mt-3.5 flex flex-wrap gap-2.5">
                  {cur.status === "in_progress" && project.can.manage && (
                    <button type="button" onClick={() => ctx.goTab("review")} className="btn btn-primary !h-10" disabled={missingRequired.length > 0}>
                      <FileSignature className="h-4 w-4" /> 提交 {cur.gate}
                    </button>
                  )}
                  {cur.status === "in_review" && (
                    <button type="button" onClick={() => ctx.goTab("review")} className="btn btn-glass !h-10">
                      查看评审
                    </button>
                  )}
                  {project.can.manage && (
                    <button type="button" onClick={() => ctx.setUpdateOpen(true)} className="btn btn-glass !h-10">
                      写简报
                    </button>
                  )}
                </div>
              )}
              {!atIntake && cur.status === "in_progress" && !project.can.manage && cur.gate && project.hasPm && (
                <p className="mt-3 text-xs text-[color:var(--ink-3)]">等待 PM 完成必交付物并提交评审。</p>
              )}
            </div>
          )}
        </section>

        {/* 流程概要 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
            流程概要
            <Link
              href={`/projects/${project.id}?tab=flow`}
              prefetch={false}
              onClick={(e) => {
                e.preventDefault();
                ctx.goTab("flow");
              }}
              className="ml-auto text-xs font-medium text-[color:var(--tint)] hover:underline"
            >
              As-Is / To-Be 对比 →
            </Link>
          </h2>
          {process ? (
            <ul className="mt-3 grid gap-1">
              {process.steps.map((s, i) => (
                <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-white/50 px-3.5 py-2.5 text-[14px] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                  <span
                    className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center text-[11px] font-bold",
                      s.countersign ? "rotate-45 rounded-[7px] bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]" : "rounded-full bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
                    )}
                  >
                    <span className={s.countersign ? "-rotate-45" : undefined}>{i + 1}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-neutral-900">{s.name}</span>
                  <span className="shrink-0 text-xs text-[color:var(--ink-2)]">
                    {s.countersign
                      ? `${s.parties.length} 方并行 · ${OVERALL_MODE_LABEL[countersignMode(s)]}`
                      : s.mode === "online"
                        ? `线上 · ${s.online.systemName}`
                        : `线下 · ${s.offline.handlers.map((h) => h.department).filter(Boolean).join("、") || "经办待填"}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">读取流程定义中…</p>
          )}
        </section>
      </div>

      <aside className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {/* 立项信息 */}
        <section className="glass-card p-5">
          <h2 className="text-[15px] font-semibold text-neutral-900">立项信息</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <dt className="text-[color:var(--ink-2)]">申报人</dt>
            <dd className="font-medium text-neutral-900">{project.applicant || "—"}</dd>

            <dt className="text-[color:var(--ink-2)]">改造价值</dt>
            <dd>
              {canEdit ? (
                <select
                  aria-label="改造价值"
                  value={project.value}
                  onChange={(e) => void patchProject({ value: e.target.value })}
                  className={inlineSelect}
                >
                  <option value="">待评估</option>
                  {OVERALL.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-medium text-neutral-900">{project.value || "待评估"}</span>
              )}
            </dd>

            <dt className="text-[color:var(--ink-2)]">复杂度</dt>
            <dd>
              {canEdit ? (
                <select
                  aria-label="复杂度"
                  value={project.complexity}
                  onChange={(e) => void patchProject({ complexity: e.target.value })}
                  className={inlineSelect}
                >
                  <option value="">待评估</option>
                  {OVERALL.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-medium text-neutral-900">{project.complexity || "待评估"}</span>
              )}
            </dd>

            <dt className="text-[color:var(--ink-2)]">优先级</dt>
            <dd>
              {canEdit ? (
                <select
                  aria-label="优先级"
                  value={project.priority}
                  onChange={(e) => void patchProject({ priority: e.target.value })}
                  className={inlineSelect}
                >
                  {(["high", "medium", "low"] as const).map((v) => (
                    <option key={v} value={v}>
                      {PRIORITY_LABEL[v]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={cn(priorityClass(project.priority), "!h-[20px]")}>{PRIORITY_LABEL[project.priority]}</span>
              )}
            </dd>

            <dt className="text-[color:var(--ink-2)]">目标完成</dt>
            <dd>
              {canEdit ? (
                <input
                  type="date"
                  aria-label="目标完成日"
                  value={project.dueDate}
                  onChange={(e) => void patchProject({ dueDate: e.target.value })}
                  className={inlineSelect}
                />
              ) : (
                <span className="font-data font-medium text-neutral-900">{project.dueDate || "未设定"}</span>
              )}
            </dd>
          </dl>

          <div className="mt-4 border-t border-[color:var(--sep)] pt-3">
            <span className="text-[13px] text-[color:var(--ink-2)]">分析结论</span>
            {canEdit ? (
              <Textarea
                aria-label="分析结论"
                className="mt-1.5 min-h-[70px] !text-[13px]"
                defaultValue={conclusion}
                key={project.id + conclusion.length}
                placeholder="现状、痛点、改造方向与预期收益"
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== conclusion) void patchProject({ analysis: { ...(project.analysis ?? {}), conclusion: v } });
                }}
              />
            ) : (
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-900">{conclusion || "尚未填写分析结论"}</p>
            )}
          </div>

          {latestUpdate && (
            <div className="mt-4 rounded-2xl bg-[linear-gradient(180deg,rgba(240,240,255,0.45),rgba(255,255,255,0.4))] p-3 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.22)]">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-[color:var(--indigo-deep)]">最新简报</span>
                <span className="text-[color:var(--ink-3)]">
                  {latestUpdate.authorDisplayName} · {fmtDateTime(latestUpdate.createdAt)}
                </span>
              </div>
              <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-neutral-900">{latestUpdate.structured?.progress || latestUpdate.body}</p>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-1.5">
            {[
              ["步骤", project.metrics.steps],
              ["线下占比", `${Math.round(project.metrics.offlineShare * 100)}%`],
              ["断点", project.metrics.breakpoints],
              ["系统", project.metrics.systems],
            ].map(([k, v]) => (
              <span key={String(k)} className="lg-chip px-2.5 py-1 text-[11px] text-[color:var(--ink-2)]">
                {k} <b className="font-data text-[13px] text-neutral-900">{v}</b>
              </span>
            ))}
          </div>
        </section>

        {/* 成员 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
            成员
            {canAssignMembers(project.can) && project.status !== "done" && project.status !== "cancelled" && (
              <button type="button" onClick={() => ctx.setMembersOpen(true)} className="ml-auto text-xs font-medium text-[color:var(--tint)] hover:underline">
                管理
              </button>
            )}
          </h2>
          <ul className="mt-3 space-y-2.5 text-[13px]">
            <MemberRow label="PM" full="项目经理" people={pms} leadId={project.leadPmId} hint={pms.length ? "" : project.intake && !project.intake.triageDone ? "待 PMO 初级分析后指派" : "未指派"} warn />
            <MemberRow label="BH" full="业务经办" people={handlers} hint={handlers.length ? "" : "尚未添加"} />
            {devs.length > 0 && <MemberRow label="TH" full="科技经办" people={devs} />}
            {viewers.length > 0 && <MemberRow label="PMO" full="项目管理办公室" people={viewers} />}
            <MemberRow label="CTO" full="首席技术官" people={ctos.map((u) => ({ userId: u.id, username: u.username, displayName: u.displayName, role: "pm" as const }))} hint={ctos.length ? "" : "未设置"} />
          </ul>
        </section>

        {/* 项目状态 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
            项目状态
            <span className={cn(statusClass(project.status), "ml-auto !h-[20px] text-[11px]")}>{STATUS_LABEL[project.status]}</span>
          </h2>
          {project.status === "done" || project.status === "cancelled" ? (
            <p className="mt-3 text-[13px] leading-relaxed text-[color:var(--ink-2)]">
              项目已于 {fmtDateTime(project.completedAt ?? project.updatedAt)} {STATUS_LABEL[project.status]}。
              {project.status === "done" && "可在「流程」里查看 As-Is 与已发布版本的对比。"}
            </p>
          ) : (
            <>
              {/* 完成核准:申请后到 PMO 处形成待办;PMO 在这里通过/退回,申请人在这里看进度 */}
              {project.completionStatus === "pending" && (
                <div className="mt-3 rounded-2xl bg-[color:var(--amber-soft)] p-3.5 shadow-[inset_0_0_0_0.5px_rgba(245,158,11,0.25)]">
                  <p className="text-[13px] font-semibold text-[color:var(--amber-deep)]">
                    完成申请待 PMO 核准
                    {project.completionRequestedAt && <span className="ml-1.5 font-normal text-[color:var(--ink-2)]">{fmtDateTime(project.completionRequestedAt)}{project.completionRequestedByName ? ` · ${project.completionRequestedByName}` : ""}</span>}
                  </p>
                  {project.completionNote && <p className="mt-1 text-xs leading-relaxed text-[color:var(--ink-2)]">申请说明：{project.completionNote}</p>}
                  {project.can.assign && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <button type="button" disabled={completionBusy} onClick={() => void decideCompletion("approve", "")} className="btn btn-primary !h-8 !px-3 text-[12px]">
                        核准完成
                      </button>
                      <button type="button" disabled={completionBusy} onClick={() => setRejectOpen(true)} className="btn btn-glass !h-8 !px-3 text-[12px]">
                        退回
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {project.status === "active" && project.can.manage && (
                  <button type="button" onClick={() => onStatus("on_hold")} className="btn btn-glass !h-9 !px-3.5 text-[13px]">
                    搁置
                  </button>
                )}
                {project.status === "on_hold" && project.can.manage && (
                  <button type="button" onClick={() => onStatus("active")} className="btn btn-primary !h-9 !px-3.5 text-[13px]">
                    恢复推进
                  </button>
                )}
                {project.status === "active" && project.completionStatus !== "pending" && project.can.assign && (acceptPassed || project.can.isAdmin) && (
                  <button type="button" onClick={() => onStatus("done")} className="btn btn-glass !h-9 !px-3.5 text-[13px]" title="PMO 直接标记完成">
                    标记完成
                  </button>
                )}
                {project.status === "active" && project.completionStatus !== "pending" && project.can.manage && !project.can.assign && acceptPassed && (
                  <button type="button" onClick={() => onStatus("done")} className="btn btn-glass !h-9 !px-3.5 text-[13px]" title="提交完成申请，由 PMO 核准">
                    申请完成
                  </button>
                )}
                {project.can.skip && (
                  <button type="button" onClick={() => onStatus("cancelled")} className="btn btn-glass !h-9 !px-3.5 text-[13px] text-[color:var(--red-deep)]">
                    取消项目
                  </button>
                )}
              </div>
            </>
          )}
          <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">创建于 {fmtDateTime(project.createdAt)} · 申报人提交后自动立项</p>
        </section>
      </aside>

      {/* 退回完成申请:附上原因,发起人与成员都会收到通知 */}
      {rejectOpen && (
        <Dialog onClose={() => setRejectOpen(false)} labelledBy="reject-title">
          <DialogHeader id="reject-title" title="退回完成申请" subtitle="退回后项目继续推进，发起人与成员会收到通知。" onClose={() => setRejectOpen(false)} />
          <div className="mt-4">
            <Field label="退回原因" hint="选填">
              <Textarea value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="例如：运营指标还差一个周期的数据，下月初再报" />
            </Field>
          </div>
          <DialogActions>
            <button type="button" onClick={() => setRejectOpen(false)} className="btn btn-glass">
              取消
            </button>
            <button type="button" disabled={completionBusy} onClick={() => void decideCompletion("reject", rejectNote.trim())} className="btn btn-primary">
              确认退回
            </button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
