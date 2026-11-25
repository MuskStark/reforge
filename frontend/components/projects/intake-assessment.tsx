"use client";

/**
 * CTO 的技术可行性评估(「技术可行性评估」环节):对每个技术点给出结论——可行 / 有条件可行(写明条件)/
 * 不可行(必须给出替代方案);每个技术点都有了结论才能通过。结论可以先存草稿,最后表决。
 * 没有评估资格的人看到的是只读的进展:谁已经给了哪些结论。
 */

import { useState } from "react";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { authFetch, type SessionUser } from "@/lib/auth";
import type { IntakeView, ProjectView, Verdict } from "@/lib/types";
import { MODE_LABEL, VERDICT_LABEL, VERDICT_NOTE_HINT } from "@/lib/labels";
import { carryPrevious, draftCounts, draftProblems, draftsClean, draftsFrom, type VerdictDraft } from "@/lib/intake";
import { useAction } from "@/components/projects/intake-action";
import { LinesReadonly } from "@/components/projects/intake-bits";
import { AssessmentLines, PointList } from "@/components/projects/intake-solution";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const VERDICTS: Verdict[] = ["feasible", "conditional", "infeasible"];
const COUNT_LABEL: Record<Verdict | "none", string> = { feasible: "可行", conditional: "有条件可行", infeasible: "不可行", none: "未评" };

type Decision = "approve" | "reject";

/**
 * 一轮评估的面板。调用方用 key={v.reviewId} 挂载:换了一轮就重新起步,草稿从那一轮里
 * 我已经保存的结论开始。
 */
export function IntakeAssessment({ v, project, me, onSaved }: { v: IntakeView; project: ProjectView; me: SessionUser; onSaved: () => Promise<void> }) {
  const reviewId = v.reviewId;
  const pending = v.reviewStatus === "pending";
  const canAssess = v.can.assess && pending;
  const [drafts, setDrafts] = useState<Record<string, VerdictDraft>>(() => draftsFrom(v.points, me.id));
  const [ask, setAsk] = useState<Decision | null>(null);
  const { busy, run } = useAction(onSaved);

  const reviewerName = v.reviewerRole === "cto" ? "CTO" : "BH";
  const problems = draftProblems(v.points, drafts);
  const counts = draftCounts(v.points, drafts);
  const clean = draftsClean(v.points, drafts, me.id);

  const set = (id: string, patch: Partial<VerdictDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { verdict: d[id]?.verdict ?? "", note: d[id]?.note ?? "", ...patch } }));

  /** 已经选了结论的技术点,连同说明 */
  const payload = () =>
    v.points.flatMap((p) => {
      const d = drafts[p.id];
      return d?.verdict ? [{ pointId: p.id, verdict: d.verdict, note: d.note.trim() }] : [];
    });

  /** 复评时沿用上一轮的结论:只补这一轮还没评的技术点,已经改过的不动 */
  const carry = () => {
    const next = carryPrevious(v.points, drafts, me.id);
    setDrafts(next.drafts);
    toast.success(`已沿用上一轮的 ${next.added} 条结论`, { description: "请重点看方案变过的技术点，确认后再表决" });
  };
  const canCarry = v.points.some((p) => !drafts[p.id]?.verdict && !!p.prevAssessments?.some((a) => a.userId === me.id && a.verdict));

  const save = () => run("保存失败", () => authFetch(`/api/reviews/${reviewId}/assessment`, { method: "PUT", body: JSON.stringify({ points: payload() }) }), "结论已保存，可以稍后再表决");

  const decide = async (decision: Decision, comment: string) => {
    let status = "";
    const ok = await run("表决失败", async () => {
      status = (
        await authFetch<{ status: string }>(`/api/reviews/${reviewId}/decide`, {
          method: "POST",
          body: JSON.stringify({ decision, comment, ...(decision === "approve" ? { points: payload() } : {}) }),
        })
      ).status;
    });
    if (!ok) return;
    toast.success(decision === "approve" ? "已通过技术可行性评估" : "已退回修改", {
      description:
        status === "approved" ? "已通知 PMO 终审；终审通过后才进入下一阶段" : status === "rejected" ? "已退回 PM 修改，PM 调整后重新提交" : "已记录你的表决，等待其他评审人",
    });
    setAsk(null);
  };

  const withdraw = () => run("撤回失败", () => authFetch(`/api/reviews/${reviewId}/withdraw`, { method: "POST" }), "已撤回评估，回到 PM 推进，可修改后重新提交");

  const reviewers = project.review?.reviewers ?? [];
  const voted = reviewers.filter((r) => r.decision !== "pending").length;

  return (
    <div className="grid gap-4">
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          {v.gate || "技术可行性评估"}
          {v.round > 0 && <span className="badge badge-indigo !h-[20px] text-[11px]">第 {v.round} 轮</span>}
          <span className="badge badge-plain !h-[20px] text-[11px]">
            {reviewerName}
            {MODE_LABEL[v.mode]}
          </span>
          {canAssess && <span className="badge badge-blue ml-auto !h-[20px] font-data text-[11px]">我已评 {v.points.length - counts.none}/{v.points.length}</span>}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
          只看技术可行性：每个技术点给出可行、有条件可行或不可行。附条件的要写明条件；不可行的必须给出替代方案。业务取舍由 PM 负责，最终由 PMO 终审。
        </p>
        {project.review?.summary && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-900">{project.review.summary}</p>}

        {/* 每个技术点:别人的结论(只读) + 我的结论 */}
        <PointList
          points={v.points}
          renderExtra={(p) => {
            const d = drafts[p.id] ?? { verdict: "", note: "" };
            const others = p.assessments.filter((a) => a.userId !== me.id);
            return (
              <div className="mt-2">
                <AssessmentLines assessments={others} />
                {canAssess ? (
                  <div className="rounded-2xl bg-white/60 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-neutral-900">你的结论</span>
                      <div className="seg seg-mini" role="group" aria-label={`「${p.title}」的结论`}>
                        {VERDICTS.map((val) => (
                          <button key={val} type="button" disabled={busy} className={cn(d.verdict === val && "on")} onClick={() => set(p.id, { verdict: val })}>
                            {VERDICT_LABEL[val]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <Textarea
                      aria-label={`「${p.title}」的说明`}
                      value={d.note}
                      disabled={!d.verdict || busy}
                      onChange={(e) => set(p.id, { note: e.target.value })}
                      placeholder={d.verdict ? VERDICT_NOTE_HINT[d.verdict] : "选定结论后填写说明"}
                      className={cn("mt-2 min-h-[48px] !text-[13px]", d.verdict !== "feasible" && !!d.verdict && !d.note.trim() && "!shadow-[inset_0_0_0_1.5px_var(--amber)]")}
                    />
                  </div>
                ) : (
                  p.assessments.length === 0 && <p className="text-[11px] text-[color:var(--ink-3)]">还没有结论</p>
                )}
              </div>
            );
          }}
        />
      </section>

      {/* 我的表决:结论汇总、还不能通过的原因、保存与表决 */}
      {canAssess && (
        <section className="rounded-[22px] bg-[linear-gradient(180deg,rgba(240,240,255,0.5),rgba(255,255,255,0.45))] p-4 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.25)]">
          <h3 className="text-[16px] font-bold text-[color:var(--indigo-deep)]">评估结论</h3>
          <div className="mt-2.5 grid grid-cols-4 gap-2">
            {(["feasible", "conditional", "infeasible", "none"] as const).map((k) => (
              <div key={k} className="rounded-2xl bg-white/60 px-2 py-2 text-center">
                <b className="font-data block text-[20px] leading-none tabular-nums text-neutral-900">{counts[k]}</b>
                <span className="mt-1 block text-[11px] text-[color:var(--ink-2)]">{COUNT_LABEL[k]}</span>
              </div>
            ))}
          </div>
          {problems.length > 0 ? (
            <ul className="mt-2.5 grid gap-1">
              {problems.map((s) => (
                <li key={s} className="text-xs leading-relaxed text-[color:var(--amber-deep)]">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
              {counts.feasible === v.points.length ? "每个技术点都可行。" : "存在附条件或不可行(已给替代方案)的技术点，通过后总体为「有条件通过」，条件与替代方案会一并带给 PMO。"}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2.5">
            <button type="button" disabled={busy || clean} onClick={() => void save()} className="btn btn-glass !h-10 disabled:opacity-50">
              保存结论
            </button>
            {canCarry && (
              <button type="button" disabled={busy} onClick={carry} className="btn btn-glass !h-10 disabled:opacity-50" title="把上一轮我给过的结论抄到还没评的技术点上">
                沿用上一轮结论
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setAsk("reject")} className="btn btn-glass !h-10 text-[color:var(--red-deep)] disabled:opacity-50">
              退回修改
            </button>
            <button type="button" disabled={busy || problems.length > 0} onClick={() => setAsk("approve")} className="btn btn-primary ml-auto !h-10 disabled:opacity-50">
              通过 · 转 PMO 终审
            </button>
          </div>
        </section>
      )}

      {/* 评审人与表决进展 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          评审人
          {pending && <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">已表决 {voted}/{reviewers.length}</span>}
        </h2>
        <ul className="mt-3 grid gap-2">
          {reviewers.map((r) => (
            <li key={r.userId} className="flex items-center gap-2.5 rounded-xl bg-white/60 px-3 py-2 text-[13px]">
              <span className="font-semibold text-neutral-900">{r.displayName || r.username || "系统管理员"}</span>
              <span className={cn("badge ml-auto !h-[20px] text-[11px]", r.decision === "approve" && "badge-ok", r.decision === "reject" && "badge-warn", r.decision === "pending" && "badge-plain")}>
                {r.decision === "approve" ? "通过" : r.decision === "reject" ? "驳回" : "待表决"}
              </span>
            </li>
          ))}
          {reviewers.length === 0 && <li className="text-[13px] text-[color:var(--ink-2)]">这一轮没有登记评审人。</li>}
        </ul>
        {!canAssess && pending && <p className="mt-3 text-[13px] text-[color:var(--ink-2)]">等待{reviewerName}逐项评估并表决。通过后还要经 PMO 终审。</p>}
        {pending && (
          <p className="mt-2 text-xs text-[color:var(--ink-3)]">
            {v.mode === "any" ? "或签：首位表决人决定，通过即过、驳回即驳回。" : "会签：需全部评审人通过，任一驳回即驳回。"}
          </p>
        )}
      </section>

      {/* 待决时 PM / CTO / 管理员可以撤回,回去改方案 */}
      {pending && project.can.manage && (
        <button type="button" disabled={busy} onClick={() => void withdraw()} className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-[color:var(--ink-2)] hover:text-[color:var(--red-deep)] disabled:opacity-50">
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> 撤回本轮评估
        </button>
      )}

      {/* PM 提交的方案,供评估时对照 */}
      <section className="glass-card p-5">
        <h2 className="text-[15px] font-semibold text-neutral-900">PM 提交的承接方案</h2>
        {v.summary && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-900">{v.summary}</p>}
        <div className="mt-3">
          <LinesReadonly lines={v.lines} />
        </div>
      </section>

      {ask && <DecideDialog key={ask} kind={ask} busy={busy} onClose={() => setAsk(null)} onDecide={(d, c) => void decide(d, c)} />}
    </div>
  );
}

/** 表决前的确认:退回必须写意见;通过说明条件与替代方案会带给 PMO */
function DecideDialog({
  kind,
  busy,
  onClose,
  onDecide,
}: {
  kind: Decision;
  busy: boolean;
  onClose: () => void;
  onDecide: (decision: Decision, comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const reject = kind === "reject";
  return (
    <Dialog onClose={onClose} labelledBy="decide-title">
      <DialogHeader
        id="decide-title"
        tone={reject ? "amber" : "indigo"}
        title={reject ? "退回修改" : "通过技术可行性评估"}
        subtitle={
          reject
            ? "退回后回到 PM 推进，PM 修改后重新提交，另起一轮评估。请写明退回原因。"
            : "通过后不直接进入下一阶段：整体流程与方案交 PMO 终审，终审通过后才进入下一阶段。你给出的条件与替代方案会一并带给 PMO。"
        }
        onClose={onClose}
      />
      <div className="mt-4">
        <Field label={reject ? "退回原因" : "评审意见"} required={reject} hint={reject ? undefined : "选填"}>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={reject ? "如：消费数据回写的替代方案牺牲了实时性，请重新评估" : "如：总体可行，电子签章服务需列入预算"} className="min-h-[76px] !text-[13px]" />
        </Field>
      </div>
      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-glass">
          取消
        </button>
        <button type="button" disabled={busy || (reject && !comment.trim())} onClick={() => onDecide(kind, comment.trim())} className={cn("btn", reject ? "btn-glass text-[color:var(--red-deep)]" : "btn-primary", "disabled:opacity-50")}>
          {reject ? "确认退回" : "确认通过"}
        </button>
      </DialogActions>
    </Dialog>
  );
}
