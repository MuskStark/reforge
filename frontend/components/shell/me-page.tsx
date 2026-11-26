"use client";

/**
 * 「我的」:手机底部 Tab 栏的第四页。桌面端这些入口都在侧栏底部(「提交流程」按钮和账号菜单),
 * 所以宽屏进到这一页会直接去工作台。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, LogOut, Plus, Presentation, Settings, UserRound } from "lucide-react";
import { AppShell, announceUser, useLogout } from "@/components/shell/app-shell";
import { ProfileDialog } from "@/components/auth/profile-dialog";
import { Avatar } from "@/components/projects/stage-rail";
import type { SessionUser } from "@/lib/auth";
import { JOB_ROLE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function MePage() {
  return <AppShell active="me">{(me) => <MeBody me={me} />}</AppShell>;
}

function Row({
  icon,
  tone,
  label,
  sub,
  href,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  tone?: string;
  label: string;
  sub?: string;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  const body = (
    <>
      <span className={cn("me-ic", tone)} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      {href && <ChevronRight aria-hidden="true" />}
    </>
  );
  const cls = cn("me-row", danger && "danger");
  return href ? (
    <Link href={href} prefetch={false} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cn(cls, "w-full text-left")}>
      {body}
    </button>
  );
}

function MeBody({ me }: { me: SessionUser }) {
  const router = useRouter();
  const logout = useLogout();
  const [profileOpen, setProfileOpen] = useState(false);
  const name = me.displayName || me.username;

  // 桌面端这些入口都在侧栏底部,这一页只给手机用:宽屏进来直接去工作台
  useEffect(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) router.replace("/work");
  }, [router]);
  const roleLabel = me.role === "admin" ? "管理员" : me.jobRole ? JOB_ROLE_LABEL[me.jobRole] : "无岗位";
  // 无岗位的纯提交人看不到全局大屏
  const showMonitor = me.role === "admin" || Boolean(me.jobRole);

  return (
    <>
      <header className="pg-head">
        <div className="pg-head-text">
          <h1>我的</h1>
        </div>
      </header>

      <section className="glass-card me-card">
        <Avatar name={name} size={44} />
        <div className="min-w-0 flex-1">
          <p className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-neutral-900">{name}</p>
          <p className="mt-0.5 truncate text-[13px] leading-relaxed text-[color:var(--ink-2)]">
            {me.department || "未填写部门"} · @{me.username}
          </p>
          <span className="badge badge-plain mt-1.5">{roleLabel}</span>
        </div>
      </section>

      <p className="me-group-label">工作空间</p>
      <section className="glass-card me-list">
        {showMonitor && <Row icon={<Presentation />} label="数据大屏" sub="全公司流程的运行情况" href="/monitor" />}
        <Row icon={<Plus />} tone="green" label="提交流程" sub="申报一条需要再造的流程" href="/" />
      </section>

      {me.role === "admin" && (
        <>
          <p className="me-group-label">系统管理</p>
          <section className="glass-card me-list">
            <Row icon={<Settings />} tone="indigo" label="管理后台" sub="流程定义、系统库、用户与模板" href="/admin/processes" />
          </section>
        </>
      )}

      <p className="me-group-label">账号</p>
      <section className="glass-card me-list">
        <Row icon={<UserRound />} tone="gray" label="个人信息" sub="显示名、部门、修改密码" onClick={() => setProfileOpen(true)} />
        <Row icon={<LogOut />} label="退出登录" onClick={() => void logout()} danger />
      </section>
      <p className="mt-3 px-1 text-xs text-[color:var(--ink-3)]">登录会话 24 小时有效，退出后需要重新登录。</p>

      {profileOpen && <ProfileDialog me={me} onClose={() => setProfileOpen(false)} onSaved={announceUser} />}
    </>
  );
}
