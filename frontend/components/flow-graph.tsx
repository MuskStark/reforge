"use client";

/**
 * 流程图渲染:React Flow(@xyflow/react)确定性布局(正交连线)。
 *
 * 布局规则(对齐方式与参考样式一致):
 *   - 主干节点(开始/普通步骤/结束)严格垂直中轴对齐,等距排布
 *   - 会签 = 主干右侧的旁路子流程容器(大圆角框,左上角标题「会签 · N 方并行」):
 *       主干线段中部 ● 分支点 ──直角折线──▶ 容器顶边
 *       容器底边 ──直角折线──▶ 主干线段中部 ● 汇合点 ──▶ 下一步
 *   - 容器内各会签方为并列泳道(并行办理),泳道内部子步骤纵向串联
 *
 * 前置会签依赖(谁需要会签结果):
 *   - 目标节点带靛蓝「等待会签」门控徽章
 *   - 等待整个会签:依赖虚线从容器右缘指出;仅等某会签方:从该方泳道右缘指出
 *   - 直连后继(会签紧邻的下一步)由主干汇合线自然表达,不加多余虚线
 *
 * 连线线型(主干 / 旁路 / 泳道内箭头一致):
 *   - 两端办理方式为「线上↔线下」衔接(会签取整体办理方式,「线上+线下」视为衔接)→ 虚线
 *   - 目标端已标注「与上一步系统数据不互通」→ 虚线
 *   - 其余实线
 */

import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  countersignMode,
  interopSystems,
  subInteropPrev,
  subLinkBroken,
  type OverallMode,
} from "@/lib/step-checks";
import { CountersignModeBadge } from "@/components/countersign-mode-badge";
import type { FlowStep } from "@/lib/types";

export interface ChartSource {
  name: string;
  steps: FlowStep[];
}

/* ---------- 布局常量 ---------- */
const STEP_W = 236;
const STEP_H = 92;
const CAP_W = 190;
const CAP_H = 44;
const GATE_EXTRA_H = 30; // 带门控徽章的步骤增高
const MAIN_GAP = 96; // 主干相邻节点间距(统一节奏)

const LANE_W = 244;
const LANE_GAP = 20;
const BOX_X = 356; // 容器左缘(主干中轴右侧)
const BOX_PAD_X = 18;
const BOX_TITLE_H = 44;
const BOX_PAD_BOTTOM = 20;

const SPAN_MARGIN = 56; // 旁路区上下留白(容器与前后主干节点)
const CHAIN_GAP = 44; // 连续多个会签容器串联间距
const BYPASS_COLOR = "#e8890c"; // 旁路琥珀线

const EDGE_COLOR = "#8a97ab";
const GATE_COLOR = "#5856d6";
const DASH = "6 4"; // 断点连线(线上↔线下衔接 / 系统数据不互通)

/* ---------- 通用样式 ---------- */
const HIDDEN_HANDLE = "!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0";

function VHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={HIDDEN_HANDLE} />
    </>
  );
}

/** 右侧隐藏锚点:旁路(出/入)与前置依赖边专用 */
function RightHandle({ mode }: { mode: "source" | "target" }) {
  return mode === "source" ? (
    <Handle type="source" id="r" position={Position.Right} isConnectable={false} className={HIDDEN_HANDLE} />
  ) : (
    <Handle type="target" id="r" position={Position.Right} isConnectable={false} className={HIDDEN_HANDLE} />
  );
}

/** 右侧隐藏「发出」锚点:主干节点向旁路容器分出(rs) */
function RightSourceHandle() {
  return (
    <Handle type="source" id="rs" position={Position.Right} isConnectable={false} className={HIDDEN_HANDLE} />
  );
}

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
        <span className="rounded-full bg-[color:var(--tint-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--tint-deep)]">
          线上
        </span>
      ) : (
        <span className="rounded-full bg-[color:var(--green-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--green-deep)]">
          线下
        </span>
      )}
      {mode === "online" && mobile && (
        <span className="rounded-full bg-[color:var(--tint-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--tint-deep)]">
          支持移动端
        </span>
      )}
      {mode === "online" && mobile === false && (
        <span className="rounded-full bg-[rgba(120,120,128,0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--ink-2)]">
          不支持移动端
        </span>
      )}
    </div>
  );
}

/** 普通步骤节点:白玻璃 + 语义色描边 + 可选「等待会签」门控徽章 */
function StepNode({ data }: NodeProps) {
  const d = data as {
    title: string;
    seq?: number;
    mode?: "online" | "offline";
    mobile?: boolean;
    tail?: string;
    gate?: string;
    selected?: boolean;
  };

  const skin =
    d.mode === "offline"
      ? { border: "border-2 border-[#34c759]/85", bg: "bg-white/90", accent: "bg-[#34c759]" }
      : { border: "border-2 border-[#007aff]/85", bg: "bg-white/90", accent: "bg-[#007aff]" };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border-2 px-4 py-3 pl-5",
        d.selected ? "border-[#0071e3] shadow-[0_0_0_5px_rgba(0,113,227,0.18),0_8px_24px_-8px_rgba(0,113,227,0.5)]" : "shadow-[0_6px_24px_-10px_rgba(23,42,80,0.35)]",
        d.selected ? undefined : skin.border,
        skin.bg,
      )}
      style={{ width: STEP_W }}
    >
      {d.selected && (
        <>
          <span className="pointer-events-none absolute -inset-[7px] rounded-[20px] border-[1.4px] border-dashed border-[#0071e3]/60" aria-hidden="true" />
          <span className="absolute -top-[9px] left-1/2 z-10 -translate-x-1/2 rounded-full bg-[#0071e3] px-2.5 py-[3px] text-[10px] font-bold text-white shadow-md">✓ 已选中</span>
        </>
      )}
      <span className={cn("absolute inset-y-0 left-0 w-1.5", skin.accent)} />
      <div className="flex items-center gap-2">
        {d.seq != null && (
          <span className="font-data flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-black/10 bg-[rgba(120,120,128,0.1)] text-xs font-bold text-neutral-700">
            {d.seq}
          </span>
        )}
        <span className="truncate text-sm font-semibold text-neutral-900">{d.title}</span>
      </div>

      <ModeBadges mode={d.mode ?? "online"} mobile={!!d.mobile} />
      {d.tail ? (
        <div className="mt-1 text-[10px] leading-relaxed text-[color:var(--ink-2)]">{d.tail}</div>
      ) : null}

      {d.gate && (
        <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-[color:var(--indigo-soft)] px-2.5 py-1 text-[11px] font-bold text-[color:var(--indigo-deep)] shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.3)]">
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3.5h12v5a6 6 0 0 1-3.6 5.5L13.5 15h-3l-.9-1A6 6 0 0 1 6 8.5z" />
            <path d="M6 3.5 4.5 8 6 9M18 3.5 19.5 8 18 9M12 15v2.5M9 21h6" />
          </svg>
          <span className="truncate">{d.gate}</span>
        </div>
      )}
      <VHandles />
      <RightHandle mode="target" />
      <RightSourceHandle />
    </div>
  );
}

/** 会签内部子流程行 */
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
      ? { bar: "bg-[#34c759]", ring: "border-l-4 border-l-[#34c759]/80 bg-[rgba(52,199,89,0.08)]" }
      : { bar: "bg-[#007aff]", ring: "border-l-4 border-l-[#007aff]/80 bg-[rgba(0,122,255,0.06)]" };
  return (
    <div className={cn("rounded-lg border border-black/5 bg-white/90 px-2 py-1.5 shadow-[0_1px_4px_-2px_rgba(23,42,80,0.18)]", tone.ring)}>
      <div className="flex items-center gap-1.5 text-xs text-neutral-900">
        <span className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", tone.bar)} />
        <span className="text-[color:var(--amber-deep)]">{index + 1}.</span>
        <span className="truncate">{name}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-3 text-[10px]">
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-semibold",
            mode === "offline"
              ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]"
              : "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
          )}
        >
          {mode === "offline" ? "线下" : "线上"}
        </span>
        {mode === "online" && system ? (
          <span className="text-[color:var(--ink-2)]">{system}</span>
        ) : null}
        {mode === "online" && mobile ? (
          <span className="rounded-full bg-[color:var(--tint-soft)] px-1.5 py-0.5 text-[color:var(--tint-deep)]">
            支持移动端
          </span>
        ) : null}
        {mode === "offline" && docs?.length ? (
          <span className="text-[color:var(--ink-2)]">文件:{docs.join("、")}</span>
        ) : null}
        {mode === "offline" && handlerDepts?.length ? (
          <span className="text-[color:var(--ink-2)]">办理:{handlerDepts.join("、")}</span>
        ) : null}
      </div>
    </div>
  );
}

/** 会签方泳道:一方一条并行分支(容器内并列),内部子步骤纵向串联 */
function PartyNode({ data }: NodeProps) {
  const d = data as {
    dept: string;
    staff?: string[];
    subs: {
      name: string;
      mode: "online" | "offline";
      mobile: boolean;
      system?: string;
      docs?: string[];
      handlerDepts?: string[];
      /** 与上一子步骤的衔接为断点(线上↔线下 / 系统不互通):箭头转虚线 */
      broken?: boolean;
    }[];
  };
  return (
    <div
      className="rounded-xl border border-[#ff9500]/40 bg-[rgba(255,255,255,0.72)] px-2 pb-2 pt-1.5 shadow-[0_2px_8px_-4px_rgba(154,98,0,0.3)]"
      style={{ width: LANE_W }}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1">
        <span className="grid h-4 w-4 shrink-0 rotate-45 place-items-center rounded-[5px] bg-[color:var(--amber-soft)]" aria-hidden="true">
          <span className="-rotate-45 text-[8px] font-bold leading-none text-[color:var(--amber-deep)]">✓</span>
        </span>
        <span className="truncate text-[11px] font-bold text-[color:var(--amber-deep)]">{d.dept}</span>
        {d.staff?.length ? (
          <span className="ml-auto shrink-0 text-[9px] text-[color:var(--ink-2)]">{d.staff.join("、")}</span>
        ) : null}
      </div>

      {d.subs.length === 0 ? (
        <p className="flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#ff9500]/35 bg-white/70 px-2 py-2 text-center text-[11px] font-semibold text-[color:var(--amber-deep)]">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
          单步签署
        </p>
      ) : (
        <div>
          {d.subs.map((s, k) => (
            <div key={k}>
              {k > 0 && (
                /* 子步骤衔接箭头:杆身断点转虚线,箭头头部保持实线(泳道是浅底,断点用深灰保证可辨) */
                <div className="flex flex-col items-center" aria-hidden="true">
                  <svg className={cn("h-4 w-4 text-[#ff9500]/70", s.broken && "text-[#5b6475]")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v12" strokeDasharray={s.broken ? "4 3" : undefined} />
                    <path d="M6 12l6 6 6-6" />
                  </svg>
                </div>
              )}
              <SubStepRow
                index={k}
                name={s.name}
                mode={s.mode}
                mobile={s.mobile}
                system={s.system}
                docs={s.docs}
                handlerDepts={s.handlerDepts}
              />
            </div>
          ))}
        </div>
      )}
      {/* 右缘锚点:仅等某会签方分支的门控边使用 */}
      <RightHandle mode="source" />
    </div>
  );
}

/** 会签旁路容器:大圆角框 + 左上角标题(各方泳道作为独立节点置于框内) */
function CsBoxNode({ data }: NodeProps) {
  const d = data as {
    title: string;
    partyCount: number;
    width: number;
    height: number;
    empty?: boolean;
    selected?: boolean;
    /** 整体办理方式(由各方内部子步骤汇总) */
    mode: OverallMode;
  };
  return (
    <div
      className={cn(
        "rounded-[28px] border-2 border-[#ff9500]/55 bg-[linear-gradient(180deg,rgba(255,248,236,0.55),rgba(255,243,224,0.35))] shadow-[0_10px_36px_-16px_rgba(154,98,0,0.4),inset_0_1px_0_rgba(255,255,255,0.85)]",
        d.selected && "border-[#0071e3] shadow-[0_0_0_5px_rgba(0,113,227,0.18),0_12px_36px_-12px_rgba(0,113,227,0.45)]",
      )}
      style={{ width: d.width, height: d.height }}
    >
      {/* 左上角标题(与参考样式一致) + 整体办理方式标识 */}
      <div className="flex items-center gap-2 px-5 pt-3.5">
        <span className="grid h-5 w-5 shrink-0 rotate-45 place-items-center rounded-[6px] bg-[color:var(--amber)] shadow-[0_2px_6px_-2px_rgba(154,98,0,0.6)]" aria-hidden="true">
          <span className="-rotate-45 text-[9px] font-bold leading-none text-white">✓</span>
        </span>
        <span className="min-w-0 truncate text-[13px] font-bold text-[color:var(--amber-deep)]">{d.title}</span>
        <span className="shrink-0 text-[11px] font-medium text-[color:var(--ink-2)]">
          {d.partyCount > 0 ? `${d.partyCount} 方并行 · 全部通过` : "未配置会签方"}
        </span>
        <CountersignModeBadge mode={d.mode} className="shrink-0" />
      </div>
      {/* 顶边入 / 底边出 / 右缘门控 */}
      <Handle type="target" position={Position.Top} isConnectable={false} className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={HIDDEN_HANDLE} />
      <RightHandle mode="source" />
    </div>
  );
}

function CapNode({ data }: NodeProps) {
  const d = data as { title: string };
  return (
    <div
      className="rounded-full bg-[#1d1d1f] px-5 py-2 text-center text-sm font-semibold text-white shadow-[0_6px_20px_-8px_rgba(29,29,31,0.6)]"
      style={{ width: CAP_W }}
    >
      {d.title}
      <VHandles />
      <RightSourceHandle />
    </div>
  );
}

const nodeTypes = {
  step: StepNode,
  party: PartyNode,
  csbox: CsBoxNode,
  cap: CapNode,
};

/* ---------- 图构建 ---------- */

type FlowNodeDatum = Node<Record<string, unknown>>;

interface Built {
  nodes: FlowNodeDatum[];
  edges: Edge[];
}

/** 会签步骤在图中展开出的节点组(依赖边需精确指向其产出点) */
interface CountersignNodes {
  boxId: string;
  laneIdByPartyId: Map<string, string>;
}

function buildGraph(
  p: ChartSource,
  csNodes: Map<string, CountersignNodes>,
  selectedIdx = -1,
): Built {
  const nodes: FlowNodeDatum[] = [];
  const edges: Edge[] = [];

  const addNode = (
    id: string,
    type: "step" | "cap" | "csbox" | "party",
    x: number,
    y: number,
    data: Record<string, unknown>,
  ) => {
    nodes.push({ id, type, position: { x, y }, data });
  };

  /** 节点办理方式(开始/结束为 unknown):跨「线上↔线下」的顺序连线转虚线 */
  const modes = new Map<string, OverallMode>();

  /** 两端为「线上↔线下」衔接(会签整体为「线上+线下」时同样视为衔接) */
  const crosses = (source: string, target: string) => {
    const a = modes.get(source);
    const b = modes.get(target);
    if (!a || !b || a === "unknown" || b === "unknown") return false;
    return a !== b || a === "mixed";
  };

  /** 主步骤 i 已明确标注「与上一步系统数据不互通」(仅当该问题成立,即前置系统确有不同) */
  const markedNotInterop = (i: number) => {
    const s = p.steps[i];
    return s.online?.dataInteroperable === false && interopSystems(s, p.steps[i - 1]).length > 0;
  };

  /** 正交主干/分支连线(直角折线 + 实心箭头);dashed = 线上↔线下衔接 / 系统数据不互通 */
  const orthEdge = (
    source: string,
    target: string,
    o?: {
      sourceHandle?: string;
      targetHandle?: string;
      color?: string;
      width?: number;
      dashed?: boolean;
    },
  ) => {
    const color = o?.color ?? EDGE_COLOR;
    edges.push({
      id: `e-${source}${o?.sourceHandle ?? ""}-${target}${o?.targetHandle ?? ""}`,
      source,
      target,
      sourceHandle: o?.sourceHandle,
      targetHandle: o?.targetHandle,
      type: "step",
      style: { stroke: color, strokeWidth: o?.width ?? 1.6, ...(o?.dashed ? { strokeDasharray: DASH } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    });
  };

  /** 前置会签依赖边(靛蓝虚线 + 标签):从容器/泳道右缘水平引出,进入目标右缘 */
  const gateEdge = (source: string, target: string, label: string, sourceHandle?: string) => {
    edges.push({
      id: `w-${source}${sourceHandle ?? ""}-${target}`,
      source,
      target,
      sourceHandle,
      targetHandle: "r",
      type: "step",
      label,
      labelShowBg: true,
      labelBgStyle: { fill: "#f0f0ff", fillOpacity: 0.95, stroke: "rgba(88,86,214,0.35)", strokeWidth: 0.5 },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 6,
      labelStyle: { fill: "#4644c8", fontSize: 11, fontWeight: 600 },
      style: { stroke: GATE_COLOR, strokeWidth: 1.8, strokeDasharray: DASH },
      markerEnd: { type: MarkerType.ArrowClosed, color: GATE_COLOR, width: 16, height: 16 },
    });
  };

  let cursorY = CAP_H; // 主干游标(最近一个主干元素的底边)
  let prevNode = "START"; // 最近主干节点(旁路从它的右缘分出)
  const pendingCs: number[] = []; // 当前主干跨段内待挂载的会签(连续会签串联)
  const directCsStepIdx = new Set<number>(); // 本跨段直连的会签(其结果由旁路线自然送达到下一主干节点)

  addNode("START", "cap", -CAP_W / 2, 0, { title: `${p.name || "流程"} · 开始` });
  modes.set("START", "unknown");

  /** 把跨段内积累的会签容器挂载到 [上一主干节点 → 下一主干节点] 之间,返回所需跨段高度;
   *  nextIdx 为下一主干步骤下标(末尾跨段挂到 END 时缺省) */
  const flushCs = (nextMainId: string, nextIdx?: number): number => {
    if (pendingCs.length === 0) return MAIN_GAP;

    const boxes = pendingCs.map((i) => {
      const step = p.steps[i];
      const parties = step.parties.filter(
        (pt) => pt.department || pt.staff.length || (pt.subSteps ?? []).some((s) => s?.name),
      );
      const laneData = parties.map((pt) => {
        const named = (pt.subSteps ?? []).filter((s) => s?.name);
        return {
          partyId: pt.id,
          dept: pt.department || "未命名部门",
          staff: pt.staff ?? [],
          subs: named.map((s, k) => ({
            name: s.name ?? "",
            mode: (s.mode === "offline" ? "offline" : "online") as "online" | "offline",
            mobile: s.online?.mobileSupported ?? false,
            // 互通结论仅在与上一子步骤系统不同(该问题成立)时展示
            system: [
              s.online?.systemName ?? "",
              subInteropPrev(named, k) && s.online?.dataInteroperable != null
                ? s.online.dataInteroperable
                  ? "与上步互通"
                  : "与上步不互通"
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
            docs: s.mode === "offline" ? (s.offline?.documents ?? []) : [],
            handlerDepts:
              s.mode === "offline"
                ? (s.offline?.handlers ?? []).map((h) => h.department).filter(Boolean)
                : [],
            broken: k > 0 && subLinkBroken(named[k - 1], s),
          })),
        };
      });
      const laneH = (n: number) => 26 + n * 52 + Math.max(0, n - 1) * 17 + 10;
      const maxLaneH = Math.max(80, ...laneData.map((l) => laneH(l.subs.length)));
      const boxW =
        parties.length === 0
          ? 300
          : BOX_PAD_X * 2 + parties.length * LANE_W + (parties.length - 1) * LANE_GAP;
      const boxH = BOX_TITLE_H + (parties.length === 0 ? 44 : maxLaneH) + BOX_PAD_BOTTOM;
      return { idx: i, step, parties, laneData, boxW, boxH, mode: countersignMode(step) };
    });

    const totalH =
      boxes.reduce((acc, b) => acc + b.boxH, 0) + (boxes.length - 1) * CHAIN_GAP;
    const gap = Math.max(MAIN_GAP, totalH + SPAN_MARGIN * 2);

    // 容器组在跨段内垂直居中
    let y = cursorY + (gap - totalH) / 2;
    boxes.forEach((b, k) => {
      const boxId = `C${b.idx}`;
      addNode(boxId, "csbox", BOX_X, y, {
        title: b.step.name || "会签",
        partyCount: b.parties.length,
        width: b.boxW,
        height: b.boxH,
        selected: b.idx === selectedIdx,
        mode: b.mode,
      });
      modes.set(boxId, b.mode);

      const cs: CountersignNodes = { boxId, laneIdByPartyId: new Map() };
      b.laneData.forEach((lane, j) => {
        const laneId = `P${b.idx}-${j}`;
        const laneX = BOX_X + BOX_PAD_X + j * (LANE_W + LANE_GAP);
        const laneY = y + BOX_TITLE_H;
        const { partyId, ...laneNodeData } = lane;
        addNode(laneId, "party", laneX, laneY, laneNodeData);
        cs.laneIdByPartyId.set(partyId, laneId);
      });
      csNodes.set(`S${b.idx}`, cs);

      // 旁路连线:上一主干节点右缘 ─▶ 首容器顶边;容器间串联;末容器底边 ─▶ 下一主干节点右缘
      // 线型:进出会签为「线上↔线下」衔接、或下一主干步骤标注了与会签系统不互通 → 虚线
      if (k === 0) {
        orthEdge(prevNode, boxId, {
          sourceHandle: "rs",
          color: BYPASS_COLOR,
          width: 1.8,
          dashed: crosses(prevNode, boxId),
        });
      } else {
        const prevBoxId = `C${boxes[k - 1].idx}`;
        orthEdge(prevBoxId, boxId, {
          color: BYPASS_COLOR,
          width: 1.8,
          dashed: crosses(prevBoxId, boxId),
        });
      }
      if (k === boxes.length - 1) {
        orthEdge(boxId, nextMainId, {
          targetHandle: "r",
          color: BYPASS_COLOR,
          width: 1.8,
          dashed: crosses(boxId, nextMainId) || (nextIdx != null && markedNotInterop(nextIdx)),
        });
      }
      y += b.boxH + CHAIN_GAP;
    });

    pendingCs.forEach((i) => directCsStepIdx.add(i));
    pendingCs.length = 0;
    return gap;
  };

  p.steps.forEach((step, i) => {
    // 会签:不占主干位,积累到当前跨段
    if (step.countersign) {
      pendingCs.push(i);
      return;
    }

    const sid = `S${i}`;
    const stepTail = [
      step.mode === "online" && step.online?.systemName ? step.online.systemName : "",
      // 互通结论仅在与上一步系统不同(该问题成立)时展示
      step.mode === "online" &&
      interopSystems(step, p.steps[i - 1]).length > 0 &&
      step.online?.dataInteroperable != null
        ? step.online.dataInteroperable
          ? "与上步系统数据互通"
          : "与上步系统数据不互通"
        : "",
      step.mode === "offline" && step.offline?.documents?.length
        ? `文件:${step.offline.documents.join("、")}`
        : "",
      step.mode === "offline" && step.offline?.handlers?.length
        ? `办理:${step.offline.handlers.map((h) => h.department).filter(Boolean).join("、")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

    // 先挂载跨段内的会签容器(决定本节点需要下移多少);本节点办理方式需先登记供线型判定
    modes.set(sid, step.mode);
    const spanHasCs = pendingCs.length > 0;
    const gap = flushCs(sid, i);
    const h = STEP_H + (step.waitFor?.stepId ? GATE_EXTRA_H : 0);
    const y = cursorY + gap;

    let gateLabel: string | undefined;
    let gateSource: string | null = null;
    let gateSourceHandle: string | undefined;
    const w = step.waitFor;
    if (w?.stepId) {
      const d = p.steps.findIndex((s) => s.id === w.stepId);
      if (d >= 0 && d < i && p.steps[d].countersign) {
        const dep = p.steps[d];
        const cs = csNodes.get(`S${d}`);
        if (cs) {
          if (w.partyId) {
            const laneId = cs.laneIdByPartyId.get(w.partyId);
            const partyIdx = dep.parties.findIndex((pt) => pt.id === w.partyId);
            if (laneId && partyIdx >= 0) {
              gateSource = laneId;
              gateSourceHandle = "r";
              gateLabel = `等待会签 ·「${dep.parties[partyIdx].department || `会签方${partyIdx + 1}`}」分支通过后执行`;
            }
          } else {
            gateSource = cs.boxId;
            gateSourceHandle = "r";
            gateLabel = `等待会签 ·「${dep.name || "未命名"}」会签全部通过后执行`;
          }
        }
      }
    }

    addNode(sid, "step", -STEP_W / 2, y, {
      title: step.name || "(未命名)",
      seq: i + 1,
      mode: step.mode,
      mobile: step.online?.mobileSupported ?? false,
      tail: stepTail,
      gate: gateLabel,
      selected: i === selectedIdx,
    });

    // 主干直连(不打断);跨段依赖(非直连)额外补靛蓝虚线
    // 线型:与上一主干节点「线上↔线下」衔接 → 虚线;本跨段无会签时,标注了与上一步系统不互通 → 虚线
    // (跨段内有会签时,本步骤的互通结论针对会签系统,已体现在容器 → 本节点的旁路线上)
    orthEdge(prevNode, sid, {
      dashed: crosses(prevNode, sid) || (!spanHasCs && markedNotInterop(i)),
    });
    // 直连抑制仅适用「等整个会签且会签就在上一跨段」:旁路线已把结果送进本节点右缘;
    // 等具体会签方分支始终补显式靛蓝虚线
    const depIdx = w?.stepId ? p.steps.findIndex((s) => s.id === w.stepId) : -1;
    const suppressDirect = !w?.partyId && directCsStepIdx.has(depIdx);
    if (gateSource && !suppressDirect) {
      gateEdge(gateSource, sid, gateLabel!, gateSourceHandle);
    }

    cursorY = y + h;
    prevNode = sid;
  });

  // 末尾跨段:剩余会签挂到 END
  modes.set("END", "unknown");
  const endGap = flushCs("END");
  const endY = cursorY + endGap;
  addNode("END", "cap", -CAP_W / 2, endY, { title: "结束" });
  orthEdge(prevNode, "END", { dashed: crosses(prevNode, "END") });

  return { nodes, edges };
}

/* ---------- 渲染 ---------- */

/**
 * 连线锚点重测:宿主带缩放入场动画时(如 AnimatedModal 自 0.5 弹性放大),React Flow 会在
 * 动画中途用屏幕坐标测量锚点,而节点的布局尺寸此后不再变化、不会触发重测 →
 * 连线接到错误位置(旁路线落进泳道、出容器的线从容器内部起笔、主干线偏离中轴带折角)。
 *
 * 逐帧观察画布容器的屏幕尺寸:入场动画期间它持续变化,连续稳定后强制重测全部节点;
 * 容器自始稳定(如流程图编辑器整页)则只补测仍未测得尺寸的节点(兜底)。
 */
function RemeasureWhenSettled({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const { getNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const STABLE_FRAMES = 10; // 连续稳定帧数(约 170ms)视为动画结束
    const MAX_FRAMES = 180; // 最长观察 3s
    let raf = 0;
    let frames = 0;
    let first = "";
    let last = "";
    let stable = 0;
    const tick = () => {
      const rect = el.getBoundingClientRect();
      const sig = `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`;
      if (frames === 0) first = sig;
      stable = sig === last ? stable + 1 : 0;
      last = sig;
      frames++;
      if (stable >= STABLE_FRAMES || frames > MAX_FRAMES) {
        if (sig !== first) {
          // 宿主有入场动画:锚点是在动画中途测的,全部重测
          updateNodeInternals(getNodes().map((n) => n.id));
        } else {
          // 宿主自始稳定:只补测没有尺寸的节点(被清掉测量结果的会一直隐藏)
          const unmeasured = getNodes().filter((n) => !n.measured?.width || !n.measured?.height).map((n) => n.id);
          if (unmeasured.length > 0) updateNodeInternals(unmeasured);
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [container, getNodes, updateNodeInternals]);

  return null;
}

export function FlowGraph({
  source,
  selectedStepId,
  onSelectStep,
  height = "clamp(360px, 76vh, 820px)",
}: {
  source: ChartSource;
  /** 编辑态:选中的步骤 id(steps 内真实 id) */
  selectedStepId?: string | null;
  /** 编辑态:点选步骤/会签容器回调 */
  onSelectStep?: (stepId: string | null) => void;
  /** 画布高度(并排对比等紧凑场景可调小) */
  height?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 按"名称 + 步骤"缓存,而不是按 source 对象引用:React Flow(受控节点)只要收到新的节点对象,
  // 就会重建内部节点并清掉已测得的尺寸,而节点尺寸没变不会再触发测量,整张图会一直处于隐藏状态。
  // 父组件若每次渲染都传入新建的 source 对象,就会踩到这个坑。
  const { name, steps } = source;
  const selectedIdx = useMemo(
    () => (selectedStepId ? steps.findIndex((s) => s.id === selectedStepId) : -1),
    [selectedStepId, steps],
  );
  const { nodes, edges } = useMemo(
    () => buildGraph({ name, steps }, new Map<string, CountersignNodes>(), selectedIdx),
    [name, steps, selectedIdx],
  );

  return (
    /* 响应式画布:高度随视口动态伸缩(小屏 ≥360px,大屏最高 76vh);
       minZoom 兜底 —— 图过大时不再无限缩小,改为可拖动/双指缩放查看 */
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-2xl border border-black/5 bg-[rgba(255,255,255,0.4)]"
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.45}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        /* 交互:滚轮/触控板平移,双指缩放,拖拽平移;禁误触的双击与滚轮缩放 */
        zoomOnScroll={false}
        panOnScroll
        panOnDrag
        zoomOnPinch
        zoomOnDoubleClick={false}
        onNodeClick={onSelectStep ? (_e, node) => {
          // S{i}=普通步骤 / C{i}=会签容器;其余(开始/结束/泳道)不选
          const m = /^(S|C)(\d+)$/.exec(node.id);
          if (!m || !onSelectStep) return;
          const idx = Number(m[2]);
          onSelectStep(source.steps[idx]?.id ?? null);
        } : undefined}
        onPaneClick={onSelectStep ? () => onSelectStep(null) : undefined}
        proOptions={{ hideAttribution: true }}
      >
        <RemeasureWhenSettled container={containerRef} />
        <Background color="rgba(60,60,67,0.1)" gap={18} size={1.4} />
      </ReactFlow>
    </div>
  );
}
