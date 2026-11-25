"use client";

/**
 * PM 的承接方案(「PM 按优先级推进」环节):流程是否完整、综合方案总述、三条推进线的原因 / 解决方案 / 负责人、
 * 逐节点的处理状态、送 CTO 评估的技术点,以及提交技术可行性评估。
 * PM / CTO / 管理员能改全部;某条推进线的负责人(项目里的 BH / TH)只能改自己那一条。
 * 申请 CTO 协助的入口在承接标签页右栏的团队卡片里(见 intake-support.tsx)。
 */

import { useState } from "react";
import { FileSignature, ListChecks, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth";
import type { IntakeAssessment, IntakeLine, IntakeLineKey, IntakeNode, IntakePoint, IntakeView, PlanStatus, ProjectView } from "@/lib/types";
import { PLAN_STATUS_LABEL, VERDICT_LABEL, fmtDateTime, verdictClass } from "@/lib/labels";
import { completenessText, planProgress, supportText } from "@/lib/intake";
import { LineReadonly, LineTag, NodeChip, lineMeta } from "@/components/projects/intake-bits";
import { fail, putSolution, useAction } from "@/components/projects/intake-action";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const PLAN_OPTIONS: PlanStatus[] = ["pending", "planned", "na"];
const COMPLETENESS_OPTIONS = [
  ["complete", "结构完整"],
  ["gaps", "有缺口"],
] as const;

export function IntakeSolution({
  v,
  project,
  onSaved,
  onMembers,
}: {
  v: IntakeView;
  project: ProjectView;
  onSaved: () => Promise<void>;
  /** 打开成员管理(指派 BH / 分配 TH) */
  onMembers: () => void;
}) {
  const [pointsOpen, setPointsOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const support = v.ctoSupport;
  const canEditLine = (key: IntakeLineKey) => v.can.edit || v.ownLines.includes(key);
  // 被 PMO 终审退回:退回意见放在方案最上面;上一轮 CTO 的结论留在每个技术点下面,改的时候对照
  const returned = v.phase === "advance" && v.finals[0]?.decision === "returned" ? v.finals[0] : null;
  const assessed = v.phase !== "assess" && v.points.some((p) => p.assessments.length > 0);

  return (
    <div className="grid gap-4">
      {returned && (
        <p className="rounded-2xl bg-[color:var(--red-soft)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--red-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.25)]">
          <b>PMO 已退回整改</b>
          <span className="ml-2 text-[11px] text-[color:var(--ink-3)]">
            {returned.decidedByName} · {fmtDateTime(returned.decidedAt)}
          </span>
          <br />
          {returned.note}
          <span className="text-[color:var(--ink-2)]">　按意见调整后重新提交，评估会另起一轮。</span>
        </p>
      )}
      {/* 整体把关 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          整体把关
          {support.status !== "none" && (
            <span className="badge badge-indigo ml-auto !h-[20px] text-[11px]" title={support.reason}>
              CTO 协助 · {supportText(support)}
            </span>
          )}
        </h2>
        {v.can.edit ? <OverallForm key={`${v.completeness}:${v.completenessNote}:${v.summary}`} v={v} projectId={project.id} onSaved={onSaved} /> : <OverallReadonly v={v} />}
      </section>

      {/* 三条推进线 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          按优先级推进
          <span className="badge badge-plain !h-[20px] text-[11px]">每条 = 现状 → 原因 → 解决方案</span>
        </h2>
        <div className="mt-2.5 rounded-2xl bg-white/55 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
          <b className="text-neutral-900">解决顺序：</b>① 线下节点转线上 → ② 系统不互通 → ③ 线上节点移动化。先定下哪些节点转为线上，才能确定最终的跨系统衔接、以及需要移动化的线上节点范围。
        </div>
        <div className="mt-3 grid gap-3">
          {v.lines.map((line) =>
            canEditLine(line.key) ? (
              <LineEditor
                key={`${line.key}:${line.updatedAt ?? ""}`}
                line={line}
                projectId={project.id}
                members={project.members.filter((m) => m.role !== "viewer")}
                onSaved={onSaved}
                canSetOwner={v.can.edit}
              />
            ) : (
              <LineReadonly key={line.key} line={line} defaultOpen={line.nodes.length > 0} />
            ),
          )}
        </div>
        {!v.can.edit && !v.can.editLines && <p className="mt-3 text-xs text-[color:var(--ink-3)]">等待 PM 完成原因与解决方案后提交评估。</p>}
        {!v.can.edit && v.can.editLines && <p className="mt-3 text-xs text-[color:var(--ink-3)]">你是一条或几条推进线的负责人：可以修改自己那一条的原因、方案与节点状态；提交评估由 PM 操作。</p>}
      </section>

      {/* 技术点 */}
      <section className="glass-card p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
          送 CTO 评估的技术点
          <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{v.points.length} 个</span>
          {v.can.edit && (
            <button type="button" onClick={() => setPointsOpen(true)} className="btn btn-glass !h-8 !px-3 text-[12.5px]">
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" /> 管理
            </button>
          )}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">方案里需要从技术上判断能不能实现的地方，逐条列出来，CTO 对每一条给出结论。</p>
        <PointList points={v.points} renderExtra={assessed ? (p) => <AssessmentLines assessments={p.assessments} label={`第 ${v.round} 轮 CTO 结论`} /> : undefined} />
      </section>

      {/* 提交 */}
      {v.can.edit && (
        <section className="glass-card p-5">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
            提交技术可行性评估
            <span className={cn("badge ml-auto !h-[20px] text-[11px]", v.missing.length > 0 ? "badge-amber" : "badge-ok")}>
              {v.missing.length > 0 ? `还差 ${v.missing.length} 项` : "方案已齐备"}
            </span>
          </h2>
          {v.missing.length > 0 ? (
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {v.missing.map((m) => (
                <li key={m} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[color:var(--red-soft)] text-[11px] font-bold text-[color:var(--red-deep)]">!</span>
                  <span className="font-medium text-neutral-900">{m}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink-2)]">流程完整性、三条推进线、综合方案总述与技术点都已就绪，可以提交 CTO 做技术可行性评估。</p>
          )}
          <div className="mt-3.5 flex flex-wrap gap-2.5">
            <button type="button" onClick={onMembers} className="btn btn-glass !h-10">
              <UserPlus className="h-4 w-4" aria-hidden="true" /> 指派 BH
            </button>
            <button type="button" disabled={v.missing.length > 0} onClick={() => setSubmitOpen(true)} className="btn btn-primary ml-auto !h-10 disabled:opacity-50">
              <FileSignature className="h-4 w-4" aria-hidden="true" /> 提交技术可行性评估
            </button>
          </div>
        </section>
      )}

      {pointsOpen && <PointsDialog v={v} projectId={project.id} onClose={() => setPointsOpen(false)} onSaved={onSaved} />}
      {submitOpen && <SubmitDialog v={v} projectId={project.id} onClose={() => setSubmitOpen(false)} onSaved={onSaved} />}
    </div>
  );
}

/** 「流程是否完整」与「综合方案总述」,改动后保存 */
function OverallForm({ v, projectId, onSaved }: { v: IntakeView; projectId: string; onSaved: () => Promise<void> }) {
  const [completeness, setCompleteness] = useState(v.completeness);
  const [note, setNote] = useState(v.completenessNote);
  const [summary, setSummary] = useState(v.summary);
  const { busy, run } = useAction(onSaved);
  const dirty = completeness !== v.completeness || note !== v.completenessNote || summary !== v.summary;
  return (
    <div className="mt-3.5 grid gap-3">
      <Field label="流程是否完整" hint="PMO 初析时标记的缺口，补全后改为「结构完整」">
        <div className="seg seg-mini w-fit" role="group" aria-label="流程是否完整">
          {COMPLETENESS_OPTIONS.map(([val, label]) => (
            <button key={val} type="button" className={cn(completeness === val && "on")} onClick={() => setCompleteness(completeness === val ? "" : val)}>
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Field label={completeness === "gaps" ? "缺口与整改计划" : "完整性说明"} hint="选填">
        <Textarea aria-label="完整性说明" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：退回路径已补全，行程预订被拒后回到分管领导审批" className="min-h-[52px] !text-[13px]" />
      </Field>
      <Field label="综合方案总述" hint="整体流程全部线上化与移动化的目标与范围">
        <Textarea aria-label="综合方案总述" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="如：12 个节点全部线上办理并支持移动端，消除 3 处人工搬运" className="min-h-[68px] !text-[13px]" />
      </Field>
      <div>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void run("保存失败", () => putSolution(projectId, { completeness, completenessNote: note, summary }), "已保存")}
          className="btn btn-glass !h-9 disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function OverallReadonly({ v }: { v: IntakeView }) {
  const text = (s: string) => <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-900">{s || "—"}</p>;
  return (
    <dl className="mt-3 grid gap-2.5 text-[13px]">
      <div>
        <dt className="text-xs text-[color:var(--ink-2)]">流程是否完整</dt>
        <dd className="mt-0.5">{text(completenessText(v.completeness, v.completenessNote))}</dd>
      </div>
      <div>
        <dt className="text-xs text-[color:var(--ink-2)]">综合方案总述</dt>
        <dd className="mt-0.5">{text(v.summary)}</dd>
      </div>
    </dl>
  );
}

/** 一条推进线的编辑:负责人、原因、方案(改动后保存);逐节点的处理状态(改动即保存)。
 *  canSetOwner:能不能换负责人——只有 PM / CTO / 管理员能;推进线的负责人只能改自己那条的内容 */
function LineEditor({
  line,
  projectId,
  members,
  onSaved,
  canSetOwner,
}: {
  line: IntakeLine;
  projectId: string;
  members: ProjectView["members"];
  onSaved: () => Promise<void>;
  canSetOwner: boolean;
}) {
  const m = lineMeta(line.key);
  const empty = line.nodes.length === 0;
  const [reason, setReason] = useState(line.reason);
  const [solution, setSolution] = useState(line.solution);
  const [owner, setOwner] = useState(line.ownerId);
  const { busy, run } = useAction(onSaved);
  const dirty = reason !== line.reason || solution !== line.solution || (canSetOwner && owner !== line.ownerId);

  return (
    <article className="rounded-[20px] bg-white/55 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-[30px] shrink-0 place-items-center rounded-[9px] text-[15px] font-bold" style={{ background: m.soft, color: m.deep }}>
          {m.mark}
        </span>
        <b className="text-[15px] font-semibold text-neutral-900">{m.title}</b>
        <span className="badge !h-[20px] text-[11px]" style={{ background: m.soft, color: m.deep }}>
          {m.order}
        </span>
        <span className="badge badge-plain !h-[20px] font-data text-[11px]">{line.nodes.length} 个节点</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[color:var(--ink-2)]">
          负责人
          <select
            value={owner}
            disabled={!canSetOwner || busy}
            title={canSetOwner ? undefined : "负责人由 PM 指定"}
            onChange={(e) => setOwner(e.target.value)}
            aria-label={`「${m.title}」的负责人`}
            className="field !h-8 w-auto min-w-[96px] !px-2 !text-[12px] disabled:opacity-60"
          >
            <option value="">未指定</option>
            {members.map((x) => (
              <option key={x.userId} value={x.userId}>
                {x.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 节点:现状来自自动诊断;处理状态改动即保存 */}
      <div className="mt-3 grid gap-1.5">
        {empty ? (
          <p className="text-xs text-[color:var(--ink-3)]">没有这类节点，不必写原因与方案。</p>
        ) : (
          line.nodes.map((n) => <NodeRow key={`${n.key}:${n.status}:${n.updatedAt ?? ""}`} lineKey={line.key} node={n} projectId={projectId} onSaved={onSaved} />)
        )}
      </div>

      {!empty && (
        <>
          <div className="mt-3 grid gap-2.5">
            <Field label="原因" hint="为什么会有这类节点">
              <Textarea aria-label={`「${m.title}」的原因`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={m.reasonHint} className="min-h-[56px] !text-[13px]" />
            </Field>
            <Field label="解决方案" hint="怎么把它解决掉">
              <Textarea aria-label={`「${m.title}」的解决方案`} value={solution} onChange={(e) => setSolution(e.target.value)} placeholder={m.solutionHint} className="min-h-[56px] !text-[13px]" />
            </Field>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void run("保存失败", () => putSolution(projectId, { lines: [{ key: line.key, reason, solution, ...(canSetOwner ? { ownerId: owner } : {}) }] }), `已保存「${m.title}」`)}
              className="btn btn-glass !h-8 !px-3.5 text-[12.5px] disabled:opacity-50"
            >
              保存
            </button>
            {dirty && <span className="text-[11px] text-[color:var(--ink-3)]">有改动还没保存</span>}
            <span className="ml-auto font-data text-[11px] tabular-nums text-[color:var(--ink-2)]">方案进度 {planProgress(line)}%</span>
          </div>
        </>
      )}
    </article>
  );
}

/** 一个节点:胶囊 + 处理状态下拉(改动即保存)+ 说明(失焦时保存) */
function NodeRow({ lineKey, node, projectId, onSaved }: { lineKey: IntakeLineKey; node: IntakeNode; projectId: string; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(node.note);
  const { busy, run } = useAction(onSaved);
  const send = (status: PlanStatus, nextNote: string) => run("保存节点状态失败", () => putSolution(projectId, { nodes: [{ key: node.key, line: lineKey, status, note: nextNote }] }));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white/45 px-2 py-1.5">
      <NodeChip node={node} line={lineKey} />
      <select value={node.status} disabled={busy} onChange={(e) => void send(e.target.value as PlanStatus, note)} aria-label={`「${node.name}」的处理状态`} className="field !h-7 w-auto !px-2 !text-[12px] disabled:opacity-50">
        {PLAN_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {PLAN_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <input
        value={note}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== node.note) void send(node.status, note);
        }}
        placeholder="说明（选填）"
        aria-label={`「${node.name}」的说明`}
        className="field !h-7 min-w-[120px] flex-1 !px-2 !text-[12px] disabled:opacity-50"
      />
    </div>
  );
}

/** 各评审人对一个技术点的结论(只读):评估时看别人的,退回修改时对照上一轮的 */
export function AssessmentLines({ assessments, label }: { assessments: IntakeAssessment[]; label?: string }) {
  if (assessments.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-1">
      {label && <li className="text-[11px] font-medium text-[color:var(--ink-3)]">{label}</li>}
      {assessments.map((a) => (
        <li key={a.userId} className="flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
          <span className="shrink-0 font-medium text-neutral-900">{a.userName}</span>
          <span className={verdictClass(a.verdict)}>{VERDICT_LABEL[a.verdict]}</span>
          {a.note && <span className="w-full whitespace-pre-wrap sm:flex-1">{a.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** 技术点清单(只读);评估面板在每条下面接自己的结论控件 */
export function PointList({ points, renderExtra }: { points: IntakePoint[]; renderExtra?: (p: IntakePoint) => React.ReactNode }) {
  if (points.length === 0) {
    return <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">还没有技术点。至少列出一个，CTO 才能逐项评估。</p>;
  }
  return (
    <ul className="mt-3 grid gap-2">
      {points.map((p) => (
        <li key={p.id} className="rounded-2xl bg-white/55 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
          <div className="flex flex-wrap items-center gap-2">
            <LineTag line={p.line} />
            <b className="text-[13.5px] font-semibold text-neutral-900">{p.title}</b>
            <span className="ml-auto text-[11px] text-[color:var(--ink-3)]">{p.createdByName} 提出</span>
          </div>
          {p.note && <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{p.note}</p>}
          {renderExtra?.(p)}
        </li>
      ))}
    </ul>
  );
}

const LINE_OPTIONS = (["offline", "interop", "mobile"] as IntakeLineKey[]).map((k) => (
  <option key={k} value={k}>
    {lineMeta(k).mark} {lineMeta(k).title}
  </option>
));

/** 技术点管理:增删改。评估进行中不能改,那时的入口不出现 */
function PointsDialog({ v, projectId, onClose, onSaved }: { v: IntakeView; projectId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [line, setLine] = useState<IntakeLineKey | "">("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const { busy, run } = useAction(onSaved);
  const add = async () => {
    if (!title.trim()) {
      toast.error("技术点名称不能为空");
      return;
    }
    if (await run("添加失败", () => authFetch(`/api/projects/${projectId}/intake/points`, { method: "POST", body: JSON.stringify({ title, line, note }) }), "已添加技术点")) {
      setTitle("");
      setNote("");
    }
  };
  return (
    <Dialog onClose={onClose} labelledBy="points-title" className="max-w-[640px]">
      <DialogHeader id="points-title" title="送 CTO 评估的技术点" subtitle="方案里需要从技术上判断能不能实现的地方，一条一个。按推进线归类，评审时按解决顺序逐条看。" onClose={onClose} />
      <ul className="mt-4 grid max-h-[42vh] gap-2 overflow-y-auto pr-1">
        {v.points.length === 0 && <li className="text-[13px] text-[color:var(--ink-3)]">还没有技术点。</li>}
        {v.points.map((p) => (
          <PointRow key={p.id} p={p} projectId={projectId} busy={busy} run={run} />
        ))}
      </ul>
      <div className="mt-4 rounded-[20px] bg-white/55 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
        <div className="flex flex-wrap gap-2">
          <select value={line} onChange={(e) => setLine(e.target.value as IntakeLineKey | "")} aria-label="所属推进线" className="field !h-10 w-auto !text-[13px]">
            <option value="">通用</option>
            {LINE_OPTIONS}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="技术点，如：发票影像识别准确率" aria-label="技术点名称" className="field !h-10 min-w-[180px] flex-1 !text-[13px]" />
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明（选填）：要 CTO 判断什么" aria-label="技术点说明" className="field mt-2 !h-10 !text-[13px]" />
        <div className="mt-2.5 flex justify-end">
          <button type="button" disabled={busy || !title.trim()} onClick={() => void add()} className="btn btn-primary !h-9 disabled:opacity-50">
            添加
          </button>
        </div>
      </div>
      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-primary">
          完成
        </button>
      </DialogActions>
    </Dialog>
  );
}

type Run = (label: string, fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

/** 技术点的一行:所属推进线、名称、说明改动即保存;可删除 */
function PointRow({ p, projectId, busy, run }: { p: IntakePoint; projectId: string; busy: boolean; run: Run }) {
  const patch = (body: Record<string, unknown>) => run("修改失败", () => authFetch(`/api/intake/points/${p.id}`, { method: "PATCH", body: JSON.stringify(body) }), "已修改");
  return (
    <li className="rounded-2xl bg-white/55 p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-center gap-2">
        <select defaultValue={p.line} disabled={busy} onChange={(e) => void patch({ line: e.target.value })} aria-label="所属推进线" className="field !h-8 w-auto !px-2 !text-[12px]">
          <option value="">通用</option>
          {LINE_OPTIONS}
        </select>
        {/* key 跟着服务端的值走:保存后重新挂载,输入框回到已保存的内容 */}
        <input
          key={p.title}
          defaultValue={p.title}
          disabled={busy}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== p.title) void patch({ title: next });
          }}
          aria-label="技术点名称"
          className="field !h-8 min-w-[160px] flex-1 !text-[13px] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy}
          aria-label={`删除技术点「${p.title}」`}
          onClick={() => void run("删除失败", () => authFetch(`/api/intake/points/${p.id}`, { method: "DELETE" }), "已删除")}
          className="icon-btn icon-danger shrink-0 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <input
        key={p.note}
        defaultValue={p.note}
        disabled={busy}
        onBlur={(e) => {
          if (e.target.value !== p.note) void patch({ note: e.target.value });
        }}
        placeholder="说明（选填）"
        aria-label="技术点说明"
        className="field mt-2 !h-8 !text-[12.5px] disabled:opacity-50"
      />
    </li>
  );
}

/** 提交技术可行性评估:走关卡引擎的评审接口 */
function SubmitDialog({ v, projectId, onClose, onSaved }: { v: IntakeView; projectId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [summary, setSummary] = useState("");
  const { busy, run } = useAction(onSaved);
  const go = async () => {
    const ok = await run("提交失败", () => authFetch(`/api/projects/${projectId}/reviews`, { method: "POST", body: JSON.stringify({ summary }) }), "已提交技术可行性评估，已通知 CTO 逐项评估");
    if (ok) onClose();
  };
  return (
    <Dialog onClose={onClose} labelledBy="submit-title">
      <DialogHeader
        id="submit-title"
        tone="indigo"
        title="提交技术可行性评估"
        subtitle={`${v.points.length} 个技术点将交由 CTO 逐条给出结论。提交后方案与技术点锁定，直到评估结束；通过后还要经 PMO 终审才进入下一阶段。`}
        onClose={onClose}
      />
      <div className="mt-4">
        <Field label="给 CTO 的说明" hint="选填">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="做了什么、请重点看哪里" className="min-h-[76px] !text-[13px]" />
        </Field>
      </div>
      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-glass">
          取消
        </button>
        <button type="button" disabled={busy || v.missing.length > 0} onClick={() => void go()} className="btn btn-primary disabled:opacity-50">
          提交
        </button>
      </DialogActions>
    </Dialog>
  );
}
