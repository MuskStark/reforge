"use client";

/**
 * 应用外壳:所有登录后的页面共用(工作台 / 流程项目 / 通知 / 项目详情 / 管理后台 / 我的)。
 * 桌面是左侧悬浮侧栏,平板收成图标条,手机换成底部 Tab 栏;导航分两组——
 * 「工作空间」与「系统管理」(仅管理员)。数据大屏是全屏页,不套这层外壳。
 *
 * 登录只有一个入口:未登录(或任意请求 401)一律去 /login,登完回工作台。
 * 首次登录还没改密码的,先在当前页改密码——改完之前服务端会拒绝其他所有接口。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronUp, LogOut, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { LoginCard, BrandMark } from "@/components/auth/login-card";
import { ProfileDialog } from "@/components/auth/profile-dialog";
import { Avatar } from "@/components/projects/stage-rail";
import { authFetch, clearSession, getToken, getUser, type SessionUser } from "@/lib/auth";
import { JOB_ROLE_LABEL } from "@/lib/labels";
import { ADMIN_NAV, WORK_NAV, cachedTodoCount, cachedUnreadCount, saveTodoCount, saveUnreadCount, type ShellNavItem, type ShellSection } from "@/lib/shell-nav";
import { computeWorkbench } from "@/lib/workbench";
import type { PendingReview, ProjectView, WorkItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 手机底部 Tab 栏:「我的」只在手机上有这一页(桌面端这些入口在侧栏底部) */
const ME_ITEM: ShellNavItem = { id: "me", href: "/me", label: "我的", short: "我的", icon: UserRound };
const MOBILE_TABS: ShellNavItem[] = [WORK_NAV[0], { ...WORK_NAV[1], short: "项目" }, WORK_NAV[2], ME_ITEM];

const WAITING = <p className="py-24 text-center text-sm text-[color:var(--ink-2)]">验证会话中…</p>;

/** 地址 → 当前所在的导航项(取匹配最长的那条:/projects/abc 属于「流程项目」) */
function sectionOf(pathname: string): ShellSection | undefined {
  let best: ShellNavItem | undefined;
  for (const item of [...WORK_NAV, ...ADMIN_NAV, ME_ITEM]) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best?.id;
}

/** 页面在改动通知后调用,让外壳立刻刷新未读角标 */
export function pokeNotifications() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:notifications-changed"));
}

/** 退出登录:清掉本地会话与角标数字,回到登录页 */
export function useLogout() {
  const router = useRouter();
  return useCallback(async () => {
    void authFetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    clearSession();
    saveTodoCount(0);
    saveUnreadCount(0);
    toast.success("已退出登录");
    router.replace("/login");
  }, [router]);
}

/** 别处改了个人资料(如「我的」页)后调用:外壳里的姓名、头像跟着更新 */
export function announceUser(user: SessionUser) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("reforge:user-updated", { detail: user }));
}

/** 工作台算好待办后调用:外壳直接用这个数,不必自己再请求一遍 */
export function announceTodo(count: number) {
  saveTodoCount(count);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("reforge:todo-set", { detail: count }));
}

function NavItem({ item, active, count, alert }: { item: ShellNavItem; active?: ShellSection; count?: number; alert?: boolean }) {
  const Icon = item.icon;
  const n = count && count > 0 ? (count > 99 ? "99+" : count) : null;
  return (
    <Link
      href={item.href}
      // 整页预取:切换导航时页面框架已在本地,只剩页面自己的数据请求要过隧道。
      // 站内其余链接一律 prefetch={false}(页面都是动态渲染、没有 loading 边界)
      prefetch={active !== item.id}
      aria-current={active === item.id ? "page" : undefined}
      title={item.label}
      className={cn("sb-item", active === item.id && "on")}
    >
      <Icon aria-hidden="true" />
      <span className="sb-item-label">{item.label}</span>
      {n && <span className={cn("sb-count", alert ? "alert" : "quiet")}>{n}</span>}
    </Link>
  );
}

export function AppShell({
  active,
  requireAdmin,
  mobileHeader,
  mobileTabs = true,
  children,
}: {
  /** 当前所在的导航项;不传就按地址推断 */
  active?: ShellSection;
  /** 这一页只有管理员能进:其他人直接回工作台 */
  requireAdmin?: boolean;
  /** 手机顶部栏的内容(默认是品牌 + 头像)。全屏推入的二级页用它换成「返回 + 标题」 */
  mobileHeader?: React.ReactNode;
  /** 手机上是否显示底部 Tab 栏(二级页不显示) */
  mobileTabs?: boolean;
  /** 普通节点,或 (me) => 节点:函数形式只在登录就绪后才调用,页面内容不会在未登录时提前挂载去取数 */
  children: React.ReactNode | ((me: SessionUser) => React.ReactNode);
}) {
  const router = useRouter();
  const pathname = usePathname();
  const current = active ?? sectionOf(pathname ?? "");

  const [phase, setPhase] = useState<"checking" | "auth" | "ready">("checking");
  const [me, setMe] = useState<SessionUser | null>(null);
  const [unread, setUnread] = useState(0);
  const [todo, setTodo] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navClipped, setNavClipped] = useState(false);
  const leaving = useRef(false);
  const todoTimer = useRef<number | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 本地已有会话:先用缓存用户进入就绪态,页面立刻开始取数,不必等 /api/auth/me 返回
  // (隧道上每次往返都要几百毫秒起)。真实校验仍在下面的请求里做,令牌失效会去登录页。
  // 放在 layout effect 里:服务端渲染与水合首帧保持"验证会话中…"一致,不会水合不匹配,
  // 客户端切换页面时也在绘制前切到就绪态,不会闪一下"验证会话中…"。
  useLayoutEffect(() => {
    const cached = getToken() ? getUser() : null;
    if (cached) {
      setMe(cached);
      setPhase("ready");
    }
    // 上一页留下的角标数字:先用着,下面再校准
    setUnread(cachedUnreadCount());
    setTodo(cachedTodoCount());
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
      } catch (e) {
        // 令牌失效:去登录。网络抖动:有缓存用户就先继续用,页面自己的请求会各自报错
        if (e instanceof Error && e.message === "UNAUTHORIZED") {
          setMe(null);
          setPhase("auth");
        } else if (!getUser()) {
          setPhase("auth");
        }
      }
    })();
  }, []);

  // 未登录 / 会话失效:去唯一的登录页,登完回工作台
  useEffect(() => {
    if (phase !== "auth" || leaving.current) return;
    leaving.current = true;
    router.replace("/login");
  }, [phase, router]);

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

  // 个人资料在别处(「我的」页)改了:姓名与头像跟着变
  useEffect(() => {
    const onUser = (e: Event) => {
      const user = (e as CustomEvent<SessionUser>).detail;
      if (user) setMe(user);
    };
    window.addEventListener("reforge:user-updated", onUser);
    return () => window.removeEventListener("reforge:user-updated", onUser);
  }, []);

  // 管理后台只给管理员:其他人直接回工作台(侧栏里也看不到「系统管理」这一组)
  const denied = Boolean(phase === "ready" && me && requireAdmin && me.role !== "admin");
  useEffect(() => {
    if (!denied || leaving.current) return;
    leaving.current = true;
    router.replace("/work");
  }, [denied, router]);

  const isAdmin = me?.role === "admin";

  // 侧栏导航被窗口高度截断时,底部做一道渐隐提示下面还有
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setNavClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [phase, isAdmin]);

  /** 重新算「我的待办」。在工作台上页面自己算完会广播,这里不再重复请求 */
  const loadTodo = useCallback(async () => {
    if (window.location.pathname === "/work") return;
    try {
      const [ps, rv, mine] = await Promise.all([
        authFetch<ProjectView[]>("/api/projects", { cache: "no-store" }),
        authFetch<PendingReview[]>("/api/reviews/pending", { cache: "no-store" }),
        authFetch<WorkItem[]>("/api/me/items", { cache: "no-store" }),
      ]);
      const n = computeWorkbench(me!, ps, rv ?? [], mine ?? []).total;
      saveTodoCount(n);
      setTodo(n);
    } catch {
      /* 会话失效由事件处理;网络抖动就先沿用上一个数 */
    }
  }, [me]);
  const scheduleTodo = useCallback(
    (delay: number) => {
      if (todoTimer.current) window.clearTimeout(todoTimer.current);
      todoTimer.current = window.setTimeout(() => {
        todoTimer.current = null;
        void loadTodo();
      }, delay);
    },
    [loadTodo],
  );

  useEffect(() => {
    if (phase !== "ready" || !me || me.mustChangePassword) return;
    const onSet = (e: Event) => setTodo((e as CustomEvent<number>).detail ?? 0);
    // 任何会改变待办的写操作之后重算;连着几次写操作合并成一次请求
    const onChange = () => scheduleTodo(900);
    window.addEventListener("reforge:todo-set", onSet);
    window.addEventListener("reforge:todo-changed", onChange);
    // 稍等一下再取:先让页面自己的首屏请求走完,别在隧道上抢道
    const first = window.setTimeout(() => void loadTodo(), 1500);
    return () => {
      window.removeEventListener("reforge:todo-set", onSet);
      window.removeEventListener("reforge:todo-changed", onChange);
      window.clearTimeout(first);
      if (todoTimer.current) window.clearTimeout(todoTimer.current);
    };
  }, [phase, me?.id, me?.role, me?.jobRole, me?.mustChangePassword, loadTodo, scheduleTodo]);

  const loadUnread = useCallback(async () => {
    try {
      const d = await authFetch<{ unread: number }>("/api/notifications?unread=1");
      saveUnreadCount(d.unread);
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

  // 账号菜单:点外面或按 Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [menuOpen]);

  const logout = useLogout();

  if (phase !== "ready" || !me || denied) return WAITING;

  // 首次登录(管理员设定的初始密码还没换):除了改密码什么都做不了
  if (me.mustChangePassword) {
    return (
      <main className="dvh-fill relative w-full overflow-x-clip">
        <div className="ambient-field" aria-hidden="true" />
        <ProfileDialog me={me} forced onClose={() => {}} onSaved={setMe} onLogout={() => void logout()} />
      </main>
    );
  }

  const name = me.displayName || me.username;
  const roleLabel = me.role === "admin" ? "管理员" : me.jobRole ? JOB_ROLE_LABEL[me.jobRole] : "无岗位";
  // 无岗位的纯提交人:不看全局大屏(侧栏与移动 Tab 共用这组导航)
  const workNav = me.role !== "admin" && !me.jobRole ? WORK_NAV.filter((i) => i.id !== "monitor") : WORK_NAV;

  const sidebar = (
    <aside className="app-sidebar">
      <Link href="/work" prefetch={current !== "work"} className="sb-brand" aria-label="ReForge 工作台">
        <span className="sb-brand-mark">
          <BrandMark className="h-4 w-4" />
        </span>
        <span className="sb-brand-name">ReForge</span>
      </Link>

      <div ref={scrollRef} className={cn("sb-scroll", navClipped && "is-overflow")}>
        <p className="sb-group-label">工作空间</p>
        <nav className="sb-nav" aria-label="工作空间">
          {workNav.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={current}
              count={item.id === "work" ? todo : item.id === "inbox" ? unread : undefined}
              alert={item.id === "inbox"}
            />
          ))}
        </nav>
        {isAdmin && (
          <>
            <div className="sb-group-rule" aria-hidden="true" />
            <p className="sb-group-label">系统管理</p>
            <nav className="sb-nav" aria-label="系统管理">
              {ADMIN_NAV.map((item) => (
                <NavItem key={item.id} item={item} active={current} />
              ))}
            </nav>
          </>
        )}
      </div>

      {/* 全站唯一的"创建"入口 */}
      <Link href="/" prefetch={false} className="btn btn-primary sb-cta" title="提交流程">
        <Plus className="h-[17px] w-[17px]" aria-hidden="true" />
        <span className="sb-cta-label">提交流程</span>
      </Link>

      <div ref={accountRef} className="sb-account">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="sb-user"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="账号菜单"
        >
          <Avatar name={name} size={32} />
          <span className="sb-user-name">
            <b>{name}</b>
            <span>{roleLabel}</span>
          </span>
          <ChevronUp className={cn("transition-transform", menuOpen && "rotate-180")} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="sb-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="sb-menu-item"
              onClick={() => {
                setMenuOpen(false);
                setProfileOpen(true);
              }}
            >
              <UserRound aria-hidden="true" /> 个人信息
            </button>
            <div className="sb-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="sb-menu-item danger"
              onClick={() => {
                setMenuOpen(false);
                void logout();
              }}
            >
              <LogOut aria-hidden="true" /> 退出登录
            </button>
          </div>
        )}
      </div>
    </aside>
  );

  const tabs = (
    <nav className="m-tabs lg-clear" aria-label="主导航">
      {MOBILE_TABS.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          prefetch={current !== item.id}
          aria-current={current === item.id ? "page" : undefined}
          className={cn("m-tab", current === item.id && "on")}
        >
          <item.icon aria-hidden="true" />
          {item.short ?? item.label}
          {item.id === "work" && todo > 0 && <span className="sb-count quiet">{todo > 99 ? "99+" : todo}</span>}
          {item.id === "inbox" && unread > 0 && <span className="sb-count alert">{unread > 99 ? "99+" : unread}</span>}
        </Link>
      ))}
    </nav>
  );

  return (
    <main className="dvh-fill relative w-full overflow-x-clip">
      <div className="ambient-field app-shell-bg" aria-hidden="true" />
      {sidebar}

      {/* 内容区:沿用折叠屏的收窄避让(fold-aware) */}
      <div className="app-page fold-aware">
        {mobileHeader ?? (
          <header className="m-top lg-clear">
            <Link href="/work" prefetch={current !== "work"} className="sb-brand" aria-label="ReForge 工作台">
              <span className="sb-brand-mark">
                <BrandMark className="h-4 w-4" />
              </span>
              <span className="sb-brand-name">ReForge</span>
            </Link>
            <Link href="/me" prefetch={current !== "me"} className="ml-auto" aria-label="我的">
              <Avatar name={name} size={34} />
            </Link>
          </header>
        )}
        {typeof children === "function" ? children(me) : children}
      </div>

      {mobileTabs && tabs}

      {profileOpen && <ProfileDialog me={me} onClose={() => setProfileOpen(false)} onSaved={setMe} />}
    </main>
  );
}

/** 页头:大标题 · 一句话说明 · 右侧操作。每个页面都长这样 */
export function PageHead({
  title,
  subtitle,
  back,
  size,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 大标题左上方的返回入口 */
  back?: { href: string; label: string };
  /** md 用于标题本身是内容(如项目名)的页面 */
  size?: "lg" | "md";
  /** 右侧的操作 */
  children?: React.ReactNode;
}) {
  return (
    <header className="pg-head">
      <div className="pg-head-text">
        {back && (
          <Link href={back.href} prefetch={false} className="pg-back">
            <ChevronLeft aria-hidden="true" />
            {back.label}
          </Link>
        )}
        <h1 className={size === "md" ? "pg-title-md" : undefined}>{title}</h1>
        {subtitle && <p className="pg-lede">{subtitle}</p>}
      </div>
      {children ? <div className="pg-actions">{children}</div> : null}
    </header>
  );
}

/** 加载 / 空状态 */
export function StateLine({ children }: { children: React.ReactNode }) {
  return <p className="glass-card px-5 py-14 text-center text-sm text-[color:var(--ink-3)]">{children}</p>;
}

export function roleName(user: SessionUser | null): string {
  if (!user) return "";
  return user.role === "admin" ? "管理员" : user.jobRole ? JOB_ROLE_LABEL[user.jobRole] : "无岗位";
}
