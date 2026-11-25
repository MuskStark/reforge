import type { CtoSupport, Diagnosis, IntakeAssessment, IntakeLine, IntakeLineKey, IntakePoint, NodeRef, ProjectView, StageStatus, Verdict } from "@/lib/types";
import { INTAKE_LINES, STAGE_STATUS_LABEL } from "@/lib/labels";

/**
 * 需求承接的纯函数:诊断结果的取数、评估结论的汇总、工作台里的待办口径。
 * 不发请求、不含界面;组件与工作台共用,保证两处的算法一致。
 * 规则与服务端同一份(backend/intake.go),改一处要同步另一处。
 */

export const isIntakeLine = (key: string): key is IntakeLineKey => INTAKE_LINES.some((l) => l.key === key);

export function nodesOf(d: Diagnosis | null | undefined, line: IntakeLineKey): NodeRef[] {
  return d?.[line] ?? [];
}

export const countOf = (d: Diagnosis | null | undefined, line: IntakeLineKey): number => nodesOf(d, line).length;

/** 三类节点合计(同一节点可能计入两类) */
export const diagnosisTotal = (d: Diagnosis | null | undefined): number =>
  countOf(d, "offline") + countOf(d, "interop") + countOf(d, "mobile");

/** 流程定义被改过之后,当前工作副本的诊断与立项时不一样了 */
export const diagnosisChanged = (asIs: Diagnosis, current: Diagnosis): boolean =>
  INTAKE_LINES.some(({ key }) => countOf(asIs, key) !== countOf(current, key));

/** 一条推进线里已经定了方案的节点占比(无需处理也算有结论) */
export function planProgress(line: Pick<IntakeLine, "nodes">): number {
  if (line.nodes.length === 0) return 0;
  return Math.round((line.nodes.filter((n) => n.status !== "pending").length / line.nodes.length) * 100);
}

/** 节点的显示名:会签子步骤带上会签方 */
export function nodeLabel(n: NodeRef): string {
  return n.path ? `${n.name}（${n.path}）` : n.name;
}

/** 节点补充说明:所在系统;不互通的还有上一衔接处的系统 */
export function nodeMeta(n: NodeRef): string {
  if (n.from) return `${n.system || "—"} ← ${n.from}`;
  return n.system || "";
}

export function myAssessment(point: IntakePoint, userId: string): IntakeAssessment | undefined {
  if (!userId) return undefined;
  return point.assessments.find((a) => a.userId === userId);
}

/** 评估草稿:评审人正在编辑的结论,表决时整份带上 */
export interface VerdictDraft {
  verdict: Verdict | "";
  note: string;
}

/** 复评时,把上一轮我给过的结论抄到这一轮还没评的技术点上;返回新的草稿与沿用了几条 */
export function carryPrevious(points: IntakePoint[], drafts: Record<string, VerdictDraft>, userId: string): { drafts: Record<string, VerdictDraft>; added: number } {
  const out = { ...drafts };
  let added = 0;
  for (const p of points) {
    if (out[p.id]?.verdict) continue;
    const mine = p.prevAssessments?.find((a) => a.userId === userId);
    if (mine?.verdict) {
      out[p.id] = { verdict: mine.verdict as Verdict, note: mine.note };
      added++;
    }
  }
  return { drafts: out, added };
}

/** 从这一轮里我已经给出的结论生成草稿(可以先存一部分,下次回来接着评) */
export function draftsFrom(points: IntakePoint[], userId: string): Record<string, VerdictDraft> {
  const out: Record<string, VerdictDraft> = {};
  for (const p of points) {
    const mine = myAssessment(p, userId);
    out[p.id] = { verdict: mine?.verdict ?? "", note: mine?.note ?? "" };
  }
  return out;
}

/** 这份草稿还不能通过的原因:没结论的、附条件没写条件的、不可行没给替代方案的。
 *  与服务端通过前的校验同一份规则(backend/intake_review.go 的 assessmentProblemTx)。 */
export function draftProblems(points: IntakePoint[], drafts: Record<string, VerdictDraft>): string[] {
  const out: string[] = [];
  for (const p of points) {
    const d = drafts[p.id];
    if (!d?.verdict) out.push(`「${p.title}」还没有结论`);
    else if (d.verdict === "conditional" && !d.note.trim()) out.push(`「${p.title}」有条件可行的技术点要写明条件`);
    else if (d.verdict === "infeasible" && !d.note.trim()) out.push(`「${p.title}」不可行的技术点必须给出替代方案`);
  }
  return out;
}

/** 草稿里各类结论的数量(未下结论的计入 none) */
export function draftCounts(points: IntakePoint[], drafts: Record<string, VerdictDraft>): Record<Verdict | "none", number> {
  const out: Record<Verdict | "none", number> = { feasible: 0, conditional: 0, infeasible: 0, none: 0 };
  for (const p of points) out[drafts[p.id]?.verdict || "none"]++;
  return out;
}

/** 草稿与这一轮里已保存的结论是否一致 */
export function draftsClean(points: IntakePoint[], drafts: Record<string, VerdictDraft>, userId: string): boolean {
  return points.every((p) => {
    const d = drafts[p.id];
    const saved = myAssessment(p, userId);
    return !!d && (d.verdict || "") === (saved?.verdict ?? "") && d.note === (saved?.note ?? "");
  });
}

export function completenessText(status: string, note: string): string {
  if (status === "complete") return note.trim() ? `结构完整：${note.trim()}` : "结构完整";
  if (status === "gaps") return note.trim() ? `有缺口，待补全：${note.trim()}` : "有缺口，待补全";
  return "尚未确认";
}

/** 申请 CTO 协助现状的一句话 */
export function supportText(s: CtoSupport): string {
  switch (s.status) {
    case "requested":
      return `${s.requestedByName || "PM"} 已申请 CTO 协助，等待响应`;
    case "joined":
      return `${s.joinedByName || "CTO"} 正在协助`;
    default:
      return "未申请";
  }
}

export const isIntakeDone = (p: ProjectView): boolean => !p.intake || p.intake.phase === "done";

/** 项目当前正停在承接阶段(还没通过) */
export const inIntakeStage = (p: ProjectView): boolean =>
  p.status === "active" && !!p.intake && p.currentStage === p.intake.seq && p.intake.phase !== "done";

/** 直达项目的「承接」标签 */
export const intakeHref = (p: Pick<ProjectView, "id">): string => `/projects/${p.id}?tab=intake`;

/** 工作台里的当前用户;岗位决定在承接上的角色,与服务端 caps 同一口径 */
export interface IntakeActor {
  id: string;
  role: string;
  jobRole: string;
}

/** 需要我做的终审:PMO 岗位与管理员 */
export const needsMyFinal = (p: ProjectView, me: IntakeActor): boolean =>
  p.status === "active" && !!p.intake?.finalPending && (me.role === "admin" || me.jobRole === "viewer");

/** 需要我做的初级分析与指派:还没有 PM 的在途项目,PMO 岗位与管理员 */
export const needsMyTriage = (p: ProjectView, me: IntakeActor): boolean =>
  p.status === "active" && !p.hasPm && (me.role === "admin" || me.jobRole === "viewer");

/** 一条待决评审是不是技术可行性评估(是的话直达「承接」标签,而不是普通的评审页) */
export const isIntakeReview = (r: { projectId: string; stageSeq: number }, p: ProjectView | undefined): boolean =>
  !!p?.intake && p.intake.seq === r.stageSeq && p.intake.phase === "assess";

/** 承接阶段在等 PMO 终审:关卡已通过,但阶段状态在数据上仍是「评审中」(方案继续锁定到终审结束) */
export const awaitingFinal = (p: ProjectView) => p.status === "active" && !!p.intake?.finalPending;

/** 阶段状态的显示名:等终审的承接阶段说成「待终审」,不说「评审中」 */
export function stageStatusText(p: ProjectView, status: StageStatus): string {
  return status === "in_review" && awaitingFinal(p) ? "待终审" : STAGE_STATUS_LABEL[status];
}

/** 现在轮到我进「承接」里做什么:页头的主按钮与概览的引导共用。没有就是空串。
 *  次序按流程先后:初析指派 → PM 推进 → CTO 评估 → PMO 终审。 */
export function myIntakeAction(p: ProjectView): string {
  if (p.status !== "active" || !p.intake) return "";
  if (!p.hasPm) return p.can.assign ? (p.intake.triageDone || !p.can.triage ? "指派 PM" : "初级分析与指派") : "";
  if (!inIntakeStage(p)) return "";
  const cur = p.stages[p.currentStage - 1];
  if (cur?.status === "in_progress" && p.intake.phase === "advance" && p.can.manage) return "提交技术可行性评估";
  // 等终审时阶段仍是「评审中」,但关卡已经通过,评审人没有可表决的东西
  if (cur?.status === "in_review" && !awaitingFinal(p)) {
    const reviewer = cur.reviewerRole === "cto" ? p.can.reviewCTO : cur.reviewerRole === "handler" ? p.can.reviewHandler : p.can.manage;
    if (reviewer) return "评估技术可行性";
  }
  if (p.intake.finalPending && p.can.final) return "终审";
  return "";
}

/** 全池诊断:一组项目立项时诊断出的三类节点合计 */
export interface PoolDiagnosis {
  projects: number;
  offline: number;
  interop: number;
  mobile: number;
  /** 各类节点涉及多少条流程 */
  affected: Record<IntakeLineKey, number>;
}

export function poolDiagnosis(projects: ProjectView[]): PoolDiagnosis {
  const out: PoolDiagnosis = { projects: 0, offline: 0, interop: 0, mobile: 0, affected: { offline: 0, interop: 0, mobile: 0 } };
  for (const p of projects) {
    const s = p.intake;
    if (!s) continue;
    out.projects++;
    out.offline += s.offline;
    out.interop += s.interop;
    out.mobile += s.mobile;
    if (s.offline > 0) out.affected.offline++;
    if (s.interop > 0) out.affected.interop++;
    if (s.mobile > 0) out.affected.mobile++;
  }
  return out;
}
