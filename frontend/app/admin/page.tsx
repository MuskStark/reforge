"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import { ShootingStars } from "@/components/ui/shooting-stars";
import { StarsBackground } from "@/components/ui/stars-background";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { HoverBorderGradient } from "@/components/ui/hover-border-gradient";
import { ProcessManager } from "@/components/admin/process-manager";
import { SystemsManager } from "@/components/admin/systems-manager";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { adminFetch, clearToken, getToken, setToken } from "@/lib/auth";
import { GLASS_SHADOW, useGlassInteraction } from "@/lib/glass";
import type { FlowProcess } from "@/lib/types";

type Phase = "checking" | "login" | "ready";

export default function AdminPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [chart, setChart] = useState<ChartSource | null>(null);
  const glassInteraction = useGlassInteraction();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 启动时校验本地已有令牌是否仍有效
  useEffect(() => {
    if (!getToken()) {
      setPhase("login");
      return;
    }
    adminFetch("/api/admin/session")
      .then(() => setPhase("ready"))
      .catch(() => setPhase("login"));
  }, []);

  const login = async () => {
    if (!username.trim() || !password.trim()) {
      toast.error("请填写账号和密码");
      return;
    }
    setLoggingIn(true);
    try {
      const data = await adminFetch<{ token: string }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      setPhase("ready");
      toast.success("登录成功");
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        toast.error("登录失败", { description: "请检查账号和密码" });
      } else if (e instanceof Error) {
        toast.error("登录失败", { description: e.message });
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = useCallback(() => {
    void adminFetch("/api/admin/session", { method: "DELETE" }).catch(() => {});
    clearToken();
    setPhase("login");
    toast.success("已退出登录");
  }, []);

  return (
    <main className="dvh-fill relative w-full overflow-x-clip bg-black">
      <div className="ambient-field" aria-hidden="true" />
      {mounted && (
        <>
          <StarsBackground className="z-0" />
          <ShootingStars className="z-0" />
        </>
      )}

      <div className="safe-viewport fold-aware relative z-10 mx-auto w-full max-w-4xl py-10 sm:py-14">
        {phase === "checking" && (
          <p className="py-24 text-center text-sm text-[color:var(--flow-muted)]">验证会话中…</p>
        )}

        {phase === "login" && (
          <section className="glass-card mx-auto mt-8 w-full max-w-sm p-7">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-500/10">
                  <ShieldCheck className="h-4.5 w-4.5 text-cyan-300" />
                </span>
                <div>
                  <p className="eyebrow text-[10px] text-cyan-300/80">ReForge Admin</p>
                  <h1 className="font-display text-lg font-semibold text-white">管理后台登录</h1>
                </div>
              </div>
            </div>

            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <div className="space-y-1.5">
                <Label className="text-neutral-300" htmlFor="admin-user">
                  账号
                </Label>
                <Input
                  id="admin-user"
                  value={username}
                  autoComplete="username"
                  placeholder="管理员账号"
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-neutral-300" htmlFor="admin-pass">
                  密码
                </Label>
                <Input
                  id="admin-pass"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  placeholder="管理员密码"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <motion.button
                {...glassInteraction}
                onClick={() => void login()}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-neutral-900 shadow-lg"
              >
                登录
              </motion.button>
            </form>

            <p className="mt-5 border-t border-white/5 pt-4 text-xs leading-relaxed text-[color:var(--flow-muted)]">
              开发环境默认账号 admin / flow123，可用环境变量 FLOW_ADMIN_USER、FLOW_ADMIN_PASS 覆盖。
            </p>

            <div className="mt-4">
              <Link href="/" className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white">
                <ArrowLeft className="h-3.5 w-3.5" /> 返回收集表
              </Link>
            </div>
          </section>
        )}

        {phase === "ready" && (
          <>
            {/* 后台顶栏 */}
            <header className="glass-card mb-8 flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <p className="eyebrow text-[10px] text-cyan-300/80">ReForge Admin / 流程再造工程收集表 · 管理后台</p>
                <h1 className="font-display mt-1.5 text-xl font-semibold text-white">
                  已收集流程管理
                </h1>
              </div>
              <div className="flex items-center gap-3">
                <motion.button {...glassInteraction} onClick={() => router.push("/")} className="rounded-full">
                  <LiquidGlass
                    tint={0.12}
                    scale={24}
                    bevelDepth={10}
                    aberration={2}
                    className={GLASS_SHADOW}
                    contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" /> 返回前台
                  </LiquidGlass>
                </motion.button>
                <motion.button {...glassInteraction} onClick={logout} className="rounded-full">
                  <LiquidGlass
                    tint={0.12}
                    scale={24}
                    bevelDepth={10}
                    aberration={2}
                    className={GLASS_SHADOW}
                    contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm"
                  >
                    <LogOut className="h-4 w-4" /> 退出登录
                  </LiquidGlass>
                </motion.button>
              </div>
            </header>

            <SystemsManager onLogout={logout} />
            <ProcessManager onLogout={logout} onPreviewChart={(p) => setChart({ name: p.name, steps: p.steps })} />
          </>
        )}
      </div>

      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
    </main>
  );
}
