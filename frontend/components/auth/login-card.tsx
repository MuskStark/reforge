"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Lock, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch, getToken, setSession, takeLoginReason, type SessionUser } from "@/lib/auth";

/** 品牌图形:分叉汇聚的流程节点(与前台同构) */
export function BrandMark({ className }: { className?: string }) {
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

/** 登录后的去向:?next= 指定的站内路径(如从收集表门卡过来带着 next=/),缺省回工作台。
 * 只接受站内路径且不以 // 开头,防止借登录页跳到外部站点。 */
function nextPath(): string {
  const v = new URLSearchParams(window.location.search).get("next") ?? "";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/work";
}

/**
 * 登录卡:只用在 /login 这一个地方(所有页面未登录都去那里)。
 * 登录或注册成功后进工作台;带着 ?next= 进来的(收集表门卡送来的)回到指定页——
 * 首次登录要先改密码的,进了工作台会立刻弹出改密框。
 */
export function LoginCard() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [hasUsers, setHasUsers] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 是否还有公开注册(仅首个用户):决定默认展示登录还是注册
  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => {
        setHasUsers(!!s.hasUsers);
        if (!s.hasUsers) setMode("register");
      })
      .catch(() => setHasUsers(true));
  }, []);

  const submit = async () => {
    if (!username.trim() || !password) {
      toast.error("请填写账号和密码");
      return;
    }
    if (mode === "register" && hasUsers) {
      toast.error("公开注册已关闭", { description: "账号由管理员在后台创建，请联系管理员" });
      return;
    }
    if (mode === "register" && password !== confirm) {
      toast.error("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const data = await authFetch<{ token: string; user: SessionUser }>(path, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setSession(data.token, data.user);
      if (data.user.mustChangePassword) {
        // 首次登录:进工作台后弹出不可关闭的改密框
        toast.info("首次登录，请先修改密码");
      } else {
        toast.success(
          mode === "register"
            ? data.user.role === "admin"
              ? "注册成功，你已成为管理员"
              : "注册成功"
            : `欢迎回来，${data.user.displayName || data.user.username}`,
        );
      }
      // 登录后的去向:默认工作台;从收集表门卡过来的回到表单
      router.replace(nextPath());
    } catch (e) {
      if (e instanceof Error && e.message !== "UNAUTHORIZED") {
        toast.error(mode === "register" ? "注册失败" : "登录失败", { description: e.message });
      } else {
        toast.error(mode === "register" ? "注册失败" : "登录失败", { description: "请检查账号和密码" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card w-full max-w-[400px] p-7 text-center sm:p-8">
      <span
        className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-[18px] text-white"
        style={{
          background: "linear-gradient(180deg, #2b95ff, #0071e3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -10px 18px -12px rgba(0,45,110,0.5), 0 10px 26px -10px rgba(0,113,227,0.65)",
        }}
      >
        <BrandMark className="h-8 w-8" />
      </span>
      <h1 className="text-[22px] font-bold tracking-[-0.02em]">登录 ReForge</h1>
      <p className="mt-1 text-[13px] text-[color:var(--ink-2)]">ReForge · 流程再造工程收集表</p>

      {!hasUsers && (
        <div className="seg mt-6">
          {(["login", "register"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={mode === m ? "on" : undefined}>
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>
      )}

      <form
        className="mt-6 space-y-4 text-left"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="login-user">账号</Label>
          <span className="relative block">
            <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[color:var(--ink-3)]" aria-hidden="true" />
            <Input
              id="login-user"
              value={username}
              autoComplete="username"
              placeholder="2-32 个字符"
              className="!h-[46px] pl-10"
              onChange={(e) => setUsername(e.target.value)}
            />
          </span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="login-pass">密码</Label>
          <span className="relative block">
            <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[color:var(--ink-3)]" aria-hidden="true" />
            <Input
              id="login-pass"
              type="password"
              value={password}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder="至少 6 位"
              className="!h-[46px] pl-10"
              onChange={(e) => setPassword(e.target.value)}
            />
          </span>
        </div>
        {mode === "register" && (
          <div className="space-y-1.5">
            <Label htmlFor="login-confirm">确认密码</Label>
            <Input
              id="login-confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              placeholder="再次输入密码"
              className="!h-[46px]"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}
        <button type="submit" disabled={busy} className="btn btn-primary !h-[50px] w-full text-[17px] disabled:opacity-60">
          {mode === "login" ? "登 录" : "注册并成为管理员"}
        </button>
      </form>

      <div className="mt-4 rounded-2xl bg-[color:var(--tint-soft)] px-3.5 py-2.5 text-left shadow-[inset_0_0_0_0.5px_rgba(0,113,227,0.16)]">
        <p className="text-xs leading-relaxed text-[color:var(--tint-deep)]">
          {mode === "register" && !hasUsers
            ? "当前尚无注册用户 —— 第一个注册的用户将自动成为管理员，注册后进入工作台。"
            : "登录后进入工作台：PM 推进流程改造，CTO 评审方案，BH 确认需求与试运行。没有账号请联系管理员开通。"}
        </p>
      </div>

      <div className="mt-5">
        <Link
          href="/"
          prefetch={false}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--tint)] transition hover:brightness-110"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回流程收集表
        </Link>
      </div>
    </section>
  );
}

/**
 * 登录页:/login 是全站唯一的登录入口。
 * 本地还有会话的(比如已经登录的人手输了这个地址):校验一下,还有效就直接进工作台;
 * 会话是过期断掉的:提示一句再让对方重新登录。
 */
export function LoginScreen() {
  const router = useRouter();

  useLayoutEffect(() => {
    if (takeLoginReason() === "expired") toast.info("登录已过期，请重新登录");
    if (!getToken()) return;
    const back = nextPath();
    void authFetch<SessionUser>("/api/auth/me")
      .then(() => router.replace(back))
      .catch(() => {
        /* 令牌已失效:留在登录页(401 的处理在 authFetch 里) */
      });
  }, [router]);

  return (
    <main className="dvh-fill relative w-full overflow-x-clip">
      {/* 环境光场:亮色极光(fixed,为玻璃提供可折射的色彩) */}
      <div className="ambient-field" aria-hidden="true" />
      <div className="login-center">
        <LoginCard />
      </div>
    </main>
  );
}
