"use client";

/**
 * 带导航的应用外壳:工作台 / 流程项目 / 通知 / 项目详情 / 通知中心共用。
 * 未登录时显示登录卡;会话失效(任意请求 401)时自动回到登录。
 */

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, LayoutGrid, LogOut, Monitor, ShieldCheck, UserRound, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { LoginCard, BrandMark } from "@/components/auth/login-card";
import { ProfileDialog } from "@/components/auth/profile-dialog";
import { authFetch, clearSession, getToken, getUser, type SessionUser } from "@/lib/auth";
import { JOB_ROLE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type ShellSection = "work" | "projects" | "inbox";

/** 页面在改动通知后调用,让外壳立刻刷新未读角标 */
export function pokeNotifications() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:notifications-changed"));
}

export function AppShell({
  active,
  children,
}: {
  active?: ShellSection;
  /** 普通节点,或 (me) => 节点:函数形式只在登录就绪后才调用,页面内容不会在未登录时提前挂载去取数 */
  children: React.ReactNode | ((me: SessionUser) => React.ReactNode);
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"checking" | "auth" | "ready">("checking");
  const [me, setMe] = useState<SessionUser | null>(null);
  const [unread, setUnread] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);

  // 本地已有会话:先用缓存用户进入就绪态,页面立刻开始取数,不必等 /api/auth/me 返回
  // (隧道上每次往返都要几百毫秒起)。真实校验仍在下面的请求里做,令牌失效会回到登录。
  // 放在 layout effect 里:服务端渲染与水合首帧保持"验证会话中…"一致,不会水合不匹配,
  // 客户端切换页面时也在绘制前切到就绪态,不会闪一下"验证会话中…"。
  useLayoutEffect(() => {
    const cached = getToken() ? getUser() : null;
    if (cached) {
      setMe(cached);
      setPhase("ready");
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setPhase("auth");
        return;
      }
      try {
        setMe(await authFetch<SessionUser>("/api/auth/me"));
        setPhase("ready");
      } catch {
        setMe(null);
        setPhase("auth");
      }
    })();
  }, []);

  // 会话失效:authFetch 清掉本地会话后会广播这个事件
  useEffect(() => {
    const onLost = () => {
      setMe(null);
      setPhase("auth");
    };
    window.addEventListener("reforge:unauthorized", onLost);
    return () => window.removeEventListener("reforge:unauthorized", onLost);
  }, []);

  // 服务端以"必须先改密码"拒绝了某个请求:回到强制改密
  useEffect(() => {
    const onRequired = () => setMe((m) => (m ? { ...m, mustChangePassword: true } : m));
    window.addEventListener("reforge:password-required", onRequired);
    return () => window.removeEventListener("reforge:password-required", onRequired);
  }, []);

  const loadUnread = useCallback(async () => {
    try {
      const d = await authFetch<{ unread: number }>("/api/notifications?unread=1");
      setUnread(d.unread);
    } catch {
      /* 会话失效由事件处理 */
    }
  }, []);

  useEffect(() => {
    // 还没完成首次登录改密时,通知接口也会被拒绝,不必轮询
    if (phase !== "ready" || me?.mustChangePassword) return;
    void loadUnread();
    const t = setInterval(() => void loadUnread(), 30_000);
    const poke = () => void loadUnread();
    window.addEventListener("reforge:notifications-changed", poke);
    return () => {
      clearInterval(t);
      window.removeEventListener("reforge:notifications-changed", poke);
    };
  }, [phase, loadUnread, me?.mustChangePassword]);

  const logout = useCallback(async () => {
    void authFetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    clearSession();
    setMe(null);
    setPhase("auth");
    toast.success("已退出登录");
  }, []);

  if (phase === "checking") {
    return <p className="py-24 text-center text-sm text-[color:var(--ink-2)]">验证会话中…</p>;
  }

  if (phase === "auth" || !me) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center py-10">
        <LoginCard
          title="登录 ReForge"
          note={
            <p className="text-xs leading-relaxed text-[color:var(--tint-deep)]">
              登录后进入工作台：项目经理推进流程改造，CTO 评审方案，经办确认需求与试运行。
              没有账号请联系管理员开通。
            </p>
          }
          onLoggedIn={(user) => {
            setMe(user);
            setPhase("ready");
          }}
        />
      </div>
    );
  }

  // 首次登录(管理员设定的初始密码还没换):除了改密码什么都做不了,服务端同样会拒绝其他请求
  if (me.mustChangePassword) {
    return (
      <main className="dvh-fill relative w-full overflow-x-clip">
        <div className="ambient-field" aria-hidden="true" />
        <ProfileDialog me={me} forced onClose={() => {}} onSaved={setMe} onLogout={() => void logout()} />
      </main>
    );
  }

  const roleLabel = me?.role === "admin" ? "管理员" : me?.jobRole ? JOB_ROLE_LABEL[me.jobRole] : "成员";
  const nav: { id: ShellSection; href: string; label: string; icon: typeof Bell }[] = [
    { id: "work", href: "/work", label: "工作台", icon: LayoutGrid },
    { id: "projects", href: "/projects", label: "流程项目", icon: Waypoints },
    { id: "inbox", href: "/inbox", label: "通知", icon: Bell },
  ];
  return (
    <main className="dvh-fill relative w-full overflow-x-clip">
      <div className="ambient-field" aria-hidden="true" />

      <div className="safe-viewport fold-aware relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-14 pt-3 sm:px-6 sm:pt-5">
        {/* 顶栏:Clear 玻璃 */}
        <header className="lg-clear sticky top-2.5 z-40 mb-4 flex min-h-[54px] flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 pr-1.5">
          <Link href="/work" prefetch={false} className="flex items-center gap-2.5">
            <span
              className="grid h-7 w-7 place-items-center rounded-[8px] text-white"
              style={{
                background: "linear-gradient(180deg, #2b95ff, #0071e3)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px -3px rgba(0,113,227,0.6)",
              }}
            >
              <BrandMark className="h-4 w-4" />
            </span>
            <span className="text-[17px] font-semibold tracking-[-0.02em]">ReForge</span>
          </Link>

          <nav className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 sm:order-2 sm:mx-0 sm:w-auto sm:flex-1 sm:overflow-visible" aria-label="主导航">
            {nav.map(({ id, href, label, icon: Icon }) => (
              <Link
                key={id}
                href={href}
                // 整页预取:切换导航时页面框架已在本地,只剩页面自己的数据请求要过隧道。
                // 站内其余链接一律 prefetch={false}:页面都是动态渲染、没有 loading 边界,
                // Next 默认的部分预取结果用不上,列表里每一项都会白白发一次穿隧道的请求
                prefetch={active !== id}
                aria-current={active === id ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition",
                  active === id ? "bg-white/90 text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,1),0_3px_10px_-5px_rgba(23,42,80,0.25)]" : "text-[color:var(--ink-2)] hover:bg-white/45 hover:text-neutral-900",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
                {id === "inbox" && unread > 0 && (
                  <span className="font-data grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[color:var(--red)] px-1 text-[10px] font-bold text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="order-2 ml-auto flex items-center gap-1.5 sm:order-3">
            <span className="lg-chip hidden items-center gap-2 py-1 pl-1.5 pr-2 sm:inline-flex">
              <span
                className="grid h-[26px] w-[26px] place-items-center rounded-full text-[11px] font-semibold"
                style={{ background: "linear-gradient(180deg,#b8ccff,#9db4ff)", color: "#21407a" }}
              >
                {(me?.displayName || me?.username || "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="max-w-[120px] truncate text-[13px] font-medium">{me?.displayName || me?.username}</span>
              <span className="rounded-full bg-[rgba(120,120,128,0.12)] px-2 py-1 text-[11px] font-medium text-[color:var(--ink-2)]">
                {roleLabel}
              </span>
            </span>
            {me?.role === "admin" && (
              <Link
                href="/admin"
                prefetch={false}
                className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)] sm:inline-flex"
                title="管理后台"
              >
                <ShieldCheck className="h-4 w-4" /> 后台
              </Link>
            )}
            <button type="button" onClick={() => setProfileOpen(true)} className="icon-btn !h-9 !w-9" title="个人信息" aria-label="个人信息">
              <UserRound className="h-4 w-4" />
            </button>
            <Link
              href="/monitor"
              prefetch={false}
              className="icon-btn !h-9 !w-9"
              title="数据大屏"
              aria-label="数据大屏"
            >
              <Monitor className="h-4 w-4" />
            </Link>
            <button type="button" onClick={() => router.push("/")} className="icon-btn !h-9 !w-9" title="返回前台" aria-label="返回前台">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 6l-6 6 6 6" />
              </svg>
            </button>
            <button type="button" onClick={() => void logout()} className="icon-btn !h-9 !w-9" title="退出登录" aria-label="退出登录">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        {typeof children === "function" ? children(me) : children}
      </div>

      {profileOpen && <ProfileDialog me={me} onClose={() => setProfileOpen(false)} onSaved={setMe} />}
    </main>
  );
}

/** 页面标题行:标题 + 说明 + 右侧操作 */
export function PageHead({
  title,
  subtitle,
  back,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      {back && (
        <Link
          href={back.href}
          prefetch={false}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 6l-6 6 6 6" />
          </svg>
          {back.label}
        </Link>
      )}
      <h1 className="min-w-0 text-[24px] font-bold leading-tight tracking-[-0.02em] text-neutral-900">{title}</h1>
      <div className="ml-auto flex flex-wrap items-center gap-2.5">{children}</div>
      {subtitle && <p className="w-full text-[13px] leading-relaxed text-[color:var(--ink-2)]">{subtitle}</p>}
    </div>
  );
}

/** 加载 / 空状态 */
export function StateLine({ children }: { children: React.ReactNode }) {
  return <p className="glass-card px-5 py-14 text-center text-sm text-[color:var(--ink-3)]">{children}</p>;
}

export function roleName(user: SessionUser | null): string {
  if (!user) return "";
  return user.role === "admin" ? "管理员" : user.jobRole ? JOB_ROLE_LABEL[user.jobRole] : "成员";
}
