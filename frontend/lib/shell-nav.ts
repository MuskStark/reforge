import type { LucideIcon } from "lucide-react";
import { Bell, LayoutGrid, ListChecks, Presentation, Send, Server, Users, Waypoints, Workflow } from "lucide-react";

/**
 * 应用外壳的一级导航。这两组就是全部入口:
 *   工作空间 —— 工作台 / 流程项目 / 通知 / 数据大屏(所有登录用户)
 *   系统管理 —— 管理后台的五个分区(仅管理员),每个分区一条地址
 * 本文件不带 "use client":路由页(服务端组件)也要读这里的数据。
 */

export type ShellSection =
  | "work"
  | "projects"
  | "inbox"
  | "monitor"
  | "me"
  | "admin:processes"
  | "admin:systems"
  | "admin:users"
  | "admin:stages"
  | "admin:channels";

export interface ShellNavItem {
  id: ShellSection;
  href: string;
  label: string;
  /** 手机底部 Tab 栏里的短名(放不下全称时用) */
  short?: string;
  icon: LucideIcon;
}

export const WORK_NAV: ShellNavItem[] = [
  { id: "work", href: "/work", label: "工作台", icon: LayoutGrid },
  { id: "projects", href: "/projects", label: "流程项目", icon: Waypoints },
  { id: "inbox", href: "/inbox", label: "通知", icon: Bell },
  { id: "monitor", href: "/monitor", label: "数据大屏", icon: Presentation },
];

/** 管理后台的五个分区;顺序就是侧栏与地址栏里的顺序 */
export const ADMIN_SECTIONS = ["processes", "systems", "users", "stages", "channels"] as const;
export type AdminSectionKey = (typeof ADMIN_SECTIONS)[number];

export const ADMIN_SECTION_META: Record<AdminSectionKey, { title: string; lede: string }> = {
  processes: { title: "流程定义", lede: "前台提交上来的流程及其步骤构成。流程的推进与评审在「流程项目」里进行，不在这里。" },
  systems: { title: "线上系统库", lede: "前台填写流程时可选的线上系统。增删即时生效。" },
  users: { title: "用户与岗位", lede: "公开注册已关闭，账号由管理员在这里创建。岗位决定每个人能在项目里做什么。" },
  stages: { title: "阶段模板", lede: "新立项的项目按这套阶段推进。修改只影响此后新建的项目，已立项的不变。" },
  channels: { title: "通知渠道", lede: "把项目的关键动态转发到企业微信、钉钉、飞书群或邮箱。地址与密钥只显示脱敏值。" },
};

export const ADMIN_NAV: ShellNavItem[] = [
  { id: "admin:processes", href: "/admin/processes", label: ADMIN_SECTION_META.processes.title, icon: Workflow },
  { id: "admin:systems", href: "/admin/systems", label: ADMIN_SECTION_META.systems.title, icon: Server },
  { id: "admin:users", href: "/admin/users", label: ADMIN_SECTION_META.users.title, icon: Users },
  { id: "admin:stages", href: "/admin/stages", label: ADMIN_SECTION_META.stages.title, icon: ListChecks },
  { id: "admin:channels", href: "/admin/channels", label: ADMIN_SECTION_META.channels.title, icon: Send },
];

export function isAdminSection(value: string): value is AdminSectionKey {
  return (ADMIN_SECTIONS as readonly string[]).includes(value);
}

/** 侧栏「工作台」后面显示的待办数 / 「通知」后面显示的未读数,跨页面时暂存在这里 */
const TODO_COUNT_KEY = "flow.admin.todo";
const UNREAD_COUNT_KEY = "flow.admin.unread";

function readCount(key: string): number {
  if (typeof window === "undefined") return 0;
  const n = Number(sessionStorage.getItem(key));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function saveCount(key: string, n: number) {
  try {
    if (n > 0) sessionStorage.setItem(key, String(n));
    else sessionStorage.removeItem(key);
  } catch {
    /* 存不进去就只在当前页有效 */
  }
}

export const cachedTodoCount = () => readCount(TODO_COUNT_KEY);
export const saveTodoCount = (n: number) => saveCount(TODO_COUNT_KEY, n);
export const cachedUnreadCount = () => readCount(UNREAD_COUNT_KEY);
export const saveUnreadCount = (n: number) => saveCount(UNREAD_COUNT_KEY, n);
