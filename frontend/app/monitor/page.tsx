"use client";

/**
 * 数据大屏 · 全维度(专属路由 /monitor,为挂在墙上看而设计)
 * 暗色玻璃。口径:
 *  - 顶部六个数:累计收集 / 在途项目 / 待评审 / 逾期预警 / 改造完成 / 按期完成率与平均周期
 *  - 第二行:近 6 个月趋势、在途项目的阶段分布、在途健康度构成
 *  - 第三行:PM 负载、申报部门 TOP5、线上系统涉及度
 *  - 底部:最新动态
 * 数据来自 /api/admin/overview?full=1,每 30 秒刷新。需登录;未登录或会话失效去 /login。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Maximize2, Minimize2 } from "lucide-react";
import { authFetch, getToken } from "@/lib/auth";
import type { Overview, OverviewCount, OverviewEvent, OverviewTrend } from "@/lib/types";

const INK = "rgba(255,255,255,0.92)";
const INK2 = "rgba(255,255,255,0.62)";
const INK3 = "rgba(255,255,255,0.4)";
const C = { blue: "#0a84ff", cyan: "#64d2ff", green: "#30d158", amber: "#ff9f0a", red: "#ff453a", indigo: "#5e5ce6", violet: "#bf5af2" };

const cardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(255,255,255,0.085), rgba(255,255,255,0.045))",
  backdropFilter: "blur(24px) saturate(160%)",
  WebkitBackdropFilter: "blur(24px) saturate(160%)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), inset 0 0 0 0.5px rgba(255,255,255,0.09), 0 18px 44px -20px rgba(0,0,0,0.6)",
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function MonitorPage() {
  const router = useRouter();
  const now = useClock();
  const [data, setData] = useState<Overview | null>(null);
  const [denied, setDenied] = useState(false);
  const [updatedAgo, setUpdatedAgo] = useState(0);
  const [stale, setStale] = useState(false);
  const [isFull, setIsFull] = useState(false);

  const load = useCallback(async () => {
    try {
      const ov = await authFetch<Overview>("/api/admin/overview?full=1", { cache: "no-store" });
      setData(ov);
      setUpdatedAgo(0);
      setStale(false);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        setDenied(true);
        return;
      }
      // 首次登录还没改密码:大屏的数据接口会被拒绝,回工作台先改密码
      if (e instanceof Error && (e as { code?: string }).code === "PASSWORD_CHANGE_REQUIRED") {
        router.replace("/work");
        return;
      }
      // 网络抖动:保留上一次的数据,提示已过期
      setStale(true);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const tick = setInterval(() => setUpdatedAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, router]);

  // 会话失效 → 回登录页(本地会话已由 authFetch 清掉)
  useEffect(() => {
    if (denied) router.replace("/login");
  }, [denied, router]);

  useEffect(() => {
    const sync = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const time = now.toLocaleTimeString("zh-CN", { hour12: false });
  const date = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });

  const d = data;
  const overdueTotal = (d?.overdueItems ?? 0) + (d?.overdueStages ?? 0);
  const stageRows = useMemo(
    () =>
      (d?.byStage ?? []).map((n, i) => ({
        label: d?.stageNames?.[i] ?? `阶段 ${i + 1}`,
        value: n,
        color: stageColor(d?.stageKeys?.[i] ?? ""),
      })),
    [d],
  );
  const pmRows = useMemo(
    () => (d?.pmLoad ?? []).map((x) => ({ label: x.name, value: x.active, note: loadNote(x.overdue, x.blocked) })),
    [d],
  );
  const healthSegments = [
    { label: "正常", value: d?.byHealth.on_track ?? 0, color: C.green },
    { label: "有风险", value: d?.byHealth.at_risk ?? 0, color: C.amber },
    { label: "已偏离", value: d?.byHealth.off_track ?? 0, color: C.red },
  ];

  return (
    <main className="relative min-h-screen w-full overflow-x-clip">
      {/* 暗色环境:深空 + 光场 + 网格点 */}
      <div
        className="fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(64rem 44rem at 10% -12%, rgba(10,132,255,0.24), transparent 60%)," +
            "radial-gradient(54rem 38rem at 96% -6%, rgba(94,92,230,0.18), transparent 58%)," +
            "radial-gradient(60rem 42rem at 100% 108%, rgba(48,209,88,0.1), transparent 55%)," +
            "radial-gradient(48rem 34rem at -8% 110%, rgba(100,210,255,0.12), transparent 55%)," +
            "linear-gradient(180deg, #0b1020, #080c16)",
        }}
      />
      <div
        className="fixed inset-0 z-0 opacity-50"
        aria-hidden="true"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-[1560px] flex-col px-4 py-6 sm:px-8 sm:py-8">
        {/* 顶栏 */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-3">
            <BrandTile />
            <div>
              <h1 className="text-[22px] font-bold leading-none tracking-wide text-white/90 sm:text-[26px]">流程再造 · 运行监控大屏</h1>
              <p className="mt-1.5 hidden text-xs tracking-[0.24em] text-white/40 sm:block">REFORGE PROCESS REENGINEERING OVERVIEW</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-[rgba(48,209,88,0.14)] px-4 py-2 text-xs font-semibold text-[#30d158]">
            <span className="relative flex h-[7px] w-[7px]">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#30d158] opacity-60" />
              <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-[#30d158]" />
            </span>
            {stale ? "连接中断" : "实时"}
          </span>
          <div className="ml-auto text-right">
            <div className="font-data text-[26px] font-bold leading-none tabular-nums tracking-wide text-white/90 sm:text-[28px]">{time}</div>
            <div className="font-data mt-1.5 text-xs tabular-nums text-white/40">
              {date} · 数据更新于 {updatedAgo} 秒前
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="inline-flex items-center rounded-full bg-white/10 px-3.5 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/20"
              title={isFull ? "退出全屏" : "全屏显示"}
            >
              {isFull ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              <span className="ml-1.5 hidden sm:inline">{isFull ? "退出全屏" : "全屏"}</span>
            </button>
            {/* 从哪来回哪去;直接打开大屏(没有上一页)就回工作台 */}
            <button
              type="button"
              onClick={() => (window.history.length > 1 ? router.back() : router.push("/work"))}
              className="rounded-full bg-white/10 px-3.5 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/20"
            >
              返回
            </button>
          </div>
        </header>

        {/* 六个核心数 */}
        <div className="grid grid-cols-2 gap-3 py-4 sm:gap-3.5 lg:grid-cols-3 xl:grid-cols-6">
          <Kpi label="累计收集流程" value={d?.collected} color={INK} sub={<>本月新增 <b style={{ color: C.cyan }}>+{d?.monthlyNew ?? 0}</b></>} />
          <Kpi label="在途项目" value={d?.active} color={C.blue} sub={<>含搁置 <b style={{ color: d?.onHold ? C.amber : INK2 }}>{d?.onHold ?? 0}</b> 个</>} />
          <Kpi
            label="待评审"
            value={d?.pendingReviews}
            color={(d?.pendingReviews ?? 0) > 0 ? C.indigo : INK}
            sub={<>平均已等待 <b style={{ color: (d?.reviewWaitDays ?? 0) >= 3 ? C.amber : INK2 }}>{d?.reviewWaitDays ?? 0}</b> 天</>}
          />
          <Kpi
            label="逾期预警"
            value={overdueTotal}
            color={overdueTotal > 0 ? C.red : INK}
            sub={
              <>
                工作项 {d?.overdueItems ?? 0} · 阶段 {d?.overdueStages ?? 0}
                {(d?.blockedItems ?? 0) > 0 && (
                  <>
                    {" "}
                    · 阻塞 <b style={{ color: C.amber }}>{d?.blockedItems}</b>
                  </>
                )}
              </>
            }
          />
          <Kpi label="改造完成" value={d?.done} color={C.green} sub={<>本月完成 <b style={{ color: C.green }}>+{d?.monthlyDone ?? 0}</b></>} />
          <Kpi
            label="按期完成率 · 平均周期"
            value={
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span>{d ? pct(d.onTimeRate) : "—"}</span>
                <span className="text-[22px]" style={{ color: INK2 }}>
                  {d?.avgCycleDays != null ? (
                    <>
                      {d.avgCycleDays}
                      <span className="text-[13px]"> 天</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </span>
            }
            color={INK}
            sub={d?.onTimeRate == null && d?.avgCycleDays == null ? "还没有带目标日期的已完成项目" : "已完成项目里按目标日期完成的比例"}
            small
          />
        </div>

        {/* 第二行:趋势 / 阶段分布 / 在途健康度 */}
        <div className="grid gap-3.5 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,3fr)]">
          <Panel title="月度收集与完成趋势" accent={C.cyan} aside="近 6 个月">
            {d?.trend?.length ? <TrendChart data={d.trend} /> : <Empty />}
          </Panel>
          <Panel title="阶段分布（在途存量）" accent={C.indigo}>
            {stageRows.some((r) => r.value > 0) ? <Bars rows={stageRows} unit=" 个" /> : <Empty text="当前没有在途项目" />}
          </Panel>
          <Panel title="在途健康度" accent={C.green}>
            {d ? <Donut segments={healthSegments.filter((s) => s.value > 0)} total={d.active} legend={healthSegments} /> : <Empty />}
          </Panel>
        </div>

        {/* 第三行:负责人负载 / 申报部门 / 线上系统 */}
        <div className="grid gap-3.5 py-3.5 md:grid-cols-3">
          <Panel title="PM 负载（在办）" accent={C.amber} aside={d?.pmLoad?.length ? `人均在办 ${avg(d.pmLoad.map((x) => x.active))} 个` : undefined}>
            {pmRows.length ? <Bars rows={pmRows} unit=" 个" color={C.cyan} /> : <Empty text="还没有 PM 在推进项目" />}
          </Panel>
          <Panel title="申报部门 TOP5" accent={C.violet}>
            {d?.departmentTop?.length ? <Bars rows={toRows(d.departmentTop)} unit=" 条" color={C.violet} /> : <Empty />}
          </Panel>
          <Panel title="线上系统涉及度" accent={C.cyan} aside="已收集流程">
            {d?.systemTop?.length ? (
              <Bars rows={toRows(d.systemTop)} unit=" 条" color="linear-gradient(90deg,#0a84ff,#64d2ff)" wide />
            ) : (
              <Empty />
            )}
          </Panel>
        </div>

        {/* 最新动态 */}
        <div className="rounded-[22px]" style={cardStyle}>
          <div className="flex min-h-[48px] flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-3 text-[13px]" style={{ color: INK2 }}>
            <span className="font-bold" style={{ color: C.cyan }}>
              最新动态
            </span>
            {d?.recentEvents?.length ? d.recentEvents.map((e) => <EventItem key={e.id} e={e} now={now} />) : <span style={{ color: INK3 }}>还没有动态</span>}
          </div>
        </div>

        {/* 底部口径 */}
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-xs" style={{ color: INK3 }}>
          <span>
            口径:在途 = 进行中的流程项目;逾期 = 已过截止日且未完成的工作项与阶段;健康度取 PM 最近一次简报;按期完成率与平均周期只统计已完成项目。
          </span>
          <span className="ml-auto">数据每 30 秒自动刷新</span>
        </footer>
      </div>
    </main>
  );
}

function BrandTile() {
  return (
    <span
      className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-white"
      style={{
        background: "linear-gradient(180deg,#409cff,#0a84ff)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 8px 22px -6px rgba(10,132,255,0.8)",
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <circle cx="5" cy="6" r="2.4" />
        <circle cx="5" cy="18" r="2.4" />
        <circle cx="19" cy="12" r="2.4" />
        <path d="M7.3 6.9 16.7 11.1M7.3 17.1 16.7 12.9" />
      </svg>
    </span>
  );
}

function Kpi({
  label,
  value,
  color,
  sub,
  small,
}: {
  label: string;
  value: React.ReactNode;
  color: string;
  sub: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-[22px] px-4 py-4" style={cardStyle}>
      <div className="flex items-center gap-2 text-[13px] font-medium leading-snug" style={{ color: INK2 }}>
        <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span>{label}</span>
      </div>
      <div className="font-data mt-2.5 font-bold leading-none tabular-nums tracking-tight" style={{ color, fontSize: small ? "clamp(24px, 2.3vw, 34px)" : "clamp(32px, 3vw, 44px)" }}>
        {value ?? "—"}
      </div>
      <div className="mt-2 truncate text-[12px]" style={{ color: INK3 }} title={typeof sub === "string" ? sub : undefined}>
        {sub}
      </div>
    </div>
  );
}

function Panel({
  title,
  accent,
  aside,
  children,
}: {
  title: string;
  accent: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-[22px]" style={cardStyle}>
      <div className="flex items-center gap-2 px-[18px] pt-3.5 text-[14px] font-semibold" style={{ color: INK2 }}>
        <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: accent }} />
        {title}
        {aside && (
          <span className="ml-auto text-[11px] font-normal" style={{ color: INK3 }}>
            {aside}
          </span>
        )}
      </div>
      <div className="min-w-0 px-3 pb-3 pt-1.5">{children}</div>
    </section>
  );
}

function Empty({ text = "暂无数据" }: { text?: string }) {
  return (
    <p className="grid h-[180px] place-items-center text-[13px]" style={{ color: INK3 }}>
      {text}
    </p>
  );
}

/** 纵轴上限取"能被 4 整除"的整数,四条网格线上的刻度才都是整数 */
function niceMax(n: number) {
  for (const p of [1, 10, 100, 1000, 10000]) {
    for (const m of [4, 8, 12, 16, 20, 24, 32, 40, 60, 80]) {
      if (m * p >= n) return m * p;
    }
  }
  return 100000;
}

function monthLabel(iso: string) {
  const [y, m] = iso.split("-");
  return m === "01" ? `${y}年1月` : `${Number(m)}月`;
}

/** 近 6 个月双线图:收集(青,带面积)与完成(绿) */
function TrendChart({ data }: { data: OverviewTrend[] }) {
  const W = 560;
  const H = 238;
  const L = 40;
  const R = 18;
  const T = 30;
  const B = 30;
  const max = niceMax(Math.max(1, ...data.map((d) => Math.max(d.collected, d.done))));
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, data.length - 1);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const line = (pick: (d: OverviewTrend) => number) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(pick(d)).toFixed(1)}`).join(" ");
  const area = `${line((d) => d.collected)} L${x(data.length - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`近 ${data.length} 个月收集与完成趋势，月度最多 ${max} 条`}>
      <defs>
        <linearGradient id="monitor-trend-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.cyan} stopOpacity="0.32" />
          <stop offset="100%" stopColor={C.cyan} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <path d={`M${L} ${y(max * t)} H${W - R}`} stroke="rgba(255,255,255,0.08)" />
          <text x={L - 8} y={y(max * t) + 3.5} textAnchor="end" fontSize="10" fill={INK3}>
            {Math.round(max * t)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#monitor-trend-area)" />
      <path d={line((d) => d.done)} fill="none" stroke={C.green} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d={line((d) => d.collected)} fill="none" stroke={C.cyan} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => (
        <g key={d.month}>
          <circle cx={x(i)} cy={y(d.done)} r="3.2" fill={C.green}>
            <title>{`${d.month} · 完成 ${d.done}`}</title>
          </circle>
          <circle cx={x(i)} cy={y(d.collected)} r={i === data.length - 1 ? 4.4 : 3.4} fill={C.cyan} stroke={i === data.length - 1 ? "#0a0e1a" : "none"} strokeWidth="2">
            <title>{`${d.month} · 收集 ${d.collected}`}</title>
          </circle>
          <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="10.5" fill={INK3}>
            {monthLabel(d.month)}
          </text>
        </g>
      ))}
      <g fontSize="11" fontWeight="600">
        <rect x={W - 150} y={8} width="10" height="3" rx="1.5" fill={C.cyan} />
        <text x={W - 134} y={13} fill={INK2}>
          收集
        </text>
        <rect x={W - 96} y={8} width="10" height="3" rx="1.5" fill={C.green} />
        <text x={W - 80} y={13} fill={INK2}>
          完成
        </text>
      </g>
    </svg>
  );
}

interface BarRow {
  label: string;
  value: number;
  note?: string;
  color?: string;
}

function stageColor(key: string) {
  switch (key) {
    case "intake":
      return C.amber;
    case "require":
    case "design":
      return C.indigo;
    case "build":
    case "trial":
      return C.blue;
    case "accept":
      return C.green;
    case "operate":
      return C.cyan;
    default:
      return "rgba(255,255,255,0.4)";
  }
}

function loadNote(overdue: number, blocked: number) {
  return [overdue ? `${overdue} 逾期` : "", blocked ? `${blocked} 阻塞` : ""].filter(Boolean).join(" · ");
}

function toRows(list: OverviewCount[]): BarRow[] {
  return list.map((x) => ({ label: x.name, value: x.count }));
}

/** 横向条形:标签 / 条 / 数值。条宽变化带过渡,轮询刷新时能看出增减 */
function Bars({ rows, unit, color = "rgba(255,255,255,0.34)", wide }: { rows: BarRow[]; unit: string; color?: string; wide?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  // 带附注(逾期 / 阻塞)的行数值更长,数值列放宽,避免折成两行
  const valueWidth = rows.some((r) => r.note) ? "w-[148px]" : "w-[104px]";
  return (
    <ul className={`grid gap-2.5 px-1.5 pb-1 ${rows.length > 8 ? "max-h-[236px] overflow-y-auto pr-1" : ""}`} aria-label="条形分布">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-3 text-[13px]">
          <span className={`${wide ? "w-[104px]" : "w-[84px]"} shrink-0 truncate`} style={{ color: INK2 }} title={r.label}>
            {r.label}
          </span>
          <span className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full transition-[width] duration-700 ease-out"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? color, minWidth: r.value > 0 ? 6 : 0 }}
            />
          </span>
          <span className={`font-data ${valueWidth} shrink-0 whitespace-nowrap text-right text-[12px] tabular-nums`} style={{ color: INK2 }}>
            <b style={{ color: INK }}>{r.value}</b>
            {unit}
            {r.note && <span style={{ color: INK3 }}> · {r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 环形图:各段按占在途总数的比例绕一圈,中间写在途总数 */
function Donut({
  segments,
  total,
  legend,
}: {
  segments: { label: string; value: number; color: string }[];
  total: number;
  legend: { label: string; value: number; color: string }[];
}) {
  const r = 62;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg viewBox="0 0 300 196" className="mx-auto block w-full max-w-[340px]" role="img" aria-label={`在途项目 ${total} 个：${legend.map((s) => `${s.label} ${s.value}`).join("，")}`}>
      <g transform="translate(150,92)">
        <circle r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
        {segments.map((s) => {
          const len = (s.value / Math.max(1, total)) * circumference;
          const offset = acc;
          acc += len;
          return (
            <circle
              key={s.label}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="18"
              strokeDasharray={`${len} ${circumference - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90)"
            />
          );
        })}
        <text y="-2" textAnchor="middle" fontSize="30" fontWeight="700" fill={INK} className="font-data">
          {total}
        </text>
        <text y="18" textAnchor="middle" fontSize="11" fill={INK3}>
          在途项目
        </text>
      </g>
      <g fontSize="11" fill={INK2}>
        {legend.map((s, i) => (
          <g key={s.label} transform={`translate(${18 + i * 92},180)`}>
            <circle r="4" fill={s.color} />
            <text x="10" y="4">
              {s.label} <tspan className="font-data" fill={INK}>{s.value}</tspan>
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

const EVENT_LABEL: Record<string, string> = {
  project_created: "提交流程",
  review_submitted: "提交评审",
  review_approved: "评审通过",
  review_rejected: "评审驳回",
  review_withdrawn: "撤回评审",
  review_admin_decided: "管理员裁决",
  stage_rewound: "回退阶段",
  stage_skipped: "跳过阶段",
  project_status: "变更项目状态",
  project_updated: "修改项目信息",
};
const EVENT_DOT: Record<string, string> = {
  project_created: C.green,
  review_submitted: C.amber,
  review_approved: C.green,
  review_rejected: C.red,
  review_withdrawn: C.amber,
  stage_rewound: C.red,
  stage_skipped: C.amber,
};

function ago(iso: string, now: Date) {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function EventItem({ e, now }: { e: OverviewEvent; now: Date }) {
  return (
    <Link href={`/projects/${e.projectId}`} prefetch={false} className="inline-flex items-center gap-1.5 whitespace-nowrap transition hover:text-white" title={ago(e.createdAt, now)}>
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: EVENT_DOT[e.kind] ?? "rgba(255,255,255,0.4)" }} />
      <span className="font-data" style={{ color: INK3 }}>
        {e.actor || "系统"}
      </span>
      <span>{EVENT_LABEL[e.kind] ?? e.kind}</span>
      <span className="max-w-[12em] truncate" style={{ color: INK }}>
        {e.projectName}
      </span>
    </Link>
  );
}

function pct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function avg(ns: number[]) {
  return ns.length ? (ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(1).replace(/\.0$/, "") : "0";
}
