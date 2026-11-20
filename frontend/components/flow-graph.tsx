"use client";

/**
 * 流程图渲染：React Flow（@xyflow/react）确定性布局。
 * 会签步骤 = 一个容器节点，各方及其子流程收纳在节点内部（并行列布局）；
 * 节点按线上/线下/移动端支持着色，前置依赖为琥珀虚线边。
 */

import { useMemo } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import type { FlowStep } from "@/lib/types";

export interface ChartSource {
  name: string;
  steps: FlowStep[];
}

/* ---------- 布局常量 ---------- */
const STEP_W = 236;
const STEP_H = 92;
const PARTY_COL_W = 252;
const CAP_W = 190;
const CAP_H = 44;
const ROW_H = 140;

/* ---------- 节点组件 ---------- */

function ModeBadges({
  mode,
  mobile,
}: {
  mode: "online" | "offline";
  mobile: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {mode === "online" ? (
        <span className="rounded-full bg-sky-400/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          线上
        </span>
      ) : (
        <span className="rounded-full bg-emerald-400/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
          线下
        </span>
      )}
      {mode === "online" && mobile && (
        <span className="rounded-full bg-sky-400/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          支持移动端
        </span>
      )}
    </div>
  );
}

/** 会签内部子流程行：模式着色圆点 + 名称 + 紧凑徽章 */
function SubStepRow({
  index,
  name,
  mode,
  mobile,
  system,
  docs,
  handlerDepts,
}: {
  index: number;
  name: string;
  mode: "online" | "offline";
  mobile: boolean;
  system?: string;
  docs?: string[];
  handlerDepts?: string[];
}) {
  const tone =
    mode === "offline"
      ? { bar: "bg-emerald-400", ring: "border-l-4 border-l-emerald-400/70 bg-emerald-500/10" }
      : { bar: "bg-sky-400", ring: "border-l-4 border-l-sky-400/70 bg-sky-500/10" };
  return (
    <div className={cn("rounded-lg border border-white/10 px-2 py-1.5", tone.ring)}>
      <div className="flex items-center gap-1.5 text-xs text-white">
        <span className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", tone.bar)} />
        <span className="text-amber-300/80">{index + 1}.</span>
        {name}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-3 text-[10px]">
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-medium",
            mode === "offline"
              ? "bg-emerald-400/20 text-emerald-300"
              : "bg-sky-400/20 text-sky-300",
          )}
        >
          {mode === "offline" ? "线下" : "线上"}
        </span>
        {mode === "online" && system ? (
          <span className="text-neutral-400">{system}</span>
        ) : null}
        {mode === "online" && mobile ? (
          <span className="rounded-full bg-teal-400/20 px-1.5 py-0.5 text-teal-300">
            支持移动端
          </span>
        ) : null}
        {mode === "offline" && docs?.length ? (
          <span className="text-neutral-400">文件：{docs.join("、")}</span>
        ) : null}
        {mode === "offline" && handlerDepts?.length ? (
          <span className="text-neutral-400">办理：{handlerDepts.join("、")}</span>
        ) : null}
      </div>
    </div>
  );
}

function StepNode({ data }: NodeProps) {
  const d = data as {
    title: string;
    seq?: number;
    countersign?: boolean;
    mode?: "online" | "offline";
    mobile?: boolean;
    tail?: string;
    parties?: {
      dept: string;
      staff?: string[];
      subs: {
        name: string;
        mode: "online" | "offline";
        mobile: boolean;
        system?: string;
        docs?: string[];
        handlerDepts?: string[];
      }[];
    }[];
  };

  // 高辨识度配色：蓝=线上 · 亮青=线上支持移动端 · 绿=线下 · 琥珀=会签
  const skin = d.countersign
    ? { border: "border-2 border-amber-400/90", bg: "bg-amber-500/25", accent: "bg-amber-400" }
    : d.mode === "offline"
      ? { border: "border-2 border-emerald-400/90", bg: "bg-emerald-500/30", accent: "bg-emerald-400" }
      : { border: "border-2 border-sky-400/90", bg: "bg-sky-500/30", accent: "bg-sky-400" };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border-2 px-4 py-3 pl-5 backdrop-blur-md shadow-[0_6px_24px_-10px_rgba(0,0,0,0.7)]",
        skin.border,
        skin.bg,
      )}
    >
      {/* 左侧实心色条：缩略状态下也能一眼区分办理方式 */}
      <span className={cn("absolute inset-y-0 left-0 w-1.5", skin.accent)} />
      {/* 头部：序号 + 名称 + 会签徽章 */}
      <div className="flex items-center gap-2">
        {d.seq != null && (
          <span
            className={cn(
              "font-data flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
              d.countersign
                ? "border-amber-400/50 bg-amber-400/15 text-amber-300"
                : "border-white/30 bg-white/10 text-white/80",
            )}
          >
            {d.seq}
          </span>
        )}
        <span className="text-sm font-medium text-white">{d.title}</span>
        {d.countersign && (
          <span className="ml-auto rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
            会签 · 多方并行
          </span>
        )}
      </div>

      {/* 普通步骤：模式徽章 + 摘要 */}
      {!d.countersign && (
        <>
          <ModeBadges mode={d.mode ?? "online"} mobile={!!d.mobile} />
          {d.tail ? (
            <div className="mt-1 text-[10px] leading-relaxed text-neutral-400">{d.tail}</div>
          ) : null}
        </>
      )}

      {/* 会签：各方并列列布局，子流程收纳在节点内 */}
      {d.countersign && d.parties?.length ? (
        <div className="mt-3 flex items-start gap-3">
          {d.parties.map((party, j) => (
            <div
              key={j}
              className="min-w-0 flex-1 rounded-lg border border-amber-300/25 bg-black/25 p-2"
            >
              <div className="text-xs font-semibold text-amber-100">{party.dept}</div>
              {party.staff?.length ? (
                <div className="mt-0.5 text-[10px] text-amber-200/60">
                  {party.staff.join("、")}
                </div>
              ) : null}
              <div className="mt-1.5 space-y-1.5">
                {party.subs.map((s, k) => (
                  <SubStepRow
                    key={k}
                    index={k}
                    name={s.name}
                    mode={s.mode}
                    mobile={s.mobile}
                    system={s.system}
                    docs={s.docs}
                    handlerDepts={s.handlerDepts}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {d.countersign && !d.parties?.length && (
        <p className="mt-2 text-xs text-amber-200/50">未配置会签方</p>
      )}

      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}

function CapNode({ data }: NodeProps) {
  const d = data as { title: string };
  return (
    <div className="rounded-full border border-white/25 bg-white/10 px-5 py-2 text-sm text-white/90 backdrop-blur-md">
      {d.title}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}

const nodeTypes = {
  step: StepNode,
  cap: CapNode,
};

/* ---------- 图构建 ---------- */

type FlowNodeDatum = Node<Record<string, unknown>>;

interface Built {
  nodes: FlowNodeDatum[];
  edges: Edge[];
}

function buildGraph(p: ChartSource): Built {
  const nodes: FlowNodeDatum[] = [];
  const edges: Edge[] = [];

  const addNode = (
    id: string,
    type: "step" | "cap",
    x: number,
    y: number,
    data: Record<string, unknown>,
    w: number,
    h: number,
  ) => {
    nodes.push({ id, type, position: { x: x - w / 2, y }, data });
    return { w, h };
  };

  /** 节点办理模式：跨「线上↔线下」的顺序连线转为虚线 */
  const modes = new Map<string, "online" | "offline" | "mixed">();

  /** 纵向布局游标：会签容器高度随内容变化，逐节点累计 */
  let cursorY = CAP_H;

  const plainEdge = (source: string, target: string) => {
    const a = modes.get(source);
    const b = modes.get(target);
    const crossing = !!a && !!b && a !== "mixed" && b !== "mixed" && a !== b;
    edges.push({
      id: `e-${source}-${target}`,
      source,
      target,
      type: "smoothstep",
      style: crossing
        ? {
            stroke: "rgba(255,255,255,0.55)",
            strokeWidth: 1.5,
            strokeDasharray: "6 4",
          }
        : { stroke: "rgba(255,255,255,0.35)", strokeWidth: 1.5 },
    });
  };

  addNode("START", "cap", 0, 0, { title: `${p.name || "流程"} · 开始` }, CAP_W, CAP_H);

  const last = p.steps.length - 1;

  p.steps.forEach((step, i) => {
    const sid = `S${i}`;
    const y = cursorY + 76;

    if (step.countersign) {
      // 会签步骤：单容器节点，各方并列收纳在节点内部
      const parties = step.parties.filter(
        (pt) => pt.department || pt.staff.length || (pt.subSteps ?? []).some((s) => s?.name),
      );
      const partyData = parties.map((pt) => ({
        dept: pt.department || "未命名部门",
        staff: pt.staff ?? [],
        subs: (pt.subSteps ?? [])
          .filter((s) => s?.name)
          .map((s) => ({
            name: s.name ?? "",
            mode: (s.mode ?? "online") as "online" | "offline",
            mobile: s.online?.mobileSupported ?? false,
            system: s.online?.systemName ?? "",
            docs: s.mode === "offline" ? (s.offline?.documents ?? []) : [],
            handlerDepts:
              s.mode === "offline"
                ? (s.offline?.handlers ?? [])
                    .map((h) => h.department)
                    .filter(Boolean)
                : [],
          })),
      }));
      const maxLen = Math.max(1, ...partyData.map((pt) => Math.max(pt.subs.length, 1)));
      const w = 24 + partyData.length * PARTY_COL_W;
      const h = 96 + maxLen * 58;
      addNode(
        sid,
        "step",
        0,
        y,
        {
          title: step.name || "(未命名)",
          seq: i + 1,
          countersign: true,
          parties: partyData,
        },
        w,
        h,
      );
      modes.set(sid, "mixed");
      cursorY = y + h;
    } else {
      addNode(
        sid,
        "step",
        0,
        y,
        {
          title: step.name || "(未命名)",
          seq: i + 1,
          mode: step.mode,
          mobile: step.online?.mobileSupported ?? false,
          tail: [
            step.mode === "online" && step.online?.systemName ? step.online.systemName : "",
            step.mode === "offline" && step.offline?.documents?.length
              ? `文件：${step.offline.documents.join("、")}`
              : "",
            step.mode === "offline" && step.offline?.handlers?.length
              ? `办理：${step.offline.handlers
                  .map((h) => h.department)
                  .filter(Boolean)
                  .join("、")}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        },
        STEP_W,
        STEP_H,
      );
      modes.set(sid, step.mode);
      cursorY = y + STEP_H;
    }

    plainEdge(i === 0 ? "START" : `S${i - 1}`, sid);

    // 前置会签依赖：琥珀虚线边「需等待某会签通过」
    const w = step.waitFor;
    if (w?.stepId) {
      const d = p.steps.findIndex((s) => s.id === w.stepId);
      if (d >= 0 && d < i && p.steps[d].countersign) {
        const dep = p.steps[d];
        const label = w.partyId
          ? `「${
              (dep.parties ?? []).find((x) => x.id === w.partyId)?.department || "会签方"
            }」分支通过后执行`
          : `「${dep.name || "未命名"}」会签通过后执行`;
        edges.push({
          id: `w-${w.stepId}-${sid}`,
          source: `S${d}`,
          target: sid,
          type: "smoothstep",
          label,
          labelShowBg: true,
          labelBgStyle: { fill: "#0b1220", fillOpacity: 0.9 },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 6,
          style: { stroke: "#fbbf24", strokeWidth: 1.5, strokeDasharray: "6 4" },
        });
      }
    }
  });

  const endY = cursorY + 76;
  addNode("END", "cap", 0, endY, { title: "结束" }, CAP_W, CAP_H);
  plainEdge(`S${last}`, "END");

  return { nodes, edges };
}

/* ---------- 渲染 ---------- */

export function FlowGraph({ source }: { source: ChartSource }) {
  const { nodes, edges } = useMemo(() => buildGraph(source), [source]);

  return (
    <div className="h-[440px] w-full overflow-hidden rounded-xl border border-white/10 bg-black/40 md:h-[520px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        zoomOnPinch={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(255,255,255,0.04)" gap={18} size={1.4} />
      </ReactFlow>
    </div>
  );
}
