"use client";

/**
 * 需求承接的基础件:生命周期轨、推进线与节点的展示、三类节点数的计数。
 * 只做展示,不发请求;各环节的面板(intake-triage / -solution / -assessment / -final)由它们拼装。
 */

import type { IntakeLine, IntakeLineKey, IntakePhase, IntakeView, NodeRef, PlanStatus } from "@/lib/types";
import { DIAGNOSIS_LABEL, INTAKE_LINES, PLAN_STATUS_LABEL, fmtDate, stageTone } from "@/lib/labels";
import { nodeLabel, nodeMeta, planProgress } from "@/lib/intake";
import { cn } from "@/lib/utils";

export const lineMeta = (key: string) => INTAKE_LINES.find((l) => l.key === key) ?? INTAKE_LINES[0];

/** 推进线的小标签:序号 + 名称,用这条线自己的颜色;不属于任何推进线的技术点标「通用」 */
export function LineTag({ line, className }: { line: IntakeLineKey | ""; className?: string }) {
  if (!line) return <span className={cn("badge badge-plain !h-[20px] text-[11px]", className)}>通用</span>;
  const m = lineMeta(line);
  return (
    <span className={cn("badge !h-[20px] text-[11px]", className)} style={{ background: m.soft, color: m.deep }}>
      {m.mark} {m.title}
    </span>
  );
}

/** 节点胶囊:序号圆点按推进线配色 + 名称;可选处理状态。悬停显示系统与说明 */
export function NodeChip({ node, line, status, note }: { node: NodeRef; line: IntakeLineKey; status?: PlanStatus; note?: string }) {
  const m = lineMeta(line);
  const hint = [nodeMeta(node), note].filter(Boolean).join(" · ");
  return (
    <span
      title={hint || undefined}
      className="inline-flex h-[27px] max-w-full items-center gap-1.5 rounded-full bg-white/80 pl-1 pr-2.5 text-[12.5px] font-medium text-neutral-900 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.07),0_1px_3px_-1px_rgba(23,42,80,0.12)]"
    >
      <span className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full text-[10.5px] font-bold tabular-nums" style={{ background: m.soft, color: m.deep }}>
        {node.step}
      </span>
      <span className="min-w-0 truncate">{nodeLabel(node)}</span>
      {status && status !== "pending" && (
        <span className="shrink-0 border-l border-[color:var(--sep)] pl-1.5 text-[11px]" style={{ color: status === "planned" ? "var(--green-deep)" : "var(--ink-3)" }}>
          {PLAN_STATUS_LABEL[status]}
        </span>
      )}
    </span>
  );
}

/** 三类节点数,按解决顺序排列。流程定义被改过之后,同时标出当前工作副本里还剩多少 */
export function CountTiles({ lines, className }: { lines: Pick<IntakeLine, "key" | "nodes" | "remaining">[]; className?: string }) {
  return (
    <div className={cn("grid gap-2 sm:grid-cols-3", className)}>
      {lines.map((line) => {
        const m = lineMeta(line.key);
        const total = line.nodes.length;
        return (
          <div
            key={line.key}
            className="rounded-2xl bg-white/55 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]"
            style={{ borderLeft: `3px solid ${m.dot}` }}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[11px] font-bold" style={{ color: m.deep }}>
                {m.order}
              </span>
              <span className="text-[13px] font-semibold text-neutral-900">{DIAGNOSIS_LABEL[line.key]}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <b className="font-data text-[22px] leading-none tabular-nums text-neutral-900">{total}</b>
              <span className="text-xs text-[color:var(--ink-2)]">个节点</span>
              {line.remaining !== total && <span className="font-data ml-auto text-[11px] tabular-nums text-[color:var(--ink-3)]">当前剩 {line.remaining}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 构成条:三段按解决顺序从左到右,长度 = 节点数占比。项目卡片上用 */
export function MixBar({ offline, interop, mobile }: { offline: number; interop: number; mobile: number }) {
  const total = offline + interop + mobile;
  if (total === 0) return null;
  return (
    <div className="flex h-[5px] gap-[2px] overflow-hidden rounded-full bg-[rgba(120,120,128,0.1)]" aria-hidden="true">
      {INTAKE_LINES.map(({ key, dot }) => {
        const n = key === "offline" ? offline : key === "interop" ? interop : mobile;
        return n > 0 ? <i key={key} className="block h-full" style={{ width: `${(n / total) * 100}%`, background: dot }} /> : null;
      })}
    </div>
  );
}

/** 一条推进线的只读展示:节点、原因、方案、负责人。评估、终审与完成后的回看都用它 */
export function LineReadonly({ line, defaultOpen = false }: { line: IntakeLine; defaultOpen?: boolean }) {
  const m = lineMeta(line.key);
  const empty = line.nodes.length === 0;
  return (
    <details open={defaultOpen || undefined} className="rounded-2xl bg-white/55 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-[13px] [&::-webkit-details-marker]:hidden">
        <span className="text-[13px] font-bold" style={{ color: m.deep }}>
          {m.mark}
        </span>
        <b className="font-semibold text-neutral-900">{m.title}</b>
        <span className="badge badge-plain !h-[19px] font-data text-[10.5px]">{line.nodes.length} 个节点</span>
        {line.ownerName && <span className="text-[11px] text-[color:var(--ink-3)]">负责人 {line.ownerName}</span>}
        {!empty && <span className="font-data ml-auto text-[11px] tabular-nums text-[color:var(--ink-3)]">方案进度 {planProgress(line)}%</span>}
      </summary>
      <div className="mt-2.5 space-y-2.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
        <div className="flex flex-wrap gap-1.5">
          {empty ? <span className="text-[color:var(--ink-3)]">没有这类节点,不必写原因与方案</span> : line.nodes.map((n) => <NodeChip key={n.key} node={n} line={line.key} status={n.status} note={n.note} />)}
        </div>
        {!empty && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-xs font-semibold text-[color:var(--red-deep)]">原因</dt>
            <dd className="whitespace-pre-wrap break-words text-neutral-900">{line.reason || "—"}</dd>
            <dt className="text-xs font-semibold text-[color:var(--tint-deep)]">方案</dt>
            <dd className="whitespace-pre-wrap break-words text-neutral-900">{line.solution || "—"}</dd>
          </dl>
        )}
      </div>
    </details>
  );
}

/** 生命周期轨上的六个环节,顺序即轨上的位置 */
const RAIL: { key: string; label: string; phase?: IntakePhase }[] = [
  { key: "collected", label: "收集完成" },
  { key: "triage", label: "PMO 初级分析", phase: "triage" },
  { key: "assign", label: "指派 PM 承接", phase: "assign" },
  { key: "advance", label: "PM 按优先级推进", phase: "advance" },
  { key: "assess", label: "技术可行性评估", phase: "assess" },
  { key: "final", label: "PMO 终审", phase: "final" },
];

const FINAL_SHORT: Record<string, string> = { passed: "已通过", passed_with_notes: "有保留通过", returned: "已退回" };

/** 技术可行性评估这一格的副标题:第几轮、什么状态 */
function assessCaption(v: IntakeView): string {
  if (v.round === 0) return v.phase === "assess" ? "等待提交" : "";
  const round = `第 ${v.round} 轮`;
  switch (v.reviewStatus) {
    case "pending":
      return `${round} · 评审中`;
    case "approved":
      // 最近一轮通过了,但之前被终审退回过:承接完成后仍是「已通过」
      return v.finalPending || v.phase === "done" ? `${round} · 已通过` : `${round}被终审退回`;
    case "rejected":
      return `${round} · 已退回修改`;
    case "withdrawn":
      return `${round} · 已撤回`;
    default:
      return round;
  }
}

/** 需求承接的生命周期轨(这一组界面的签名元素):打勾 = 已过,蓝珠 = 当前,灰珠 = 还没到。
 *  管理员没走初级分析、直接指派了 PM 时,「PMO 初级分析」记为跳过(显示 –)。 */
export function IntakeRail({ v, createdAt, pmCount }: { v: IntakeView; createdAt: string; pmCount: number }) {
  const at = RAIL.findIndex((r) => r.phase === v.phase); // 承接完成时为 -1:六个环节都过了
  const finished = at < 0;
  const latest = v.finals[0];
  return (
    <ol className="flex min-w-[640px] items-start" aria-label="需求承接进度">
      {RAIL.map((r, i) => {
        const passed = finished || i < at;
        const current = !finished && i === at;
        // 已经过了初级分析这一环、却没做过初级分析:管理员兜底直接指派了
        const skipped = r.key === "triage" && !v.triageDoneAt && passed;
        const reviewing = r.key === "assess" && v.reviewStatus === "pending";

        let sub = "";
        switch (r.key) {
          case "collected":
            sub = fmtDate(createdAt);
            break;
          case "triage":
            sub = v.triageDoneAt ? `${v.triageByName} · ${fmtDate(v.triageDoneAt)}` : skipped ? "管理员直接指派" : current ? "进行中" : "";
            break;
          case "assign":
            sub = pmCount > 0 ? `${v.leadPmName || "PM"}${pmCount > 1 ? ` 等 ${pmCount} 人` : ""}` : current ? "等 1 名或多名" : "";
            break;
          case "advance":
            sub = passed ? "已完成" : current ? "进行中" : "";
            break;
          case "assess":
            sub = assessCaption(v);
            break;
          case "final":
            // 又一轮评估通过、再次等签署时说「待签署」;上一轮的「已退回」留到退回期间显示
            sub = current ? "待签署" : latest ? FINAL_SHORT[latest.decision] ?? "" : "";
            break;
        }

        return (
          <li key={r.key} className="flex min-w-0 flex-1 flex-col items-center text-center">
            <div className="flex w-full items-center">
              {/* 两侧的连线跟着它连接的环节走:左边跟着上一环(当前环节的上一环一定已过),右边跟着这一环 */}
              <span className={cn("h-[2.5px] flex-1 rounded", i > 0 && (passed || current) ? "bg-[rgba(52,199,89,0.5)]" : "bg-[rgba(120,120,128,0.18)]", i === 0 && "bg-transparent")} />
              <span
                className={stageTone(skipped ? "skipped" : passed ? "approved" : current ? "in_progress" : "pending")}
                role="img"
                aria-label={`${r.label}:${skipped ? "跳过" : passed ? "已完成" : current ? "进行中" : "未开始"}`}
              >
                {passed ? (skipped ? "–" : "✓") : current && reviewing ? "…" : i + 1}
              </span>
              <span className={cn("h-[2.5px] flex-1 rounded", passed ? "bg-[rgba(52,199,89,0.5)]" : "bg-[rgba(120,120,128,0.18)]")} />
            </div>
            <span className={cn("mt-1.5 block px-1 text-xs font-semibold leading-tight", current ? "text-neutral-900" : passed ? "text-[color:var(--ink-2)]" : "text-[color:var(--ink-3)]")}>
              {r.label}
            </span>
            {/* min-h 而不是 h:副标题偶尔折成两行(比如「第 2 轮被终审退回」)时不被裁掉 */}
            <span className="mt-0.5 block min-h-[15px] px-1 text-[10px] leading-tight text-[color:var(--ink-3)]">{sub}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 三条推进线的只读清单(评估、终审、回看时用) */
export function LinesReadonly({ lines, defaultOpen = false }: { lines: IntakeLine[]; defaultOpen?: boolean }) {
  return (
    <div className="grid gap-2">
      {lines.map((line) => (
        <LineReadonly key={line.key} line={line} defaultOpen={defaultOpen} />
      ))}
    </div>
  );
}
