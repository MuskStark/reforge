import type { PendingReview, ProjectView, WorkItem } from "@/lib/types";
import { dueInfo } from "@/lib/labels";
import { needsMyFinal, needsMyTriage } from "@/lib/intake";

/**
 * 工作台的内容:把"我要做的事"归成五类,外加右栏的项目与风险。
 * 工作台页面和外壳(侧栏「工作台」后的数字)都从这里算,保证两处的口径一致。
 *
 *   待我评审      我是当前关卡的评审人,且有等我决定的评审(含 CTO 的技术可行性评估)
 *   待我初析指派  PMO 与管理员:新流程还没有 PM,等初级分析与指派
 *   待我终审      PMO 与管理员:技术可行性评估已通过,等终审
 *   等我推进      仅 PM:我负责的项目轮到我了,或者已经逾期、阻塞
 *   我的任务      所有人:分配给我的未完成任务
 */

export interface WorkbenchModel {
  review: PendingReview[];
  assign: ProjectView[];
  final: ProjectView[];
  /** 待我核准完成:PM 发起了完成申请,等 PMO 通过/退回 */
  completeReq: ProjectView[];
  advance: ProjectView[];
  tasks: WorkItem[];
  /** 需要关注:有风险 / 逾期 / 阻塞的在途项目 */
  risky: ProjectView[];
  /** 右栏的项目:管理员与 CTO 看全部在途,其他人看自己参与(负责的排前) */
  mine: ProjectView[];
  /** 我提交的需求:按项目 created_by(收集表提交时写入)过滤,含已结束的——提交人关心整条流程走到哪了 */
  submitted: ProjectView[];
  /** 管理员 / CTO:看全局 */
  oversee: boolean;
  /** 四类合计 */
  total: number;
  /** 其中已经拖了的:等了 3 天以上的评审、逾期的任务与项目 */
  urgent: number;
}

/** 这个项目是不是"我"负责(PM)的 */
export const iAmPM = (userId: string, p: ProjectView) => p.can.isPM || p.members.some((m) => m.userId === userId && m.role === "pm");

/** 提交人的改单窗口:自己提交的需求还没被处理(承接环节停在"等待初级分析"、项目在进行中)时可以自行修改。
 * 判据只用现成字段,与服务端 followup.go 的 submitterMayEdit 同口径;窗口关闭后入口随之消失。 */
export const canEditSubmission = (userId: string, p: ProjectView) =>
  p.createdBy === userId && p.status === "active" && p.intake?.phase === "triage";

export const isRisky = (p: ProjectView) =>
  p.status === "active" && (p.health !== "on_track" || p.stats.overdue > 0 || p.stats.blocked > 0);

/** 项目当前阶段(或整项目)的目标日期是否已经过了 */
export const isStageOverdue = (p: ProjectView) => Boolean(dueInfo(p.stages[p.currentStage - 1]?.dueDate)?.overdue || dueInfo(p.dueDate)?.overdue);

/** 「逾期 N 项 · 阻塞 N 项」这样的原因说明 */
export function riskWhy(p: ProjectView): string {
  return [p.stats.overdue ? `逾期 ${p.stats.overdue} 项` : "", p.stats.blocked ? `阻塞 ${p.stats.blocked} 项` : "", !p.stats.overdue && !p.stats.blocked && isStageOverdue(p) ? "阶段已过截止日" : ""]
    .filter(Boolean)
    .join(" · ");
}

export function computeWorkbench(me: { id: string; role: string; jobRole: string }, projects: ProjectView[], reviews: PendingReview[], tasks: WorkItem[]): WorkbenchModel {
  // PMO 与管理员、CTO 一样看全局:岗位就是全局的
  const oversee = me.role === "admin" || me.jobRole === "cto" || me.jobRole === "viewer";
  const myId = me.id;
  const ofMine = (p: ProjectView) => iAmPM(myId, p) || p.members.some((m) => m.userId === myId);

  const active = projects.filter((p) => p.status === "active");

  // 初析、指派与终审都是 PMO 的职责,管理员兜底
  const isPMO = me.role === "admin" || me.jobRole === "viewer";
  const assign = isPMO ? active.filter((p) => p.can.assign && needsMyTriage(p, me)) : [];
  const final = isPMO ? active.filter((p) => needsMyFinal(p, me)) : [];
  // 完成核准:PM 申请标记完成后,到这里通过/退回
  const completeReq = active.filter((p) => p.completionStatus === "pending" && p.can.assign)
    .sort((a, b) => (a.completionRequestedAt ?? "").localeCompare(b.completionRequestedAt ?? ""));

  const advance =
    me.jobRole === "pm"
      ? active.filter((p) => iAmPM(myId, p) && (p.pendingOn === "pm" || p.stats.overdue > 0 || p.stats.blocked > 0 || isStageOverdue(p)))
      : [];

  // 每组都把最该先做的排在最前:清单默认只露前三条,排在前面的必须是最要紧的
  // 任务:逾期 → 阻塞 → 快到期 → 没有截止日 → 还早;同档按截止日
  const taskRank = (t: WorkItem) => {
    const d = dueInfo(t.dueDate);
    if (d?.overdue) return 0;
    if (t.status === "blocked") return 1;
    if (d?.soon) return 2;
    return d ? 4 : 3;
  };
  const openTasks = tasks
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .sort((a, b) => taskRank(a) - taskRank(b) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  // 评审:等得久的在前;待初析:提交得早的在前;待终审:等得久的在前;等我推进:逾期、阻塞多的在前
  const orderedReviews = [...reviews].sort((a, b) => b.waitingDays - a.waitingDays);
  const orderedAssign = [...assign].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const orderedFinal = [...final].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const orderedAdvance = [...advance].sort(
    (a, b) => (b.stats.overdue + b.stats.blocked) - (a.stats.overdue + a.stats.blocked) || a.createdAt.localeCompare(b.createdAt),
  );

  const riskyAll = active.filter(isRisky);
  const risky = oversee ? riskyAll : me.jobRole === "pm" ? riskyAll.filter((p) => iAmPM(myId, p)) : [];

  // 参与的项目:我负责的排前面,其余按最近更新排
  const mine = oversee
    ? [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : projects
        .filter((p) => p.status !== "cancelled" && ofMine(p))
        .sort((a, b) => Number(iAmPM(myId, b)) - Number(iAmPM(myId, a)) || b.updatedAt.localeCompare(a.updatedAt));

  // 我提交的需求:最近有动静的排前面
  const submitted = projects
    .filter((p) => p.createdBy === myId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const urgent =
    orderedReviews.filter((r) => r.waitingDays >= 3).length +
    openTasks.filter((t) => dueInfo(t.dueDate)?.overdue).length +
    orderedAdvance.filter((p) => p.stats.overdue > 0 || isStageOverdue(p)).length +
    orderedAssign.filter((p) => Date.now() - new Date(p.createdAt).getTime() >= 3 * 86_400_000).length;

  return {
    review: orderedReviews,
    assign: orderedAssign,
    final: orderedFinal,
    completeReq,
    advance: orderedAdvance,
    tasks: openTasks,
    risky,
    mine,
    submitted,
    oversee,
    total: orderedReviews.length + orderedAssign.length + orderedFinal.length + orderedAdvance.length + openTasks.length + completeReq.length,
    urgent,
  };
}
