"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Meteors } from "@/components/ui/meteors";
import { ShootingStars } from "@/components/ui/shooting-stars";
import { StarsBackground } from "@/components/ui/stars-background";
import { FlowBuilder } from "@/components/flow-builder";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { emptyProcess } from "@/lib/types";

export default function Home() {
  const [draft, setDraft] = useState(emptyProcess);
  const [chart, setChart] = useState<ChartSource | null>(null);
  // 官方 Meteors 内部使用 Math.random()，SSR/CSR 不一致；
  // 挂载后再渲染以避免 hydration mismatch（不改动官方组件源码）
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <main className="dvh-fill relative w-full overflow-x-clip bg-black">
      <div className="ambient-field" aria-hidden="true" />
      {mounted && (
        <>
          <StarsBackground className="z-0" />
          <ShootingStars className="z-0" />
        </>
      )}

      <div className="fold-aware safe-viewport relative z-10 mx-auto w-full max-w-4xl py-10 sm:py-14">
        {/* 标题区：工程标头 */}
        <header className="relative mb-8 sm:mb-10">
          <LiquidGlass radius={28} bevelDepth={12} scale={36} aberration={3} frost={0.5} tint={0.1}>
          <div className="relative overflow-hidden rounded-[28px] p-6 sm:p-8">
          {mounted && <Meteors number={5} />}
          <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div>
              <p className="eyebrow text-[11px] text-cyan-300/80">
                ReForge / 流程再造工程收集表
              </p>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-[color:var(--flow-muted)]">
                ① 填写流程名称与申报人；② 依次添加步骤，选「线上系统」或「线下办理」并补全信息，
                需多方并行签署时打开会签开关；③ 点「一键生成流程图」预览；
                ④ 点「提交流程」，由管理员在
                <Link
                  href="/admin"
                  className="mx-0.5 inline-flex items-center gap-0.5 text-cyan-300 transition hover:text-cyan-200"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> 管理后台
                </Link>
                统一查看。
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-3">
              <dl className="font-data space-y-1.5 border-l border-white/10 pl-5 text-right text-xs text-[color:var(--flow-muted)] sm:pl-6">
                <div className="flex items-center justify-end gap-2">
                  <dt>步骤</dt>
                  <dd className="text-base text-cyan-300">{draft.steps.length}</dd>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <dt>会签</dt>
                  <dd className="text-base text-amber-300">
                    {draft.steps.filter((s) => s.countersign).length}
                  </dd>
                </div>
              </dl>
              <Link
                href="/admin"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-1.5 text-xs text-neutral-300 transition hover:border-cyan-400/40 hover:text-cyan-200"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> 管理后台登录
              </Link>
            </div>
          </div>
          </div>
          </LiquidGlass>
        </header>

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
