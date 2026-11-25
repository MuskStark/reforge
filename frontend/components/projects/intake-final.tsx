"use client";

/**
 * PMO 终审(「PMO 终审」环节):审的是整体流程 + 承接方案 + CTO 的技术可行性评估。
 *   通过归档     承接阶段通过,进入下一阶段
 *   有保留通过   同上,并留下保留意见;保留事项限期落实后由 PMO 复核
 *   退回整改     整体退回 PM 推进,PM 调整后重新提交评估
 * 承接完成后同一组件以只读方式回看整段记录。
 */

import { useState } from "react";
import { PenLine, Undo2 } from "lucide-react";
import { authFetch, type SessionUser } from "@/lib/auth";
import type { FinalDecision, IntakeView, ProjectView } from "@/lib/types";
import { FINAL_LABEL, MODE_LABEL, VERDICT_LABEL, finalClass, fmtDateTime, verdictClass } from "@/lib/labels";
import { completenessText, diagnosisChanged } from "@/lib/intake";
import { useAction } from "@/components/projects/intake-action";
import { CountTiles, LineTag, LinesReadonly } from "@/components/projects/intake-bits";
import { PointList } from "@/components/projects/intake-solution";
import { Avatar } from "@/components/projects/stage-rail";
import { Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const DECISIONS: { value: FinalDecision; note: string; after: string; done: string }[] = [
  { value: "passed", note: "方案存档，承接阶段通过并进入下一阶段。", after: "；承接阶段通过，进入下一阶段", done: "承接阶段通过，进入下一阶段，已通知全体成员与 CTO" },
  { value: "passed_with_notes", note: "同上，并留下保留意见；保留事项限期落实后由 PMO 复核。", after: "；保留事项进入执行跟踪", done: "承接阶段通过，保留事项进入执行跟踪" },
  { value: "returned", note: "整体退回 PM 推进，PM 调整后重新提交评估，另起一轮。", after: "；PM 调整后重新提交，另起一轮评估", done: "已退回 PM 修改，PM 调整后重新提交评估" },
];

export function IntakeFinal({ v, project, me, onSaved }: { v: IntakeView; project: ProjectView; me: SessionUser; onSaved: () => Promise<void> }) {
  const [decision, setDecision] = useState<FinalDecision>("passed");
  const [note, setNote] = useState("");
  const { busy, run } = useAction(onSaved);
  const current = DECISIONS.find((d) => d.value === decision) ?? DECISIONS[0];
  const needNote = decision !== "passed";
  const changed = diagnosisChanged(v.asIs, v.current);

  const sign = () =>
    run(
      "签署失败",
      () => authFetch(`/api/projects/${project.id}/intake/final`, { method: "POST", body: JSON.stringify({ decision, note }) }),
      `已${FINAL_LABEL[decision]}：${current.done}`,
    );

  const noteLabel = decision === "returned" ? "退回原因与整改要求" : decision === "passed_with_notes" ? "保留意见" : "终审意见";
  const notePlaceholder = {
    returned: "如：替代方案牺牲了实时性，请与业务确认后再提",
    passed_with_notes: "如：电子签章与移动端许可的预算落实后复核，限 12-15 前",
    passed: "如：三类节点全部给出了可行方案，同意归档",
  }[decision];

  return (
    <div className="grid gap-4">
      {/* 终审对象:整体流程与方案 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          整体流程 + 方案
          <span className="badge badge-plain ml-auto !h-[20px] text-[11px]">PM 交付 · CTO 已评估</span>
        </h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-[color:var(--ink-2)]">改造价值 / 复杂度</dt>
          <dd className="text-neutral-900">
            {project.value || "待评估"} / {project.complexity || "待评估"}
          </dd>
          <dt className="text-[color:var(--ink-2)]">流程是否完整</dt>
          <dd className="whitespace-pre-wrap text-neutral-900">{completenessText(v.completeness, v.completenessNote)}</dd>
          <dt className="text-[color:var(--ink-2)]">综合方案总述</dt>
          <dd className="whitespace-pre-wrap text-neutral-900">{v.summary || "—"}</dd>
        </dl>
        <p className="mt-3.5 text-xs font-semibold text-[color:var(--ink-2)]">自动诊断：立项时的三类节点，以及当前工作副本里还剩多少</p>
        <CountTiles lines={v.lines} className="mt-2" />
        <p className="mt-2 text-xs leading-relaxed text-[color:var(--ink-3)]">
          {changed
            ? "流程定义已被修改，当前工作副本里的节点数与立项时不同。终审以方案承诺的目标为准，实际成效在后续阶段验证。"
            : "当前工作副本尚未改动；按方案实施后，这三类节点应全部清零。"}
        </p>
        <div className="mt-3">
          <LinesReadonly lines={v.lines} />
        </div>
      </section>

      {/* 技术点与评估结论,以及附带的条件 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          技术可行性评估
          {v.round > 0 && <span className="badge badge-indigo !h-[20px] text-[11px]">第 {v.round} 轮</span>}
          {v.mode && <span className="badge badge-plain !h-[20px] text-[11px]">{MODE_LABEL[v.mode]}</span>}
        </h2>
        <PointList
          points={v.points}
          renderExtra={(p) =>
            p.assessments.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-[color:var(--ink-3)]">没有结论</p>
            ) : (
              <ul className="mt-2 grid gap-1">
                {p.assessments.map((a) => (
                  <li key={a.userId} className="flex flex-wrap items-start gap-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
                    <span className="shrink-0">{a.userName}</span>
                    <span className={verdictClass(a.verdict)}>{VERDICT_LABEL[a.verdict]}</span>
                    {a.note && <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-neutral-900">{a.note}</span>}
                  </li>
                ))}
              </ul>
            )
          }
        />
        <Conditions v={v} />
      </section>

      {/* 签署终审 */}
      {v.can.final && (
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            终审结论
            <span className="badge badge-indigo ml-auto !h-[20px] text-[11px]">{me.jobRole === "viewer" ? "PMO" : "管理员代行"}</span>
          </h2>
          <div className="seg mt-3" role="group" aria-label="终审结论">
            {DECISIONS.map((d) => (
              <button key={d.value} type="button" disabled={busy} className={cn(decision === d.value && "on")} onClick={() => setDecision(d.value)}>
                {FINAL_LABEL[d.value]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[color:var(--ink-2)]">{current.note}</p>
          <div className="mt-3">
            <Field label={noteLabel} required={needNote} hint={needNote ? undefined : "选填；归档时随方案存档"}>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={notePlaceholder} className="min-h-[76px] !text-[13px]" />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2.5 rounded-2xl bg-white/55 px-3 py-2.5 text-[12px] leading-relaxed text-[color:var(--ink-2)] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.05)]">
            <Avatar name={me.displayName || me.username} size={30} />
            <span>
              签署人 <b className="text-neutral-900">{me.displayName || me.username}</b>
              <br />
              签署后立即通知 PM、全体成员与 CTO{current.after}。
            </span>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={busy || (needNote && !note.trim())}
              onClick={sign}
              className={cn("btn !h-10", decision === "returned" ? "btn-glass text-[color:var(--red-deep)]" : "btn-primary", "disabled:opacity-50")}
            >
              {decision === "returned" ? <Undo2 className="h-4 w-4" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />}
              签署终审 · {FINAL_LABEL[decision]}
            </button>
          </div>
        </section>
      )}

      {/* 历次终审 */}
      {v.finals.length > 0 && (
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            终审记录
            <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{v.finals.length} 次</span>
          </h2>
          <ol className="mt-3 grid gap-2">
            {v.finals.map((f) => (
              <li key={f.id} className="rounded-2xl bg-white/55 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className={finalClass(f.decision)}>{FINAL_LABEL[f.decision]}</span>
                  <span className="text-[color:var(--ink-2)]">
                    {f.decidedByName} · 第 {f.round} 轮评估
                  </span>
                  <span className="font-data ml-auto text-[11px] tabular-nums text-[color:var(--ink-3)]">{fmtDateTime(f.decidedAt)}</span>
                </div>
                {f.note && <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{f.note}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** 评估里附带的条件、以及不可行项的替代方案:终审要裁决的东西 */
function Conditions({ v }: { v: IntakeView }) {
  const items = v.points.flatMap((p) =>
    p.assessments.filter((a) => a.verdict !== "feasible").map((a) => ({ id: `${p.id}:${a.userId}`, line: p.line, title: p.title, verdict: a.verdict, note: a.note, by: a.userName })),
  );
  if (items.length === 0) return null;
  return (
    <div className="mt-3.5 rounded-[20px] bg-[linear-gradient(180deg,rgba(255,246,230,0.6),rgba(255,255,255,0.45))] p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
      <h3 className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-[color:var(--amber-deep)]">
        评估附带的条件
        <span className="badge badge-amber !h-[20px] font-data text-[11px]">{items.length} 项</span>
      </h3>
      <ul className="mt-2 grid gap-2">
        {items.map((it) => (
          <li key={it.id} className="text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
            <div className="flex flex-wrap items-center gap-1.5">
              <LineTag line={it.line} className="!h-[19px] text-[10.5px]" />
              <b className="font-semibold text-neutral-900">{it.title}</b>
              <span className={verdictClass(it.verdict)}>{VERDICT_LABEL[it.verdict]}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-neutral-900">
              {it.note || "没有写说明"}
              <span className="text-[color:var(--ink-3)]"> — {it.by}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
