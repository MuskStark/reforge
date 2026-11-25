"use client";

/**
 * 评审:当前关卡的提交 / 表决、阶段调整(回退、跳过)、历次评审记录。
 * 或签:首位表决人决定,通过即过、驳回即驳回;会签:全部通过才过,任一驳回即驳回。
 */

import { useEffect, useState } from "react";
import { CornerUpLeft, FastForward, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth";
import type { GateReview, ProjectView } from "@/lib/types";
import { MODE_LABEL, REVIEW_STATUS_LABEL, STAGE_STATUS_LABEL, fmtDateTime } from "@/lib/labels";
import { Avatar } from "@/components/projects/stage-rail";
import type { DetailCtx } from "@/components/projects/project-detail";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const fail = (e: unknown, label: string) =>
  toast.error(label, { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });

function reviewBadge(status: string) {
  return cn(
    "badge !h-[20px] text-[11px]",
    status === "approved" && "badge-ok",
    status === "rejected" && "badge-warn",
    status === "withdrawn" && "badge-plain",
    status === "pending" && "badge-indigo",
  );
}

function voteBadge(decision: string) {
  return cn(
    "badge !h-[20px] text-[11px]",
    decision === "approve" && "badge-ok",
    decision === "reject" && "badge-warn",
    decision === "pending" && "badge-plain",
  );
}

export function ReviewTab({ ctx }: { ctx: DetailCtx }) {
  const { project, me } = ctx;
  const cur = project.stages[project.currentStage - 1];
  const review = project.review;
  const [history, setHistory] = useState<GateReview[]>([]);
  const [summary, setSummary] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [rewind, setRewind] = useState<{ open: boolean; to: string; reason: string }>({ open: false, to: "", reason: "" });
  const [skip, setSkip] = useState<{ open: boolean; reason: string }>({ open: false, reason: "" });

  useEffect(() => {
    authFetch<GateReview[]>(`/api/projects/${project.id}/reviews`, { cache: "no-store" })
      .then((h) => setHistory(h ?? []))
      .catch(() => {});
  }, [project.id, project.version, project.stages.map((s) => `${s.seq}:${s.rounds}`).join()]);

  const live = project.status === "active";
  // 当前阶段正在进行的这一轮评审
  const pendingHere = live && cur?.status === "in_review" && review?.status === "pending" && review.stageSeq === cur.seq;
  const iCanVote =
    !!pendingHere &&
    (project.can.isAdmin || (cur.reviewerRole === "cto" ? project.can.reviewCTO : cur.reviewerRole === "handler" ? project.can.reviewHandler : false));
  const myRow = pendingHere ? review!.reviewers.find((r) => r.userId === me.id && me.id !== "") : undefined;
  const myVote = myRow && myRow.decision !== "pending" ? myRow.decision : "";
  const votes = pendingHere
    ? { done: review!.reviewers.filter((r) => r.decision !== "pending").length, total: review!.reviewers.length }
    : { done: 0, total: 0 };

  const required = ctx.items.filter((i) => i.required && cur && i.stageSeq === cur.seq);
  const missing = required.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const canSubmit = live && cur?.status === "in_progress" && !!cur.gate && project.can.manage;
  const reviewerName = cur?.reviewerRole === "cto" ? "CTO" : "BH";
  const earlier = project.stages.filter((s) => s.seq < project.currentStage);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await ctx.refresh();
      return true;
    } catch (e) {
      fail(e, label);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (missing.length > 0) {
      toast.error("还有必交付物未完成", { description: missing.map((m) => m.title).join("、") });
      return;
    }
    if (
      await run("提交失败", () =>
        authFetch(`/api/projects/${project.id}/reviews`, { method: "POST", body: JSON.stringify({ summary }) }),
      )
    ) {
      toast.success(`已提交${cur!.gate}`, { description: `已通知${reviewerName}评审` });
      setSummary("");
    }
  };

  const vote = async (decision: "approve" | "reject") => {
    if (decision === "reject" && !comment.trim()) {
      toast.error("驳回必须填写意见");
      return;
    }
    setBusy(true);
    try {
      const r = await authFetch<{ status: string }>(`/api/reviews/${review!.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, comment }),
      });
      toast.success(decision === "approve" ? "已表决通过" : "已驳回", {
        description:
          r.status === "approved" ? "评审通过，已进入下一阶段并通知全体成员" : r.status === "rejected" ? "已退回 PM 修改" : "已记录你的表决，等待其他评审人",
      });
      setComment("");
      await ctx.refresh();
    } catch (e) {
      fail(e, "表决失败");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (await run("撤回失败", () => authFetch(`/api/reviews/${review!.id}/withdraw`, { method: "POST" }))) {
      toast.success("已撤回评审", { description: "阶段回到进行中，可修改后重新提交" });
    }
  };

  const doRewind = async () => {
    if (!rewind.reason.trim()) {
      toast.error("回退阶段必须填写原因");
      return;
    }
    if (
      await run(
        "回退失败",
        () =>
          authFetch<ProjectView>(`/api/projects/${project.id}/stages/${rewind.to}/enter`, {
            method: "POST",
            body: JSON.stringify({ reason: rewind.reason }),
          }),
        `已退回到「${project.stages[Number(rewind.to) - 1]?.name}」`,
      )
    ) {
      setRewind({ open: false, to: "", reason: "" });
    }
  };

  const doSkip = async () => {
    if (!skip.reason.trim()) {
      toast.error("跳过阶段必须填写原因");
      return;
    }
    if (
      await run(
        "跳过失败",
        () => authFetch<ProjectView>(`/api/projects/${project.id}/stages/${cur!.seq}/skip`, { method: "POST", body: JSON.stringify({ reason: skip.reason }) }),
        `已跳过「${cur!.name}」`,
      )
    ) {
      setSkip({ open: false, reason: "" });
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {/* 当前关卡 */}
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            当前关卡
            {cur && <span className="badge badge-plain !h-[20px] text-[11px]">阶段 {cur.seq} · {cur.name}</span>}
            {cur && <span className="badge badge-blue !h-[20px] text-[11px]">{STAGE_STATUS_LABEL[cur.status]}</span>}
          </h2>

          {!live && <p className="mt-3 text-[13px] text-[color:var(--ink-2)]">项目已{project.status === "done" ? "完成" : project.status === "cancelled" ? "取消" : "搁置"}，不再进行评审。</p>}
          {live && !cur?.gate && <p className="mt-3 text-[13px] text-[color:var(--ink-2)]">「{cur?.name}」没有评审关卡。持续记录运营指标，积累的优化项可以再次立项。</p>}

          {/* 评审中 */}
          {live && cur?.status === "in_review" && review && (
            <div className="mt-4 rounded-2xl bg-[linear-gradient(180deg,rgba(240,240,255,0.5),rgba(255,255,255,0.45))] p-4 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.25)]">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[16px] font-bold text-[color:var(--indigo-deep)]">{cur.gate}</h3>
                <span className="badge badge-indigo !h-[20px] text-[11px]">第 {review.round} 轮</span>
                <span className="badge badge-plain !h-[20px] text-[11px]">{reviewerName}{MODE_LABEL[cur.mode]}</span>
                <span className="badge badge-blue ml-auto !h-[20px] font-data text-[11px]">
                  已表决 {votes.done}/{votes.total}
                </span>
              </div>
              {review.summary ? (
                <p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-900">{review.summary}</p>
              ) : (
                <p className="mt-2.5 text-[13px] text-[color:var(--ink-3)]">提交时没有附说明。</p>
              )}
              <p className="mt-1.5 text-xs text-[color:var(--ink-3)]">
                {review.submittedByName} 提交于 {fmtDateTime(review.submittedAt)}
                {cur.mode === "all" ? " · 需全部评审人通过，任一驳回即驳回" : " · 首位表决人决定：通过即过、驳回即驳回"}
              </p>

              <ul className="mt-3.5 grid gap-2">
                {review.reviewers.map((r) => (
                  <li key={r.userId} className="flex items-start gap-2.5 rounded-xl bg-white/65 px-3 py-2">
                    <Avatar name={r.displayName || r.username} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-neutral-900">{r.displayName || r.username || "系统管理员"}</span>
                        <span className="text-[11px] text-[color:var(--ink-3)]">{r.role === "cto" ? "CTO" : r.role === "handler" ? "BH" : r.role === "admin" ? "管理员裁决" : r.role}</span>
                        <span className={cn(voteBadge(r.decision), "ml-auto")}>
                          {r.decision === "approve" ? "通过" : r.decision === "reject" ? "驳回" : "待表决"}
                        </span>
                      </div>
                      {r.comment && <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{r.comment}</p>}
                      {r.decidedAt && <p className="mt-0.5 font-data text-[10px] text-[color:var(--ink-3)]">{fmtDateTime(r.decidedAt)}</p>}
                    </div>
                  </li>
                ))}
                {review.reviewers.length === 0 && <li className="text-[13px] text-[color:var(--ink-2)]">这一轮没有登记评审人，由系统管理员裁决。</li>}
              </ul>

              {/* 我的表决 */}
              <div className="mt-4 border-t border-[rgba(88,86,214,0.18)] pt-3.5">
                {myVote ? (
                  <p className="text-[13px] text-[color:var(--ink-2)]">
                    你已表决：<b className={myVote === "approve" ? "text-[color:var(--green-deep)]" : "text-[color:var(--red-deep)]"}>{myVote === "approve" ? "通过" : "驳回"}</b>
                    {review.mode === "all" && votes.done < votes.total ? "，等待其他评审人。" : "。"}
                  </p>
                ) : iCanVote ? (
                  <>
                    <span className="text-[13px] font-medium text-neutral-900">你的表决</span>
                    <Textarea
                      aria-label="评审意见"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="评审意见（驳回时必填）"
                      className="mt-1.5 min-h-[64px] !text-[13px]"
                    />
                    <div className="mt-2.5 flex flex-wrap gap-2.5">
                      <button type="button" disabled={busy} onClick={() => void vote("approve")} className="btn btn-primary !h-10 !px-5">
                        通过
                      </button>
                      <button
                        type="button"
                        disabled={busy || !comment.trim()}
                        onClick={() => void vote("reject")}
                        title={!comment.trim() ? "驳回需要先填写意见" : undefined}
                        className="btn btn-glass !h-10 !px-5 text-[color:var(--red-deep)] disabled:opacity-50"
                      >
                        驳回
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-[13px] text-[color:var(--ink-2)]">等待{reviewerName}表决。通过后自动进入下一阶段并通知全体成员。</p>
                )}
                {project.can.manage && (
                  <button type="button" disabled={busy} onClick={() => void withdraw()} className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--ink-2)] hover:text-[color:var(--red-deep)]">
                    <Undo2 className="h-3.5 w-3.5" /> 撤回本轮评审
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 进行中:提交 */}
          {live && cur?.status === "in_progress" && cur.gate && (
            <div className="mt-4 rounded-2xl bg-white/55 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
              <h3 className="text-[15px] font-semibold text-neutral-900">
                提交「{cur.gate}」
                <span className="ml-2 text-xs font-normal text-[color:var(--ink-2)]">
                  由{reviewerName}{MODE_LABEL[cur.mode]}
                </span>
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--ink-2)]">提交前须完成本阶段的全部必交付物{cur.seq === 1 ? "，并填写改造价值与复杂度（在概览里）" : ""}。</p>

              {required.length > 0 && (
                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {required.map((r) => {
                    const ok = r.status === "done" || r.status === "cancelled";
                    return (
                      <li key={r.id} className="flex items-center gap-2 text-[13px]">
                        <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold", ok ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]" : "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]")}>
                          {ok ? "✓" : "!"}
                        </span>
                        <span className={cn("min-w-0 flex-1 truncate", ok ? "text-[color:var(--ink-2)]" : "font-medium text-neutral-900")}>{r.title}</span>
                        {!ok && (
                          <button
                            type="button"
                            onClick={() => {
                              ctx.goTab("plan", { item: r.id });
                            }}
                            className="text-xs font-medium text-[color:var(--tint)] hover:underline"
                          >
                            去完成
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {canSubmit ? (
                <>
                  <Textarea
                    aria-label="提交说明"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder="给评审人的说明：做了什么、请重点看哪里"
                    className="mt-3 min-h-[76px] !text-[13px]"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button type="button" disabled={busy} onClick={() => void submit()} className="btn btn-primary !h-10 !px-5 disabled:opacity-60">
                      提交 {cur.gate}
                    </button>
                    {missing.length > 0 && <span className="text-xs text-[color:var(--red-deep)]">还有 {missing.length} 项必交付物未完成</span>}
                  </div>
                </>
              ) : (
                <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">等待 PM 完成必交付物并提交评审。</p>
              )}
            </div>
          )}

          {live && cur && (cur.status === "approved" || cur.status === "skipped") && (
            <p className="mt-3 text-[13px] text-[color:var(--ink-2)]">本阶段已{cur.status === "skipped" ? "跳过" : "通过"}。</p>
          )}
        </section>

        {/* 评审历史 */}
        <section className="glass-card p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
            评审记录
            <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{history.length}</span>
          </h2>
          {history.length === 0 ? (
            <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">还没有提交过评审。</p>
          ) : (
            <ul className="mt-3 grid gap-2.5">
              {history.map((r) => {
                const st = project.stages[r.stageSeq - 1];
                return (
                  <li key={r.id} className="rounded-2xl bg-white/55 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="font-semibold text-neutral-900">
                        {st?.gate ?? st?.name} · 第 {r.round} 轮
                      </span>
                      <span className={reviewBadge(r.status)}>{REVIEW_STATUS_LABEL[r.status] ?? r.status}</span>
                      <span className="font-data ml-auto text-[11px] text-[color:var(--ink-3)]">
                        {r.submittedByName} · {fmtDateTime(r.submittedAt)}
                      </span>
                    </div>
                    {r.summary && <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{r.summary}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.reviewers.map((v) => (
                        <span key={v.userId} className={cn(voteBadge(v.decision), "!h-[19px] !px-2 text-[10px]")}>
                          {v.displayName || v.username || "管理员"} · {v.decision === "approve" ? "通过" : v.decision === "reject" ? "驳回" : "未表决"}
                        </span>
                      ))}
                    </div>
                    {r.reviewers.some((v) => v.comment) && (
                      <ul className="mt-2 grid gap-1">
                        {r.reviewers
                          .filter((v) => v.comment)
                          .map((v) => (
                            <li key={v.userId} className="text-xs leading-relaxed text-[color:var(--ink-2)]">
                              <b className="text-neutral-900">{v.displayName || v.username}：</b>
                              {v.comment}
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <aside className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {/* 阶段调整 */}
        {live && (project.can.manage || project.can.skip) && (
          <section className="glass-card p-5">
            <h2 className="text-[15px] font-semibold text-neutral-900">阶段调整</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">偶发情况才用。每次调整都要写原因，并记入动态。</p>
            <div className="mt-3 grid gap-2">
              {project.can.manage && (
                <button
                  type="button"
                  disabled={earlier.length === 0 || cur?.status === "in_review"}
                  onClick={() => setRewind({ open: true, to: String(earlier[earlier.length - 1]?.seq ?? ""), reason: "" })}
                  title={cur?.status === "in_review" ? "评审进行中，请先撤回评审" : earlier.length === 0 ? "已在第一阶段" : undefined}
                  className="btn btn-glass !h-10 justify-start !px-4 text-[13px] disabled:opacity-50"
                >
                  <CornerUpLeft className="h-4 w-4" /> 回退到此前阶段重做
                </button>
              )}
              {project.can.skip && cur?.seq < project.stages.length && (
                <button type="button" onClick={() => setSkip({ open: true, reason: "" })} className="btn btn-glass !h-10 justify-start !px-4 text-[13px]">
                  <FastForward className="h-4 w-4" /> 跳过当前阶段
                </button>
              )}
            </div>
          </section>
        )}

        {/* 关卡一览 */}
        <section className="glass-card p-5">
          <h2 className="text-[15px] font-semibold text-neutral-900">全程关卡</h2>
          <ol className="mt-3 grid gap-1">
            {project.stages.map((s) => (
              <li key={s.seq} className={cn("flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-[12.5px]", s.seq === project.currentStage && project.status === "active" && "bg-white/70 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.05)]")}>
                <span className="font-data w-4 shrink-0 text-[color:var(--ink-3)]">{s.seq}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-neutral-900">{s.name}</span>
                  <span className="block truncate text-[11px] text-[color:var(--ink-3)]">
                    {s.gate ? `${s.gate} · ${s.reviewerRole === "cto" ? "CTO" : "BH"}${MODE_LABEL[s.mode]}` : "无门禁"}
                  </span>
                </span>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", s.status === "approved" ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]" : s.status === "skipped" ? "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]" : s.status === "in_review" ? "bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)]" : s.status === "in_progress" ? "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]" : "bg-[rgba(120,120,128,0.08)] text-[color:var(--ink-3)]")}>
                  {STAGE_STATUS_LABEL[s.status]}
                  {s.rounds > 1 ? ` · ${s.rounds} 轮` : ""}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      {rewind.open && (
        <Dialog onClose={() => setRewind({ ...rewind, open: false })} labelledBy="rewind-title">
          <DialogHeader
            id="rewind-title"
            title="回退到此前阶段"
            subtitle="其后的阶段重置为待开始；已通过的评审记录保留，工作项不丢。请写清原因，全体成员会收到通知。"
            onClose={() => setRewind({ ...rewind, open: false })}
          />
          <div className="mt-4 grid gap-4">
            <Field label="回退到">
              <select value={rewind.to} onChange={(e) => setRewind({ ...rewind, to: e.target.value })} className="field" aria-label="目标阶段">
                {earlier.map((s) => (
                  <option key={s.seq} value={s.seq}>
                    阶段 {s.seq} · {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="原因" required>
              <Textarea value={rewind.reason} onChange={(e) => setRewind({ ...rewind, reason: e.target.value })} placeholder="如：业务口径有变，需求需要重新确认" />
            </Field>
          </div>
          <DialogActions>
            <button type="button" onClick={() => setRewind({ ...rewind, open: false })} className="btn btn-glass">
              取消
            </button>
            <button type="button" disabled={busy || !rewind.reason.trim() || !rewind.to} onClick={() => void doRewind()} className="btn btn-primary disabled:opacity-60">
              确认回退
            </button>
          </DialogActions>
        </Dialog>
      )}

      {skip.open && cur && (
        <Dialog onClose={() => setSkip({ ...skip, open: false })} labelledBy="skip-title">
          <DialogHeader
            id="skip-title"
            title={`跳过「${cur.name}」`}
            subtitle={`只适合很轻的改造（如仅配置改动）。跳过后不留本阶段的版本快照，直接进入「${project.stages[cur.seq]?.name ?? "下一阶段"}」。`}
            tone="amber"
            onClose={() => setSkip({ ...skip, open: false })}
          />
          <div className="mt-4">
            <Field label="原因" required>
              <Textarea value={skip.reason} onChange={(e) => setSkip({ ...skip, reason: e.target.value })} placeholder="如：仅配置改动，无需开发与测试" />
            </Field>
          </div>
          <DialogActions>
            <button type="button" onClick={() => setSkip({ ...skip, open: false })} className="btn btn-glass">
              取消
            </button>
            <button type="button" disabled={busy || !skip.reason.trim()} onClick={() => void doSkip()} className="btn btn-primary disabled:opacity-60">
              确认跳过
            </button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
