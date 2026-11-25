"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { ProcessManager } from "@/components/admin/process-manager";
import { SystemsManager } from "@/components/admin/systems-manager";
import { UsersManager } from "@/components/admin/users-manager";
import { StageTemplates } from "@/components/admin/stage-templates";
import { NotifyChannels } from "@/components/admin/notify-channels";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { EditProcessModal } from "@/components/followup/edit-process-modal";
import { ADMIN_NAV, type AdminSectionKey } from "@/lib/shell-nav";
import type { FlowProcess } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 管理后台的一个分区:流程定义 / 线上系统库 / 用户与岗位 / 阶段模板 / 通知渠道。
 * 套的是和前台同一层外壳,只是侧栏高亮在「系统管理」这一组;非管理员进不来,会被外壳送回工作台。
 * 流程的推进与评审不在后台,而在「流程项目」(见 docs/process-management-architecture.md 第 14 节)。
 */
export function AdminSection({ section }: { section: AdminSectionKey }) {
  const [chart, setChart] = useState<ChartSource | null>(null);
  const [editing, setEditing] = useState<FlowProcess | null>(null);
  // 保存流程定义后加一,流程定义列表据此重读
  const [edited, setEdited] = useState(0);

  return (
    <AppShell active={`admin:${section}`} requireAdmin mobileTabs={false} mobileHeader={<AdminMobileNav section={section} />}>
      {section === "processes" && (
        <ProcessManager onPreviewChart={(p) => setChart({ name: p.name, steps: p.steps })} onEdit={setEditing} reloadKey={edited} />
      )}
      {section === "systems" && <SystemsManager />}
      {section === "users" && <UsersManager />}
      {section === "stages" && <StageTemplates />}
      {section === "channels" && <NotifyChannels />}

      {/* 弹层放在最外层:卡片带背景模糊,会把 fixed 的弹层困在里面 */}
      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
      {editing && (
        <EditProcessModal
          process={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setEdited((n) => n + 1);
          }}
        />
      )}
    </AppShell>
  );
}

/** 手机:管理后台是从「我的」全屏推入的二级页 —— 顶部是「返回 + 标题」,下面一条可横向滑动的分区切换条 */
function AdminMobileNav({ section }: { section: AdminSectionKey }) {
  return (
    <>
      <nav className="m-nav lg-clear" aria-label="管理后台">
        <Link href="/me" prefetch={false} className="m-nav-back">
          <ChevronLeft aria-hidden="true" />
          我的
        </Link>
        <span className="m-nav-title">管理后台</span>
      </nav>
      <nav className="m-secs" aria-label="后台分区">
        {ADMIN_NAV.map((item) => (
          <Link key={item.id} href={item.href} prefetch={item.id !== `admin:${section}`} className={item.id === `admin:${section}` ? "on" : undefined} aria-current={item.id === `admin:${section}` ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
