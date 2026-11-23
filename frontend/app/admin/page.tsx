"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, BellRing, Inbox, LayoutGrid, ListChecks, LogOut, Monitor, User, Users, Waypoints } from "lucide-react";
import { ProcessManager } from "@/components/admin/process-manager";
import type { FlowProcess } from "@/lib/types";
import { SystemsManager } from "@/components/admin/systems-manager";
import { UsersManager } from "@/components/admin/users-manager";
import { NotifyChannels } from "@/components/admin/notify-channels";
import { StageTemplates } from "@/components/admin/stage-templates";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { authFetch, clearSession, getToken, type SessionUser } from "@/lib/auth";
import { BrandMark, LoginCard } from "@/components/auth/login-card";
import { cn } from "@/lib/utils";

type Phase = "checking" | "auth" | "member" | "admin";
type Tab = "processes" | "systems" | "users" | "stages" | "channels";

/**
 * 管理后台:流程定义、线上系统库、用户与岗位、阶段模板、通知渠道。
 * 流程的推进与评审不在后台,而在「工作台 / 流程项目」(见 docs/process-management-architecture.md 第 14 节)。
 */
export default function AdminPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [me, setMe] = useState<SessionUser | null>(null);
  const [chart, setChart] = useState<ChartSource | null>(null);
  const [tab, setTab] = useState<Tab>("processes");

  // 启动:校验本地会话
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setPhase("auth");
        return;
      }
      try {
        const user = await authFetch<SessionUser>("/api/auth/me");
        setMe(user);
        setPhase(user.role === "admin" ? "admin" : "member");
      } catch {
        setPhase("auth");
      }
    })();
  }, []);

  const logout = useCallback(() => {
    void authFetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    clearSession();
    setMe(null);
    setPhase("auth");
    toast.success("已退出登录");
  }, []);

  const tabs: { id: Tab; label: string; icon: typeof Monitor }[] = [
    { id: "processes", label: "流程定义", icon: Inbox },
    { id: "systems", label: "线上系统库", icon: Monitor },
    { id: "users", label: "用户与岗位", icon: Users },
    { id: "stages", label: "阶段模板", icon: ListChecks },
    { id: "channels", label: "通知渠道", icon: BellRing },
  ];

  return (
    <main className="dvh-fill relative w-full overflow-x-clip">
      <div className="ambient-field" aria-hidden="true" />

      <div className="safe-viewport fold-aware relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-14 pt-3 sm:px-6 sm:pt-5">
        {phase === "checking" && (
          <p className="py-24 text-center text-sm text-[color:var(--ink-2)]">验证会话中…</p>
        )}

        {phase === "auth" && (
          <div className="flex min-h-[80vh] items-center justify-center py-10">
            <LoginCard
              title="管理后台"
              onLoggedIn={(user) => {
                setMe(user);
                setPhase(user.role === "admin" ? "admin" : "member");
              }}
            />
          </div>
        )}

        {/* 非管理员:后台只读配置,请去工作台 */}
        {phase === "member" && (
          <div className="flex min-h-[80vh] items-center justify-center py-10">
            <section className="glass-card w-full max-w-sm p-8 text-center">
              <User className="mx-auto h-8 w-8 text-[color:var(--ink-3)]" />
              <h1 className="mt-3 text-[19px] font-bold tracking-[-0.02em]">
                {me?.displayName || me?.username}，你好
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--ink-2)]">
                管理后台（流程定义 / 系统库 / 用户与岗位 / 阶段模板 / 通知渠道）需要管理员账号。
                你可以在工作台里推进与评审自己参与的流程改造。
              </p>
              <div className="mt-5 flex justify-center gap-3">
                <Link href="/work" className="btn btn-primary">
                  前往工作台
                </Link>
                <button type="button" onClick={logout} className="btn btn-glass">
                  <LogOut className="h-4 w-4" /> 退出
                </button>
              </div>
            </section>
          </div>
        )}

        {phase === "admin" && (
          <>
            {/* 顶栏 */}
            <header className="lg-clear sticky top-2.5 z-40 mb-4 flex h-[54px] items-center gap-3 px-2.5 pr-1.5">
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
                <span className="hidden text-[13px] text-[color:var(--ink-3)] sm:inline">/</span>
                <span className="hidden text-[15px] font-semibold sm:inline">管理后台</span>
              </div>
              <div className="flex-1" />
              <span className="lg-chip hidden items-center gap-2 py-1 pl-1.5 pr-2 sm:inline-flex">
                <span
                  className="grid h-[26px] w-[26px] place-items-center rounded-full text-[11px] font-semibold"
                  style={{ background: "linear-gradient(180deg,#ffd9a8,#ffb877)", color: "#7a4a10" }}
                >
                  {(me?.displayName || me?.username || "A").slice(0, 1).toUpperCase()}
                </span>
                <span className="text-[13px] font-medium">{me?.displayName || me?.username}</span>
                <span className="rounded-full bg-[rgba(120,120,128,0.12)] px-2 py-1 text-[11px] font-medium text-[color:var(--ink-2)]">
                  管理员
                </span>
              </span>
              <Link href="/work" className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]">
                <LayoutGrid className="h-4 w-4" />
                <span className="hidden sm:inline">工作台</span>
              </Link>
              <button
                type="button"
                onClick={() => router.push("/")}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">返回前台</span>
              </button>
              <button type="button" onClick={logout} className="icon-btn !h-9 !w-9" aria-label="退出登录" title="退出登录">
                <LogOut className="h-4 w-4" />
              </button>
            </header>

            {/* 基础态声明 minmax(0,1fr) 单列:否则隐式 auto 列会被导航的横向滚动标签撑宽,整页溢出手机屏幕 */}
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[210px_1fr]">
              {/* 侧栏:Clear 玻璃导航 */}
              <nav className="glass-card sticky top-[72px] !rounded-[22px] p-2.5" aria-label="后台导航">
                <p className="eyebrow px-3 pb-1.5 pt-2 text-[10px] text-[color:var(--ink-3)]">协作</p>
                <ul className="flex gap-1 overflow-x-auto sm:block sm:space-y-0.5 sm:overflow-visible">
                  {[
                    { href: "/work", label: "工作台", icon: LayoutGrid },
                    { href: "/projects", label: "流程项目", icon: Waypoints },
                  ].map(({ href, label, icon: Icon }) => (
                    <li key={href} className="shrink-0 sm:shrink">
                      <Link
                        href={href}
                        className="flex h-11 w-full items-center gap-2.5 rounded-[13px] px-3 text-[15px] font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)] sm:h-10"
                      >
                        <Icon className="h-[17px] w-[17px]" />
                        <span className="whitespace-nowrap">{label}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="eyebrow px-3 pb-1.5 pt-3 text-[10px] text-[color:var(--ink-3)]">系统管理</p>
                <ul className="flex gap-1 overflow-x-auto sm:block sm:space-y-0.5 sm:overflow-visible">
                  {tabs.map(({ id, label, icon: Icon }) => (
                    <li key={id} className="shrink-0 sm:shrink">
                      <button
                        type="button"
                        onClick={() => setTab(id)}
                        aria-current={tab === id ? "page" : undefined}
                        className={cn(
                          "flex h-11 w-full items-center gap-2.5 rounded-[13px] px-3 text-[15px] transition sm:h-10",
                          tab === id
                            ? "bg-white/90 font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,1),0_3px_10px_-5px_rgba(23,42,80,0.25)]"
                            : "font-medium text-[color:var(--ink-2)] hover:bg-white/45 hover:text-neutral-900",
                        )}
                      >
                        <Icon className="h-[17px] w-[17px]" />
                        <span className="whitespace-nowrap">{label}</span>
                      </button>
                    </li>
                  ))}
                  <li className="shrink-0 sm:hidden">
                    <Link href="/monitor" className="flex h-11 w-full items-center gap-2.5 rounded-[13px] px-3 text-[15px] font-medium text-[color:var(--tint)]">
                      <Monitor className="h-[17px] w-[17px]" />
                      <span className="whitespace-nowrap">数据大屏</span>
                    </Link>
                  </li>
                </ul>
                <div className="mt-2 hidden border-t border-[color:var(--sep)] pt-2 sm:block">
                  <Link
                    href="/monitor"
                    className="flex h-10 w-full items-center gap-2.5 rounded-[13px] px-3 text-[15px] font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
                  >
                    <Monitor className="h-[17px] w-[17px]" />
                    数据大屏
                    <span className="ml-auto text-[11px] text-[color:var(--ink-3)]">/monitor</span>
                  </Link>
                  <button
                    type="button"
                    onClick={logout}
                    className="flex h-10 w-full items-center gap-2.5 rounded-[13px] px-3 text-[15px] font-medium text-[color:var(--red-deep)] transition hover:bg-[color:var(--red-soft)]"
                  >
                    <LogOut className="h-[17px] w-[17px]" /> 退出登录
                  </button>
                </div>
              </nav>

              {/* 主区 */}
              <div>
                {tab === "processes" && (
                  <ProcessManager
                    onLogout={logout}
                    onPreviewChart={(p: FlowProcess) => setChart({ name: p.name, steps: p.steps })}
                  />
                )}
                {tab === "systems" && <SystemsManager onLogout={logout} />}
                {tab === "users" && <UsersManager onLogout={logout} me={me} />}
                {tab === "stages" && <StageTemplates onLogout={logout} />}
                {tab === "channels" && <NotifyChannels onLogout={logout} />}
              </div>
            </div>
          </>
        )}
      </div>

      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
    </main>
  );
}
