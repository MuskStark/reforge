"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, LogOut, ShieldCheck, UserPlus, Users } from "lucide-react";
import { ShootingStars } from "@/components/ui/shooting-stars";
import { StarsBackground } from "@/components/ui/stars-background";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { ProcessManager } from "@/components/admin/process-manager";
import { SystemsManager } from "@/components/admin/systems-manager";
import { UsersManager } from "@/components/admin/users-manager";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { authFetch, clearSession, getToken, getUser, setSession, type SessionUser } from "@/lib/auth";
import { GLASS_SHADOW, useGlassInteraction } from "@/lib/glass";

type Phase = "checking" | "auth" | "member" | "admin";

export default function AdminPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [hasUsers, setHasUsers] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [chart, setChart] = useState<ChartSource | null>(null);
  const glassInteraction = useGlassInteraction();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 拉取注册状态（决定注册页提示文案与默认模式）
  const refreshStatus = useCallback(async () => {
    try {
      const status = await fetch("/api/auth/status", { cache: "no-store" }).then((r) => r.json());
      setHasUsers(!!status.hasUsers);
      return !!status.hasUsers;
    } catch {
      return true; // 获取失败按已有用户处理（保守提示）
    }
  }, []);

  // 启动：校验本地会话；未登录时拉取注册状态（决定是否默认展示注册）
  useEffect(() => {
    (async () => {
      const has = await refreshStatus();
      if (!has) setMode("register");
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
  }, [refreshStatus]);

  const submit = async () => {
    if (!username.trim() || !password.trim()) {
      toast.error("请填写账号和密码");
      return;
    }
    if (mode === "register" && hasUsers) {
      toast.error("公开注册已关闭", { description: "账号由管理员在后台创建，请联系管理员" });
      return;
    }
    if (mode === "register") {
      if (password !== confirm) {
        toast.error("两次输入的密码不一致");
        return;
      }
    }
    setBusy(true);
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const data = await authFetch<{ token: string; user: SessionUser }>(path, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setSession(data.token, data.user);
      setMe(data.user);
      toast.success(
        mode === "register"
          ? data.user.role === "admin"
            ? "注册成功，你已成为管理员"
            : "注册成功"
          : "登录成功",
      );
      setPhase(data.user.role === "admin" ? "admin" : "member");
      setConfirm("");
    } catch (e) {
      if (e instanceof Error && e.message !== "UNAUTHORIZED") {
        toast.error(mode === "register" ? "注册失败" : "登录失败", { description: e.message });
      } else {
        toast.error(mode === "register" ? "注册失败" : "登录失败", {
          description: "请检查账号和密码",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = useCallback(() => {
    void authFetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    clearSession();
    setMe(null);
    setPhase("auth");
    setMode("login");
    void refreshStatus(); // 刷新注册状态，注册页提示文案随之更新
    toast.success("已退出登录");
  }, [refreshStatus]);

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

        {phase === "auth" && (
          <section className="glass-card mx-auto mt-8 w-full max-w-sm p-7">
            <div className="mb-6">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-500/10">
                  <ShieldCheck className="h-4.5 w-4.5 text-cyan-300" />
                </span>
                <div>
                  <p className="eyebrow text-[10px] text-cyan-300/80">ReForge Admin</p>
                  <h1 className="font-display text-lg font-semibold text-white">
                    {mode === "login" ? "管理后台登录" : "注册账号"}
                  </h1>
                </div>
              </div>

              {/* 首个注册用户将成为管理员 */}
              {mode === "register" && !hasUsers && (
                <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-200">
                  当前尚无注册用户 —— <strong>第一个注册的用户将自动成为管理员</strong>，
                  注册后即可进入管理后台。
                </div>
              )}
              {mode === "register" && hasUsers && (
                <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-xs leading-relaxed text-[color:var(--flow-muted)]">
                  已有管理员。新注册账号为普通用户，进入后台需管理员权限。
                </div>
              )}
            </div>

            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
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
                  placeholder="2-32 个字符"
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
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  placeholder="至少 6 位"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {mode === "register" && (
                <div className="space-y-1.5">
                  <Label className="text-neutral-300" htmlFor="admin-confirm">
                    确认密码
                  </Label>
                  <Input
                    id="admin-confirm"
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
              )}
              <motion.button
                {...glassInteraction}
                onClick={() => void submit()}
                disabled={busy}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-neutral-900 shadow-lg disabled:opacity-60"
              >
                {mode === "login" ? "登录" : (
                  <>
                    <UserPlus className="h-4 w-4" />
                    {hasUsers ? "注册" : "注册并成为管理员"}
                  </>
                )}
              </motion.button>
            </form>

            <div className="mt-5 flex items-center justify-between border-t border-white/5 pt-4">
              {!hasUsers ? (
                <button
                  type="button"
                  onClick={() => setMode(mode === "login" ? "register" : "login")}
                  className="text-xs text-cyan-300 transition hover:text-cyan-200"
                >
                  {mode === "login" ? "没有账号？注册 →" : "已有账号？登录 →"}
                </button>
              ) : (
                <span className="text-xs text-[color:var(--flow-muted)]">
                  公开注册已关闭，账号由管理员创建
                </span>
              )}
              <Link href="/" className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white">
                <ArrowLeft className="h-3.5 w-3.5" /> 返回收集表
              </Link>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--flow-muted)]">
              首个注册用户自动成为管理员；环境变量引导账号（默认 admin / flow123）始终可用。
            </p>
          </section>
        )}

        {phase === "member" && (
          <section className="glass-card mx-auto mt-8 w-full max-w-sm p-7 text-center">
            <Users className="mx-auto h-8 w-8 text-neutral-400" />
            <h1 className="font-display mt-3 text-lg font-semibold text-white">
              {me?.username ?? "用户"}，你好
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-[color:var(--flow-muted)]">
              你已注册为<strong className="text-white">普通用户</strong>。
              流程收集在前台公开进行；管理后台（流程管理 / 系统库 / 用户）需要管理员账号。
            </p>
            <div className="mt-5 flex justify-center gap-3">
              <Link
                href="/"
                className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-neutral-900"
              >
                前往收集表
              </Link>
              <motion.button {...glassInteraction} onClick={logout} className="rounded-full">
                <LiquidGlass
                  tint={0.12}
                  scale={24}
                  bevelDepth={10}
                  aberration={2}
                  className={GLASS_SHADOW}
                  contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm"
                >
                  <LogOut className="h-4 w-4" /> 退出
                </LiquidGlass>
              </motion.button>
            </div>
          </section>
        )}

        {phase === "admin" && (
          <>
            {/* 后台顶栏 */}
            <header className="glass-card mb-8 flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <p className="eyebrow text-[10px] text-cyan-300/80">ReForge Admin / 流程再造工程收集表 · 管理后台</p>
                <h1 className="font-display mt-1.5 text-xl font-semibold text-white">
                  已收集流程管理
                  <span className="ml-3 inline-flex items-center gap-1 rounded-full bg-cyan-400/15 px-2.5 py-0.5 align-middle text-xs font-normal text-cyan-300">
                    <ShieldCheck className="h-3 w-3" />
                    {me?.username ?? "admin"}
                  </span>
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

            <UsersManager onLogout={logout} me={me} />
            <SystemsManager onLogout={logout} />
            <ProcessManager onLogout={logout} onPreviewChart={(p) => setChart({ name: p.name, steps: p.steps })} />
          </>
        )}
      </div>

      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
    </main>
  );
}
