"use client";

/** 管理端会话存取（sessionStorage：关闭浏览器即登出） */
const TOKEN_KEY = "flow.admin.token";
const USER_KEY = "flow.admin.user";

import type { JobRole } from "@/lib/types";

export interface SessionUser {
  /** users.id;环境变量引导的管理员为空字符串 */
  id: string;
  username: string;
  /** 系统角色:只决定能否进管理后台 */
  role: "admin" | "member";
  displayName: string;
  department: string;
  /** 全局岗位;引导管理员为空字符串 */
  jobRole: JobRole | "";
  /** 为 true 表示管理员设定的初始密码还没换:改完之前只能改密码,其他接口都会被拒绝 */
  mustChangePassword?: boolean;
}

/** 改完资料或密码后更新本地缓存的用户(与 /api/auth/me 的返回同构) */
export function setSessionUser(user: SessionUser) {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

/** 携带 Bearer 令牌的 fetch；401 时清除本地会话并抛错供调用方处理 */
export async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearSession();
    // 通知应用外壳:会话已失效,回到登录页
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }
  const data = await res.json();
  if (!res.ok) {
    const { error, code } = (data ?? {}) as { error?: string; code?: string };
    const err = new Error(error ?? "请求失败") as Error & { code?: string };
    err.code = code;
    // 服务端要求先改密码(首次登录):通知应用外壳立刻弹出强制改密
    if (res.status === 403 && code === "PASSWORD_CHANGE_REQUIRED") {
      window.dispatchEvent(new Event("reforge:password-required"));
    }
    throw err;
  }
  return data as T;
}

// 兼容既有引用（管理端数据请求）
export const adminFetch = authFetch;

/**
 * 携带 Bearer 令牌下载文件（导出用；<a href> 带不了令牌）。
 * 返回文件名（取自 Content-Disposition，没有就退回 fallback）。
 */
export async function authFetchBlob(path: string, init: RequestInit, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearSession();
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }
  if (!res.ok) {
    let msg = "请求失败";
    try {
      msg = ((await res.json()) as { error?: string })?.error ?? msg;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(msg);
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  let filename = fallbackName;
  try {
    if (star) filename = decodeURIComponent(star[1]);
    else if (plain) filename = plain[1];
  } catch {
    /* 文件名解码失败就用兜底名 */
  }
  return { blob: await res.blob(), filename };
}

/** 把 Blob 存成本地文件 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
