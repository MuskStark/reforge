"use client";

import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { LayoutGrid, LogIn } from "lucide-react";
import { toast } from "sonner";
import { FlowBuilder } from "@/components/flow-builder";
import { FlowChartLoadBoundary } from "@/components/flow-chart-load-boundary";
import type { ChartSource } from "@/components/flow-chart";
import { authFetch, getToken, getUser, type SessionUser } from "@/lib/auth";
import { stepIssues } from "@/lib/step-checks";
import { emptyProcess } from "@/lib/types";

/**
 * 流程图弹窗带 React Flow(占首屏 JS 约四成),只有点"预览"才用得到:
 * 按需加载,不拖慢首屏;用户第一次操作表单后在后台预取,点开时通常已就绪。
 * 取代码块失败(链路抖动)先自动重试;仍失败由 FlowChartLoadBoundary 只在弹窗位置提示,表单内容不受影响。
 */
async function loadFlowChart(attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await import("@/components/flow-chart");
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

/** lazy 会记住一次加载失败的结果,所以每次打开都新建一个,关掉再点才是真正的重试 */
function chartModalComponent() {
  return lazy(async () => ({ default: (await loadFlowChart()).FlowChartModal }));
}

let chartPrefetchStarted = false;

/** 流程图代码块还没取到时的占位 */
function ChartLoading() {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-neutral-900/15 backdrop-blur-sm">
      <span className="lg-chip text-[13px] text-[color:var(--ink-2)]">正在加载流程图…</span>
    </div>
  );
}

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
  const [FlowChartModal, setFlowChartModal] = useState(chartModalComponent);
  // 顶栏的入口:已登录的人回工作台,没登录的去登录页。
  // 收集表仅登录可填:没有会话就出示登录门卡。会话存在 sessionStorage 里,只有客户端读得到,
  // 所以挂在 layout effect 上(首帧两端一致是"未登录";有令牌的人在绘制前就换成表单,不会闪门卡)
  const [signedIn, setSignedIn] = useState(false);
  const [me, setMe] = useState<SessionUser | null>(null);
  useLayoutEffect(() => {
    const has = Boolean(getToken());
    setSignedIn(has);
    if (has) setMe(getUser());
  }, []);

  // 本地令牌还要向后端确认没过期;过期则翻回门卡重新登录(authFetch 已顺手清掉本地会话)
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    authFetch<SessionUser>("/api/auth/me", { cache: "no-store" })
      .then((u) => {
        if (alive) setMe(u);
      })
      .catch(() => {
        if (alive) {
          setSignedIn(false);
          setMe(null);
          toast.info("登录已过期，请重新登录");
        }
      });
    return () => {
      alive = false;
    };
  }, [signedIn]);

  // 申报人默认填提交账号的显示名(留空才补,不覆盖手动改动)
  useEffect(() => {
    if (!me) return;
    setDraft((d) => (d.applicant.trim() ? d : { ...d, applicant: me.displayName || me.username }));
  }, [me]);

  // 第一次点进或聚焦表单就在后台预取流程图代码块;每个页面只发起一次(取不到也不随每次点击反复请求,
  // 用户点"预览"时自会重试),失败不打扰
  const prefetchChart = useCallback(() => {
    if (chartPrefetchStarted) return;
    chartPrefetchStarted = true;
    void loadFlowChart().catch(() => {});
  }, []);

  const openChart = () => {
    setFlowChartModal(chartModalComponent);
    setChart({ name: draft.name, steps: draft.steps });
  };

  const countersignCount = draft.steps.filter((s) => s.countersign).length;
  const readyCount = draft.steps.filter((s, i) => stepIssues(s, draft.steps[i - 1]).length === 0).length;

  return (
    <main className="dvh-fill relative w-full overflow-x-clip" onFocusCapture={prefetchChart} onPointerDownCapture={prefetchChart}>
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
            href={signedIn ? "/work" : "/login"}
            prefetch={false}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
          >
            {signedIn ? <LayoutGrid className="h-4 w-4" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
            {signedIn ? "工作台" : "登录"}
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
          {/* 统计玻璃小牌(门卡态没有表单内容,不展示) */}
          {signedIn && (
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
          )}
        </section>

        {!signedIn ? (
          /* 登录门:收集表仅登录可填。登录后带着 next=/ 回到这一页继续 */
          <section className="glass-card mx-auto w-full max-w-[440px] p-8 text-center sm:p-10">
            <span
              className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-[16px] text-white"
              style={{
                background: "linear-gradient(180deg, #2b95ff, #0071e3)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -10px 18px -12px rgba(0,45,110,0.5), 0 10px 26px -10px rgba(0,113,227,0.65)",
              }}
            >
              <LogIn className="h-7 w-7" aria-hidden="true" />
            </span>
            <h2 className="text-[20px] font-bold tracking-[-0.02em] text-neutral-900">登录后填写收集表</h2>
            <p className="mx-auto mt-2 max-w-[26em] text-sm leading-relaxed text-[color:var(--ink-2)]">
              收集表仅对登录用户开放。提交后，可以在工作台的「我提交的需求」里随时查看这条流程推进到了哪一步。
            </p>
            <Link href="/login?next=/" prefetch={false} className="btn btn-primary mt-6 !h-[46px] w-full text-[16px]">
              去登录
            </Link>
            <p className="mt-3 text-xs text-[color:var(--ink-3)]">没有账号请联系管理员开通。</p>
          </section>
        ) : (
          <FlowBuilder
            value={draft}
            onChange={setDraft}
            onSubmitted={() => {
              toast.success("已提交", {
                description: "已进入需求承接，可在工作台「我提交的需求」查看推进进度",
              });
            }}
            onPreviewChart={openChart}
          />
        )}
      </div>

      {/* 代码块可能取不到(链路抖动,或页面打开后正好发了版):失败只在弹窗位置提示,表单内容不受影响 */}
      {chart && (
        <FlowChartLoadBoundary onClose={() => setChart(null)}>
          <Suspense fallback={<ChartLoading />}>
            <FlowChartModal onClose={() => setChart(null)} source={chart} />
          </Suspense>
        </FlowChartLoadBoundary>
      )}
    </main>
  );
}
