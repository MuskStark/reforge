"use client";

import { useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { FlowBuilder } from "@/components/flow-builder";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { stepIssues } from "@/lib/step-checks";
import { emptyProcess } from "@/lib/types";

/** 品牌图形:分叉汇聚的流程节点(与 app icon 同构) */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="5" cy="18" r="2.4" />
      <circle cx="19" cy="12" r="2.4" />
      <path d="M7.3 6.9 16.7 11.1M7.3 17.1 16.7 12.9" />
    </svg>
  );
}

export default function Home() {
  const [draft, setDraft] = useState(emptyProcess);
  const [chart, setChart] = useState<ChartSource | null>(null);

  const countersignCount = draft.steps.filter((s) => s.countersign).length;
  const readyCount = draft.steps.filter((s, i) => stepIssues(s, draft.steps[i - 1]).length === 0).length;

  return (
    <main className="dvh-fill relative w-full overflow-x-clip">
      {/* 环境光场:亮色极光(fixed,为玻璃提供可折射的色彩) */}
      <div className="ambient-field" aria-hidden="true" />

      <div className="safe-viewport fold-aware relative z-10 mx-auto w-full max-w-4xl px-4 pb-2 pt-3 sm:px-6 sm:pt-5">
        {/* 顶栏:悬浮 Clear 玻璃 */}
        <header className="lg-clear sticky top-2.5 z-40 mb-2 flex h-[54px] items-center gap-3.5 px-2.5 pr-1.5">
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-7 w-7 place-items-center rounded-[8px] text-white"
              style={{
                background: "linear-gradient(180deg, #2b95ff, #0071e3)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px -3px rgba(0,113,227,0.6)",
              }}
            >
              <BrandMark className="h-4 w-4" />
            </span>
            <span className="text-[17px] font-semibold tracking-[-0.02em]">ReForge</span>
          </div>
          <div className="flex-1" />
          <Link
            href="/admin"
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
          >
            <ShieldCheck className="h-4 w-4" />
            管理后台
          </Link>
        </header>

        {/* 大标题区(iOS Large Title) */}
        <section className="mb-6 mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 sm:mt-6">
          <div className="min-w-0">
            <p className="eyebrow mb-1.5 text-[11px] text-[color:var(--tint-deep)]">
              ReForge · Process Reengineering
            </p>
            <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.022em] text-neutral-900 sm:text-[34px]">
              流程再造工程收集表
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[color:var(--ink-2)]">
              沿时间轨逐步描述线上与线下环节;需要多方并行签署时打开会签。
              完成后一键生成流程图,提交至管理后台统一查看。
            </p>
          </div>
          {/* 统计玻璃小牌 */}
          <div className="flex shrink-0 gap-2">
            <span className="lg-chip inline-flex items-baseline gap-1.5 px-3.5 py-1.5 text-[13px] text-[color:var(--ink-2)]">
              步骤 <b className="font-data text-[17px] font-semibold leading-none text-neutral-900">{draft.steps.length}</b>
            </span>
            <span className="lg-chip inline-flex items-baseline gap-1.5 px-3.5 py-1.5 text-[13px] text-[color:var(--ink-2)]">
              会签 <b className="font-data text-[17px] font-semibold leading-none text-[color:var(--amber-deep)]">{countersignCount}</b>
            </span>
            <span className="lg-chip hidden items-baseline gap-1.5 px-3.5 py-1.5 text-[13px] text-[color:var(--ink-2)] sm:inline-flex">
              就绪 <b className="font-data text-[17px] font-semibold leading-none text-[color:var(--tint-deep)]">{readyCount}/{draft.steps.length}</b>
            </span>
          </div>
        </section>

        <FlowBuilder
          value={draft}
          onChange={setDraft}
          onSubmitted={() => {
            toast.success("已提交", {
              description: "流程已进入后台，管理员审核后可见",
            });
          }}
          onPreviewChart={() => setChart({ name: draft.name, steps: draft.steps })}
        />
      </div>

      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
    </main>
  );
}
