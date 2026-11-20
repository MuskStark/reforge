"use client";

/** 管理端会话存取（sessionStorage：关闭浏览器即登出） */
const TOKEN_KEY = "flow.admin.token";
const USER_KEY = "flow.admin.user";

export interface SessionUser {
  username: string;
  role: "admin" | "member";
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
    throw new Error("UNAUTHORIZED");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? "请求失败");
  }
  return data as T;
}

// 兼容既有引用（管理端数据请求）
export const adminFetch = authFetch;
