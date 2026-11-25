"use client";

/**
 * 流程:立项时的 As-Is 与当前流程定义(To-Be 工作副本)并排对比,配流程改善指标。
 * 版本快照由关卡自动触发:建项目时 As-Is;G3 通过时 To-Be 基线;G6 通过时已发布。
 */

import { useCallback, useEffect, useState } from "react";
import { Pencil, Waypoints } from "lucide-react";
import { authFetch } from "@/lib/auth";
import type { FlowMetrics, ProcessVersion, ProjectView } from "@/lib/types";
import { fmtDateTime } from "@/lib/labels";
import { FlowGraph, type ChartSource } from "@/components/flow-graph";
import { ChartEditorModal } from "@/components/followup/chart-editor";
import { EditProcessModal } from "@/components/followup/edit-process-modal";
import type { DetailCtx, FlowEditor } from "@/components/projects/project-detail";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<string, string> = { as_is: "As-Is", to_be: "To-Be 基线", published: "已发布" };

interface MetricRow {
  key: keyof FlowMetrics;
  label: string;
  hint: string;
  /** 越少越好(true)/ 越多越好(false)/ 中性(null) */
  lower: boolean | null;
  fmt: (n: number) => string;
}

const ROWS: MetricRow[] = [
  { key: "steps", label: "步骤数", hint: "主步骤 + 会签内部子步骤", lower: true, fmt: (n) => String(n) },
  { key: "offlineShare", label: "线下步骤占比", hint: "线下步骤 / 全部步骤", lower: true, fmt: (n) => `${Math.round(n * 100)}%` },
  { key: "breakpoints", label: "断点数", hint: "线上↔线下衔接 + 相邻线上步骤系统不互通", lower: true, fmt: (n) => String(n) },
  { key: "systems", label: "涉及系统数", hint: "去重后的线上系统", lower: null, fmt: (n) => String(n) },
  { key: "mobileShare", label: "移动端支持率", hint: "支持移动端的线上步骤 / 全部线上步骤", lower: false, fmt: (n) => `${Math.round(n * 100)}%` },
  { key: "countersigns", label: "会签数", hint: "会签步骤个数", lower: null, fmt: (n) => String(n) },
];

/**
 * autoEdit:从页头「修改流程」进来时,标签页一挂载就打开指定的编辑器,用完即清。
 */
export function FlowTab({ ctx, autoEdit = null, onAutoEditDone }: { ctx: DetailCtx; autoEdit?: FlowEditor | null; onAutoEditDone?: () => void }) {
  const { project, process } = ctx;
  const [versions, setVersions] = useState<ProcessVersion[]>([]);
  const [current, setCurrent] = useState<FlowMetrics | null>(null);
  const [view, setView] = useState<ProcessVersion | null>(null); // 左侧展示的版本(默认 As-Is)
  const [editChart, setEditChart] = useState(false);
  const [editForm, setEditForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [vs, cmp] = await Promise.all([
        authFetch<ProcessVersion[]>(`/api/projects/${project.id}/versions`, { cache: "no-store" }),
        authFetch<{ asIs: ProcessVersion | null; current: FlowMetrics }>(`/api/projects/${project.id}/compare`, { cache: "no-store" }),
      ]);
      const list = vs ?? [];
      setVersions(list);
      setCurrent(cmp.current);
      const pick = (list.find((v) => v.kind === "as_is") ?? list[0])?.version;
      if (pick) {
        setView(await authFetch<ProcessVersion>(`/api/projects/${project.id}/versions/${pick}`, { cache: "no-store" }));
      } else {
        setView(null);
      }
    } catch {
      /* 读取失败时保留已有内容 */
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load, process?.updatedAt]);

  const showVersion = async (version: number) => {
    try {
      setView(await authFetch<ProcessVersion>(`/api/projects/${project.id}/versions/${version}`, { cache: "no-store" }));
    } catch {
      /* 忽略 */
    }
  };

  const asIs = versions.find((v) => v.kind === "as_is") ?? null;
  // 节点上的经办人最清楚流程实际怎么走:项目里的 PM / BH / TH、CTO 与管理员都能改(服务端逐请求校验),项目结束后锁定
  const canEdit = project.can.editFlow && project.status !== "done" && project.status !== "cancelled";
  const leftSource: ChartSource | null = view?.steps ? { name: `${KIND_LABEL[view.kind] ?? ""} · v${view.version}`, steps: view.steps } : null;
  const rightSource: ChartSource | null = process ? { name: "当前（To-Be 工作副本）", steps: process.steps } : null;

  useEffect(() => {
    if (!autoEdit || !canEdit || !process) return;
    if (autoEdit === "chart") setEditChart(true);
    else setEditForm(true);
    onAutoEditDone?.();
  }, [autoEdit, canEdit, process, onAutoEditDone]);

  return (
    <div className="grid gap-4">
      {/* 工具行 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-[color:var(--ink-2)]">
          左边是立项时的流程（As-Is），右边是当前的流程定义（To-Be 工作副本）。
          {snapshotNote(project)}
        </div>
        {process && (
          <button type="button" onClick={() => ctx.setFlowChartOpen(true)} className="btn btn-glass !h-9 !px-3.5 text-[13px]">
            <Waypoints className="h-3.5 w-3.5" /> 大图查看当前流程
          </button>
        )}
        {canEdit && process && (
          <>
            <button type="button" onClick={() => setEditForm(true)} className="btn btn-glass !h-9 !px-3.5 text-[13px]">
              <Pencil className="h-3.5 w-3.5" /> 编辑表单
            </button>
            <button type="button" onClick={() => setEditChart(true)} className="btn btn-primary !h-9 !px-3.5 text-[13px]">
              <Pencil className="h-3.5 w-3.5" /> 编辑流程图
            </button>
          </>
        )}
      </div>

      {/* 版本时间线 */}
      {versions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white/45 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
          <span className="text-xs text-[color:var(--ink-2)]">版本</span>
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => void showVersion(v.version)}
              aria-pressed={view?.version === v.version}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition",
                view?.version === v.version ? "bg-white/90 text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,1),0_3px_10px_-5px_rgba(23,42,80,0.25)]" : "text-[color:var(--ink-2)] hover:bg-white/60",
              )}
            >
              <span className={cn("size-1.5 rounded-full", v.kind === "as_is" ? "bg-[color:var(--green)]" : v.kind === "to_be" ? "bg-[color:var(--tint)]" : "bg-[color:var(--indigo)]")} />
              v{v.version} · {KIND_LABEL[v.kind] ?? v.kind}
              <span className="font-data text-[10px] font-normal text-[color:var(--ink-3)]">{fmtDateTime(v.createdAt)}</span>
            </button>
          ))}
          <span className="ml-auto hidden text-[11px] text-[color:var(--ink-3)] sm:block">点版本可在左侧查看当时的流程</span>
        </div>
      )}

      {/* 指标对比 */}
      {asIs && current && (
        <section className="glass-card p-5">
          <h2 className="text-[15px] font-semibold text-neutral-900">流程改善指标</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-xs text-[color:var(--ink-3)]">
                  <th className="pb-2 pr-4 font-medium">指标</th>
                  <th className="pb-2 pr-4 text-right font-medium">立项时（As-Is）</th>
                  <th className="pb-2 pr-4 text-right font-medium">当前（To-Be）</th>
                  <th className="pb-2 text-right font-medium">变化</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const a = Number(asIs.metrics[r.key] ?? 0);
                  const b = Number(current[r.key] ?? 0);
                  const d = b - a;
                  const better = r.lower === null ? null : r.lower ? d < 0 : d > 0;
                  return (
                    <tr key={r.key} className="border-t border-[color:var(--sep)]">
                      <td className="py-2.5 pr-4">
                        <span className="font-medium text-neutral-900">{r.label}</span>
                        <span className="block text-[11px] text-[color:var(--ink-3)]">{r.hint}</span>
                      </td>
                      <td className="font-data py-2.5 pr-4 text-right tabular-nums text-[color:var(--ink-2)]">{r.fmt(a)}</td>
                      <td className="font-data py-2.5 pr-4 text-right font-semibold tabular-nums text-neutral-900">{r.fmt(b)}</td>
                      <td className={cn("font-data py-2.5 text-right font-semibold tabular-nums", better === null ? "text-[color:var(--ink-3)]" : better ? "text-[color:var(--green-deep)]" : d === 0 ? "text-[color:var(--ink-3)]" : "text-[color:var(--red-deep)]")}>
                        {d === 0 ? "—" : `${d > 0 ? "+" : ""}${r.key === "offlineShare" || r.key === "mobileShare" ? `${Math.round(d * 100)}%` : d}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[color:var(--ink-3)]">
            断点与流程图里的虚线同口径：每减少一个断点，就少一次线下跑动或一次跨系统重复录入。
          </p>
        </section>
      )}

      {/* 并排流程图 */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartPane
          title={view ? `${KIND_LABEL[view.kind] ?? "版本"} · v${view.version}` : "立项时 · As-Is"}
          subtitle={view ? fmtDateTime(view.createdAt) : "还没有快照"}
          source={leftSource}
        />
        <ChartPane
          title="当前 · To-Be 工作副本"
          subtitle={canEdit ? "可直接修改，保存后立即反映在这里" : "只读 · 加入项目成员（PM / BH / TH）后可以修改"}
          source={rightSource}
          highlight
        />
      </div>

      {process && (
        <>
          {editForm && (
            <EditProcessModal
              process={process}
              onClose={() => setEditForm(false)}
              onSaved={() => {
                setEditForm(false);
                void ctx.refresh().then(load);
              }}
            />
          )}
          {editChart && (
            <ChartEditorModal
              process={process}
              onClose={() => setEditChart(false)}
              onSaved={() => {
                setEditChart(false);
                // 成功提示由编辑器自己弹,这里只负责刷新
                void ctx.refresh().then(load);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 哪两个关卡通过时会留版本快照:取项目自己的模板(后台可以改关卡名,所以不能写死 G3 / G6) */
function snapshotNote(project: ProjectView): string {
  const gateOf = (key: string) => project.stages.find((s) => s.key === key)?.gate;
  const design = gateOf("design");
  const accept = gateOf("accept");
  if (design && accept) return `${design}通过时留存 To-Be 基线，${accept}通过时留存已发布版本。`;
  if (design) return `${design}通过时留存 To-Be 基线。`;
  if (accept) return `${accept}通过时留存已发布版本。`;
  return "";
}

function ChartPane({ title, subtitle, source, highlight }: { title: string; subtitle: string; source: ChartSource | null; highlight?: boolean }) {
  return (
    <section className={cn("glass-card p-3", highlight && "shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_1.5px_rgba(0,113,227,0.28),0_28px_64px_-28px_rgba(23,42,80,0.28)]")}>
      <h3 className="flex items-baseline gap-2 px-2 pt-1 text-[14px] font-semibold text-neutral-900">
        {title}
        <span className="text-xs font-normal text-[color:var(--ink-3)]">{subtitle}</span>
      </h3>
      <div className="mt-2">
        {source ? (
          <FlowGraph source={source} height="clamp(320px, 52vh, 560px)" />
        ) : (
          <p className="grid h-[320px] place-items-center text-sm text-[color:var(--ink-3)]">暂无流程定义</p>
        )}
      </div>
    </section>
  );
}
